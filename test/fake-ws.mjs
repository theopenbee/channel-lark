import { createHash } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const FRAME_CONTROL = 0;
export const FRAME_DATA = 1;

function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7n;
  }
}

const tagged = (no, wire, payload) => Buffer.concat([varint((no << 3) | wire), payload]);
const delimited = (no, buf) => tagged(no, 2, Buffer.concat([varint(buf.length), buf]));

export function encodeFrame({ seqId = 0, logId = 0, service = 7, method, headers = {}, payload }) {
  const parts = [tagged(1, 0, varint(seqId)), tagged(2, 0, varint(logId)), tagged(3, 0, varint(service)), tagged(4, 0, varint(method))];
  for (const [key, value] of Object.entries(headers)) {
    parts.push(delimited(5, Buffer.concat([delimited(1, Buffer.from(key)), delimited(2, Buffer.from(String(value)))])));
  }
  if (payload !== undefined) parts.push(delimited(8, Buffer.from(payload)));
  return Buffer.concat(parts);
}

function decodeFields(buf, onField) {
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const no = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      let value;
      [value, pos] = readVarint(buf, pos);
      onField(no, value);
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      onField(no, buf.subarray(pos, pos + Number(len)));
      pos += Number(len);
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
}

export function decodeFrame(buf) {
  const frame = { headers: {} };
  decodeFields(buf, (no, value) => {
    if (no === 1) frame.seqId = Number(value);
    else if (no === 3) frame.service = Number(value);
    else if (no === 4) frame.method = Number(value);
    else if (no === 8) frame.payload = Buffer.from(value);
    else if (no === 5) {
      const header = {};
      decodeFields(value, (n, v) => (header[n === 1 ? "key" : "value"] = Buffer.from(v).toString("utf8")));
      frame.headers[header.key] = header.value;
    }
  });
  return frame;
}

function wsFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseWsFrame(buf) {
  if (buf.length < 2) return undefined;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return undefined;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return undefined;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const mask = masked ? buf.subarray(offset, offset + 4) : undefined;
  if (masked) offset += 4;
  if (buf.length < offset + len) return undefined;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload, size: offset + len };
}

export function attachFakeWs(fake) {
  const sockets = [];
  const frames = [];
  const waiters = [];
  const state = { accepting: true, connections: 0 };
  let eventSeq = 0;

  fake.handlers.ws_endpoint = () =>
    state.accepting
      ? {
          body: {
            code: 0,
            msg: "ok",
            data: {
              URL: `${fake.url.replace(/^http/, "ws")}/ws?device_id=dev_1&service_id=7`,
              ClientConfig: { PingInterval: 120, ReconnectCount: 2, ReconnectInterval: 1, ReconnectNonce: 0 },
            },
          },
        }
      : { body: { code: 514, msg: "auth failed", data: {} } };

  fake.server.on("upgrade", (req, socket) => {
    if (!req.url.startsWith("/ws")) return socket.destroy();
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + WS_GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.push(socket);
    state.connections++;
    let pending = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
    socket.on("close", () => {
      const i = sockets.indexOf(socket);
      if (i >= 0) sockets.splice(i, 1);
    });
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (let parsed = parseWsFrame(pending); parsed; parsed = parseWsFrame(pending)) {
        pending = pending.subarray(parsed.size);
        if (parsed.opcode === 0x8) {
          socket.end(wsFrame(0x8, parsed.payload));
        } else if (parsed.opcode === 0x9) {
          socket.write(wsFrame(0xa, parsed.payload));
        } else if (parsed.opcode === 0x2) {
          const frame = decodeFrame(parsed.payload);
          frames.push(frame);
          for (const w of [...waiters]) {
            if (w.match(frame)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(frame);
            }
          }
        }
      }
    });
  });

  const close = fake.close.bind(fake);
  fake.close = () => {
    for (const s of sockets.splice(0)) s.destroy();
    return close();
  };

  return {
    state,
    frames,
    pushEvent(event) {
      const messageId = `ws_msg_${++eventSeq}`;
      const frame = encodeFrame({
        seqId: eventSeq,
        method: FRAME_DATA,
        headers: { type: "event", message_id: messageId, sum: "1", seq: "0", trace_id: `trace_${eventSeq}` },
        payload: JSON.stringify(event),
      });
      sockets.at(-1).write(wsFrame(0x2, frame));
      return messageId;
    },
    waitForFrame(match, ms = 5000) {
      const found = frames.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a ws frame")), ms);
        waiters.push({ match, resolve: (f) => (clearTimeout(timer), resolve(f)) });
      });
    },
    dropConnections() {
      for (const s of sockets.splice(0)) s.destroy();
    },
  };
}
