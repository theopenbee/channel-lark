import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { APP_ID, APP_SECRET, PNG, TOKEN, messageEvent, startFakeFeishu } from "./fake-feishu.mjs";
import { FRAME_DATA, attachFakeWs } from "./fake-ws.mjs";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function startPlugin() {
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const garbage = [];
  const waiters = [];
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      garbage.push(line);
      return;
    }
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  let nextId = 1;
  return {
    child,
    exited,
    messages,
    garbage,
    stderr: () => stderr,
    waitFor(match, ms = 8000) {
      const found = messages.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; stderr: ${stderr}`)), ms);
        waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
    request(method, params) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return this.waitFor((m) => m.id === id);
    },
  };
}

function initialize(p, config, mediaDir = mkdtempSync(join(tmpdir(), "feishu-media-"))) {
  return p.request("initialize", {
    protocol_version: 1,
    openbee_version: "test",
    channel_id: "feishu",
    language: "en",
    bot_name: "OpenBee",
    config,
    data_dir: mkdtempSync(join(tmpdir(), "feishu-data-")),
    media_dir: mediaDir,
  });
}

function assertNoLeaks(p) {
  assert.deepEqual(p.garbage, []);
  const all = p.stderr() + JSON.stringify(p.messages);
  assert.doesNotMatch(all, new RegExp(APP_SECRET));
  assert.doesNotMatch(all, new RegExp(TOKEN));
}

async function fakeFeishu(t, handlers) {
  const fake = await startFakeFeishu(handlers);
  t.after(() => fake.close());
  return fake;
}

test("rejected credentials are a config error and the plugin exits", async (t) => {
  const fake = await fakeFeishu(t);
  const p = startPlugin();
  const res = await initialize(p, { app_id: APP_ID, app_secret: "wrong-secret", max_media_size: 0, domain: fake.url });
  assert.equal(res.error.code, -32001);
  assert.match(res.error.message, /app secret invalid/);
  assert.equal(await p.exited, 1);
  assertNoLeaks(p);
});

test("missing credentials are a config error without network calls", async () => {
  const p = startPlugin();
  const res = await initialize(p, { app_id: "", app_secret: "", max_media_size: 0, domain: "" });
  assert.equal(res.error.code, -32001);
  assert.match(res.error.message, /app_id is required/);
  assert.equal(await p.exited, 1);
});

test("an unreachable platform is a transient start failure", async (t) => {
  const fake = await fakeFeishu(t, { token: () => ({ status: 503, body: { code: 1, msg: "busy" } }) });
  const p = startPlugin();
  const res = await initialize(p, { app_id: APP_ID, app_secret: APP_SECRET, domain: fake.url });
  assert.equal(res.error.code, -32603);
  assert.match(res.error.message, /HTTP 503/);
  assert.equal(await p.exited, 1);
});

test("a refused long connection fails start through the real WS client", async (t) => {
  const fake = await fakeFeishu(t);
  const p = startPlugin();
  const res = await initialize(p, { app_id: APP_ID, app_secret: APP_SECRET, domain: fake.url });
  assert.equal(res.error.code, -32603);
  assert.match(res.error.message, /Feishu long connection failed: pullConnectConfig failed: code=514, msg=auth failed/);
  assert.equal(await p.exited, 1);
  const [endpoint] = fake.of("ws_endpoint");
  assert.equal(endpoint.body.AppID, APP_ID);
  assertNoLeaks(p);
});

test("end to end over the long connection: inbound, reaction, reply and shutdown", async (t) => {
  const fake = await fakeFeishu(t);
  const ws = attachFakeWs(fake);
  t.after(() => ws.dropConnections());
  fake.resources.set("img_e2e", PNG);
  const mediaDir = mkdtempSync(join(tmpdir(), "feishu-media-"));
  const p = startPlugin();
  const init = await initialize(p, { app_id: APP_ID, app_secret: APP_SECRET, max_media_size: 1024, domain: fake.url }, mediaDir);
  assert.deepEqual(init.result, { protocol_version: 1 });
  assert.equal(ws.state.connections, 1);

  const wsId = ws.pushEvent(
    messageEvent({ content: { text: "@_user_1 hi" }, mentions: [{ key: "@_user_1", id: { open_id: "ou_bot", union_id: "on_bot" }, name: "OpenBee" }] }),
  );
  const ack = await ws.waitForFrame((f) => f.method === FRAME_DATA && f.headers.message_id === wsId);
  assert.deepEqual(JSON.parse(ack.payload.toString("utf8")), { code: 200 });
  const inbound = await p.waitFor((m) => m.method === "inbound" && m.params.message_id === "om_1");
  assert.equal(inbound.params.text, "@OpenBee hi");
  assert.equal(inbound.params.sender_id, "ou_user");
  assert.equal(inbound.params.chat_id, "oc_group");
  assert.equal(inbound.params.session_scope, undefined);
  assert.equal(inbound.params.context.message.mentions[0].open_id, "ou_bot");
  await fake.waitFor((c) => c.route === "reaction_add");

  const res = await p.request("send", {
    session_key: "feishu:oc_group:ou_user",
    chat_id: "oc_group",
    session_scope: "ou_user",
    proactive: false,
    reply_to: { message_id: "om_1", raw: inbound.params.raw },
    content: "hello back",
  });
  assert.match(res.result.platform_message_id, /^om_sent_/);
  assert.deepEqual(fake.of("reply")[0].params, ["om_1"]);
  await fake.waitFor((c) => c.route === "reaction_delete");

  ws.pushEvent(messageEvent({ messageId: "om_img", type: "image", content: { image_key: "img_e2e" } }));
  const image = await p.waitFor((m) => m.method === "inbound" && m.params.message_id === "om_img");
  const [att] = image.params.attachments;
  assert.equal(att.type, "image");
  assert.equal(dirname(att.path), mediaDir);
  assert.deepEqual(readFileSync(att.path), PNG);

  const file = join(mediaDir, "notes.txt");
  writeFileSync(file, "notes");
  const proactive = await p.request("send", {
    session_key: "feishu:oc_group:ou_user",
    chat_id: "oc_group",
    session_scope: "ou_user",
    proactive: true,
    content: "scheduled",
    media: { path: file, name: "notes.txt" },
  });
  assert.match(proactive.result.platform_message_id, /^om_sent_/);
  assert.deepEqual(
    fake.of("create").map((c) => c.body.msg_type),
    ["post", "file"],
  );

  const failed = await p.request("send", {
    session_key: "feishu:oc_group:ou_user",
    chat_id: "oc_group",
    session_scope: "ou_user",
    proactive: true,
    media: { path: join(mediaDir, "missing.pdf"), name: "missing.pdf" },
  });
  assert.equal(failed.error.code, -32000);
  assert.match(failed.error.message, /read media file/);

  const bye = await p.request("shutdown", {});
  assert.deepEqual(bye.result, {});
  assert.equal(await p.exited, 0);
  assertNoLeaks(p);
});

test("a long connection lost for good makes the plugin exit", async (t) => {
  const fake = await fakeFeishu(t);
  const ws = attachFakeWs(fake);
  t.after(() => ws.dropConnections());
  const p = startPlugin();
  const init = await initialize(p, { app_id: APP_ID, app_secret: APP_SECRET, domain: fake.url });
  assert.deepEqual(init.result, { protocol_version: 1 });
  ws.state.accepting = false;
  ws.dropConnections();
  assert.equal(await p.exited, 1);
  assert.match(p.stderr(), /fatal: Feishu long connection failed: pullConnectConfig failed: code=514/);
  assertNoLeaks(p);
});

test("the plugin exits when stdin closes", async (t) => {
  const fake = await fakeFeishu(t);
  const ws = attachFakeWs(fake);
  t.after(() => ws.dropConnections());
  const p = startPlugin();
  const init = await initialize(p, { app_id: APP_ID, app_secret: APP_SECRET, domain: fake.url });
  assert.deepEqual(init.result, { protocol_version: 1 });
  p.child.stdin.end();
  assert.equal(await p.exited, 0);
});
