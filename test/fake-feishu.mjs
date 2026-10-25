import { createServer } from "node:http";

export const APP_ID = "cli_0123456789abcdef";
export const APP_SECRET = "s3cret-value";
export const TOKEN = "t-test-token";

const ROUTES = [
  ["POST", /^\/open-apis\/auth\/v3\/tenant_access_token\/internal$/, "token"],
  ["POST", /^\/callback\/ws\/endpoint$/, "ws_endpoint"],
  ["POST", /^\/open-apis\/im\/v1\/messages$/, "create"],
  ["POST", /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/, "reply"],
  ["POST", /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reactions$/, "reaction_add"],
  ["DELETE", /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reactions\/([^/]+)$/, "reaction_delete"],
  ["POST", /^\/open-apis\/im\/v1\/images$/, "image_upload"],
  ["POST", /^\/open-apis\/im\/v1\/files$/, "file_upload"],
  ["GET", /^\/open-apis\/im\/v1\/messages\/([^/]+)\/resources\/([^/]+)$/, "resource"],
];

function route(method, path) {
  for (const [m, re, name] of ROUTES) {
    const match = method === m && path.match(re);
    if (match) return { name, params: match.slice(1).map(decodeURIComponent) };
  }
  return { name: "unknown", params: [] };
}

export async function startFakeFeishu(handlers = {}) {
  const calls = [];
  const waiters = [];
  const resources = new Map();
  let seq = 0;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://127.0.0.1");
    const contentType = req.headers["content-type"] ?? "";
    let body;
    if (contentType.includes("json")) body = JSON.parse(raw.toString("utf8") || "{}");
    else body = raw.toString("latin1");
    const { name, params } = route(req.method, url.pathname);
    const call = {
      route: name,
      params,
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      contentType,
      body,
    };
    calls.push(call);
    for (const w of [...waiters]) {
      if (w.match(call)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(call);
      }
    }

    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    };

    if (handlers[name]) {
      const out = await handlers[name](call, res);
      if (out === "handled") return;
      if (out !== undefined) return send(out.status ?? 200, out.body);
    }

    if (name === "token") {
      if (body.app_id !== APP_ID) return send(200, { code: 10014, msg: "app id not exists" });
      if (body.app_secret !== APP_SECRET) return send(400, { code: 10014, msg: "app secret invalid" });
      return send(200, { code: 0, expire: 7200, msg: "ok", tenant_access_token: TOKEN });
    }
    if (name === "ws_endpoint") return send(200, { code: 514, msg: "auth failed", data: {} });
    if (name === "unknown") return send(404, { code: 404, msg: "not found" });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return send(400, { code: 99991663, msg: "Invalid access token for authorization" });
    }
    switch (name) {
      case "create":
      case "reply":
        return send(200, { code: 0, msg: "success", data: { message_id: `om_sent_${++seq}` } });
      case "reaction_add":
        return send(200, { code: 0, msg: "success", data: { reaction_id: `r_${++seq}`, reaction_type: body.reaction_type } });
      case "reaction_delete":
        return send(200, { code: 0, msg: "success", data: { reaction_id: params[1] } });
      case "image_upload":
        return send(200, { code: 0, msg: "success", data: { image_key: `img_up_${++seq}` } });
      case "file_upload":
        return send(200, { code: 0, msg: "success", data: { file_key: `file_up_${++seq}` } });
      case "resource": {
        const data = resources.get(params[1]);
        if (!data) return send(400, { code: 234003, msg: "File not in msg." });
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(data);
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    server,
    handlers,
    calls,
    resources,
    of(name) {
      return calls.filter((c) => c.route === name);
    },
    waitFor(match, ms = 5000) {
      const found = calls.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a feishu call")), ms);
        waiters.push({ match, resolve: (c) => (clearTimeout(timer), resolve(c)) });
      });
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

export function messageEvent({
  messageId = "om_1",
  chatId = "oc_group",
  chatType = "group",
  type = "text",
  content = { text: "hello" },
  mentions,
  sender = { open_id: "ou_user", union_id: "on_user", user_id: "u_user" },
  createTime = "1700000000123",
} = {}) {
  const message = {
    message_id: messageId,
    root_id: "",
    parent_id: "",
    create_time: createTime,
    update_time: createTime,
    chat_id: chatId,
    chat_type: chatType,
    message_type: type,
    content: typeof content === "string" ? content : JSON.stringify(content),
  };
  if (mentions) message.mentions = mentions;
  return {
    schema: "2.0",
    header: {
      event_id: `evt_${messageId}`,
      token: "",
      create_time: createTime,
      event_type: "im.message.receive_v1",
      tenant_key: "tk_1",
      app_id: APP_ID,
    },
    event: {
      sender: { sender_id: sender, sender_type: "user", tenant_key: "tk_1" },
      message,
    },
  };
}

export const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
export const OGG = Buffer.concat([Buffer.from("OggS\x00\x02", "latin1"), Buffer.alloc(32)]);
export const PDF = Buffer.from("%PDF-1.4\n%fake\n", "latin1");
export const MP4 = Buffer.concat([Buffer.from("00000018667479706d703432", "hex"), Buffer.from("00000000mp42isom", "latin1")]);
