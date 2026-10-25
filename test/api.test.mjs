import { test } from "node:test";
import assert from "node:assert/strict";

import { CredentialsRejectedError, FeishuApi, FeishuError, httpWithTimeout, resolveDomain, sdkDomain, verifyCredentials } from "../dist/api.js";
import { describeLogArgs, larkLogger } from "../dist/logger.js";
import { APP_ID, APP_SECRET, PNG, TOKEN, startFakeFeishu } from "./fake-feishu.mjs";

const silent = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

async function fakeFeishu(t, handlers) {
  const fake = await startFakeFeishu(handlers);
  t.after(() => fake.close());
  return fake;
}

function api(fake, http = httpWithTimeout(5000)) {
  return new FeishuApi({ appId: APP_ID, appSecret: APP_SECRET, baseUrl: fake.url, logger: silent, http });
}

test("resolveDomain accepts the two clouds and base URLs", () => {
  assert.equal(resolveDomain(""), "https://open.feishu.cn");
  assert.equal(resolveDomain("feishu"), "https://open.feishu.cn");
  assert.equal(resolveDomain(" Lark "), "https://open.larksuite.com");
  assert.equal(resolveDomain("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(resolveDomain("open.feishu.cn"), undefined);
  assert.equal(resolveDomain("ws://x"), undefined);
  assert.equal(sdkDomain("https://open.feishu.cn"), 0);
  assert.equal(sdkDomain("https://open.larksuite.com"), 1);
  assert.equal(sdkDomain("http://127.0.0.1:1"), "http://127.0.0.1:1");
});

test("verifyCredentials distinguishes rejected credentials from outages", async (t) => {
  const fake = await fakeFeishu(t);
  const http = httpWithTimeout(5000);
  await verifyCredentials(http, fake.url, APP_ID, APP_SECRET);

  const badSecret = await verifyCredentials(http, fake.url, APP_ID, "nope").catch((e) => e);
  assert.ok(badSecret instanceof CredentialsRejectedError);
  assert.equal(badSecret.message, "Feishu rejected the app credentials: app secret invalid (code 10014)");

  const badApp = await verifyCredentials(http, fake.url, "cli_ffffffffffffffff", APP_SECRET).catch((e) => e);
  assert.ok(badApp instanceof CredentialsRejectedError);
  assert.match(badApp.message, /app id not exists/);

  const down = await fakeFeishu(t, { token: () => ({ status: 502, body: "bad gateway" }) });
  const outage = await verifyCredentials(http, down.url, APP_ID, APP_SECRET).catch((e) => e);
  assert.ok(!(outage instanceof CredentialsRejectedError));
  assert.match(outage.message, /verify credentials failed: HTTP 502/);

  const empty = await fakeFeishu(t, { token: () => ({ status: 200, body: { code: 0, msg: "ok" } }) });
  await assert.rejects(verifyCredentials(http, empty.url, APP_ID, APP_SECRET), /no tenant_access_token/);

  const refused = await verifyCredentials(http, "http://127.0.0.1:1", APP_ID, APP_SECRET).catch((e) => e);
  assert.ok(!(refused instanceof CredentialsRejectedError));
  assert.match(refused.message, /verify credentials failed: .*ECONNREFUSED/);
});

test("requests time out", async (t) => {
  const fake = await fakeFeishu(t, { token: () => new Promise(() => {}) });
  await assert.rejects(verifyCredentials(httpWithTimeout(50), fake.url, APP_ID, APP_SECRET), /timeout of 50ms exceeded/);
});

test("API calls authenticate and return message ids", async (t) => {
  const fake = await fakeFeishu(t);
  const client = api(fake);
  assert.match(await client.createMessage("oc_1", "text", '{"text":"x"}'), /^om_sent_/);
  assert.match(await client.replyMessage("om_1", "text", '{"text":"x"}'), /^om_sent_/);
  assert.match(await client.addReaction("om_1", "Typing"), /^r_/);
  await client.deleteReaction("om_1", "r_9");
  assert.match(await client.uploadImage(PNG), /^img_up_/);
  assert.match(await client.uploadFile(Buffer.from("x"), "stream", "a.txt"), /^file_up_/);
  for (const call of fake.calls.filter((c) => c.route !== "token")) assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(fake.of("token").length, 1);
  assert.deepEqual(fake.of("reaction_delete")[0].params, ["om_1", "r_9"]);
});

test("API errors carry the Feishu code and message", async (t) => {
  const fake = await fakeFeishu(t, {
    create: () => ({ status: 400, body: { code: 230002, msg: "bot not in chat" } }),
    reply: () => ({ status: 200, body: { code: 230011, msg: "withdrawn" } }),
    reaction_add: () => ({ status: 500, body: "oops" }),
    image_upload: () => ({ status: 200, body: { code: 0, msg: "ok", data: {} } }),
    file_upload: () => ({ status: 200, body: { code: 234006, msg: "file too big" } }),
  });
  const client = api(fake);
  const create = await client.createMessage("oc", "text", "{}").catch((e) => e);
  assert.ok(create instanceof FeishuError);
  assert.deepEqual([create.code, create.msg, create.message], [230002, "bot not in chat", "create message failed: code=230002 msg=bot not in chat"]);
  const reply = await client.replyMessage("om", "text", "{}").catch((e) => e);
  assert.equal(reply.code, 230011);
  await assert.rejects(client.addReaction("om", "Typing"), /add reaction failed: HTTP 500/);
  await assert.rejects(client.uploadImage(PNG), /upload image failed: no image_key/);
  await assert.rejects(client.uploadFile(Buffer.from("x"), "stream", "a"), /upload file failed: no file_key/);
});

test("downloads enforce the size limit and report resource errors", async (t) => {
  const fake = await fakeFeishu(t, {
    resource: (call, res) => {
      if (call.params[1] === "json_err") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 234037, msg: "file size exceeds limit" }));
        return "handled";
      }
      return undefined;
    },
  });
  fake.resources.set("small", Buffer.alloc(100, 1));
  fake.resources.set("large", Buffer.alloc(5000, 1));
  const client = api(fake);
  const data = await client.downloadResource("om_1", "small", "file", 100);
  assert.equal(data.length, 100);
  await assert.rejects(client.downloadResource("om_1", "large", "file", 4999), /resource too large: exceeds 4999 bytes/);
  const missing = await client.downloadResource("om_1", "nothing", "image", 100).catch((e) => e);
  assert.equal(missing.message, "download resource failed: code=234003 msg=File not in msg.");
  await assert.rejects(client.downloadResource("om_1", "json_err", "file", 100), /code=234037/);
  assert.deepEqual(fake.of("resource")[0].query, { type: "file" });
});

test("SDK log arguments are reduced to safe summaries", () => {
  const axiosLike = Object.assign(new Error("Request failed with status code 400"), {
    config: { url: "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal?x=1", method: "post", data: JSON.stringify({ app_secret: "TOPSECRET" }), headers: { Authorization: "Bearer t-1" } },
    response: { status: 400, data: { code: 10014, msg: "app secret invalid" } },
  });
  const line = describeLogArgs([axiosLike]);
  assert.equal(line, "Request failed with status code 400 POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal status=400 code=10014 msg=app secret invalid");
  const formatted = describeLogArgs([[{ message: "boom", config: { url: "/x", method: "get", data: { app_secret: "TOPSECRET" } }, response: { status: 500, data: "raw" } }, { code: 1, msg: "busy" }]]);
  assert.equal(formatted, "boom GET /x status=500 code=1 msg=busy");
  assert.equal(describeLogArgs(["[ws]", "code: 514, auth failed"]), "[ws] code: 514, auth failed");
  assert.equal(describeLogArgs([{ app_secret: "TOPSECRET" }]), "");

  const lines = [];
  const logger = larkLogger({ debug: (m, f) => lines.push(["debug", m, f]), info: (m, f) => lines.push(["info", m, f]), warn() {}, error() {} });
  logger.info(["multi\n   line"]);
  logger.trace(["trace"]);
  logger.debug([""]);
  assert.deepEqual(lines, [
    ["info", "multi line", { source: "lark-sdk" }],
    ["debug", "trace", { source: "lark-sdk" }],
  ]);
});
