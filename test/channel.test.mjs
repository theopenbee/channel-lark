import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createFeishuChannel } from "../dist/feishu.js";
import { buildPostContent } from "../dist/post.js";
import { APP_ID, APP_SECRET, MP4, OGG, PDF, PNG, TOKEN, messageEvent, startFakeFeishu } from "./fake-feishu.mjs";
import { FAST_TIMING, fakeConnector, fakeContext, sendRequest, startChannel, waitUntil } from "./harness.mjs";

async function fakeFeishu(t, handlers) {
  const fake = await startFakeFeishu(handlers);
  t.after(() => fake.close());
  return fake;
}

const groupRaw = JSON.stringify({ event: { message: { message_id: "om_1", chat_id: "oc_group", chat_type: "group" } } });

test("start verifies the credentials and opens the long connection", async (t) => {
  const fake = await fakeFeishu(t);
  const { connector, handle, logs } = await startChannel(t, fake);
  const [token] = fake.of("token");
  assert.deepEqual(token.body, { app_id: APP_ID, app_secret: APP_SECRET });
  assert.equal(connector.state.params.appId, APP_ID);
  assert.equal(connector.state.params.appSecret, APP_SECRET);
  assert.equal(connector.state.params.domain, fake.url);
  assert.ok(logs.some((l) => l.message === "feishu bot connected"));
  for (const l of logs) assert.doesNotMatch(JSON.stringify(l), new RegExp(APP_SECRET));
  await handle.stop();
  assert.equal(connector.state.closed, 1);
});

test("rejected credentials are config errors", async (t) => {
  const fake = await fakeFeishu(t);
  for (const [config, pattern] of [
    [{ app_secret: "wrong" }, /app secret invalid \(code 10014\)/],
    [{ app_id: "cli_ffffffffffffffff" }, /app id not exists \(code 10014\)/],
  ]) {
    const channel = createFeishuChannel({ connect: fakeConnector().connect, timing: FAST_TIMING });
    const { ctx } = fakeContext({ config: { app_id: APP_ID, app_secret: APP_SECRET, domain: fake.url, ...config } });
    const err = await channel.start(ctx).catch((e) => e);
    assert.equal(err.name, "ConfigError");
    assert.match(err.message, pattern);
  }
});

test("missing or malformed settings are config errors", async () => {
  const cases = [
    [{ app_secret: "x" }, /app_id is required/],
    [{ app_id: APP_ID, app_secret: "" }, /app_secret is required/],
    [{ app_id: "app", app_secret: "x" }, /app_id must be cli_/],
    [{ app_id: APP_ID, app_secret: "x", domain: "ftp://example.com" }, /domain must be/],
  ];
  for (const [config, pattern] of cases) {
    const channel = createFeishuChannel({ connect: fakeConnector().connect });
    const { ctx } = fakeContext({ config });
    const err = await channel.start(ctx).catch((e) => e);
    assert.equal(err.name, "ConfigError");
    assert.match(err.message, pattern);
  }
});

test("server errors while verifying are transient failures", async (t) => {
  const fake = await fakeFeishu(t, { token: () => ({ status: 503, body: { code: 1, msg: "busy" } }) });
  const channel = createFeishuChannel({ connect: fakeConnector().connect, timing: FAST_TIMING });
  const { ctx } = fakeContext({ config: { app_id: APP_ID, app_secret: APP_SECRET, domain: fake.url } });
  const err = await channel.start(ctx).catch((e) => e);
  assert.notEqual(err.name, "ConfigError");
  assert.match(err.message, /verify credentials failed: HTTP 503/);
});

test("a connection that fails or never becomes ready rejects start", async (t) => {
  const fake = await fakeFeishu(t);
  const failing = fakeConnector({ fail: "pullConnectConfig failed: code=514, msg=auth failed" });
  const err = await startChannel(t, fake, { connector: failing }).catch((e) => e);
  assert.notEqual(err.name, "ConfigError");
  assert.match(err.message, /long connection failed: pullConnectConfig failed/);
  assert.equal(failing.state.closed, 1);

  const silent = fakeConnector({ fail: null });
  const timeout = await startChannel(t, fake, { connector: silent, timing: { connectTimeout: 50 } }).catch((e) => e);
  assert.match(timeout.message, /timed out connecting/);
  assert.equal(silent.state.closed, 1);
});

test("a connection lost for good after start is fatal", async (t) => {
  const fake = await fakeFeishu(t);
  const reasons = [];
  await startChannel(t, fake, { connector: fakeConnector({ failAfterReady: "WebSocket reconnect exhausted after 3 attempts" }), onFatal: (r) => reasons.push(r) });
  await waitUntil(() => reasons.length > 0, 1000, "fatal");
  assert.deepEqual(reasons, ["Feishu long connection failed: WebSocket reconnect exhausted after 3 attempts"]);
});

test("text messages are dispatched with raw, context and a typing reaction", async (t) => {
  const fake = await fakeFeishu(t);
  const { connector, dispatched } = await startChannel(t, fake);
  const result = await connector.deliver(
    messageEvent({
      content: { text: "@_user_1 @_user_2 hello" },
      mentions: [
        { key: "@_user_1", id: { open_id: "ou_bot", union_id: "on_bot", user_id: "" }, name: "OpenBee", tenant_key: "tk_1" },
        { key: "@_user_2", id: { open_id: "ou_tom", union_id: "on_tom" }, name: "Tom", tenant_key: "tk_1" },
        { id: { open_id: "ou_nokey" }, name: "NoKey" },
      ],
    }),
  );
  assert.equal(result, undefined);
  await waitUntil(() => dispatched.length === 1, 3000, "dispatch");
  assert.deepEqual(dispatched[0], {
    chat_id: "oc_group",
    sender_id: "ou_user",
    message_id: "om_1",
    text: "@OpenBee @_user_2 hello",
    attachments: [],
    raw: groupRaw,
    context: {
      sender: { open_id: "ou_user", union_id: "on_user", sender_type: "user" },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_1",
        message_type: "text",
        mentions: [
          { key: "@_user_1", open_id: "ou_bot", union_id: "on_bot", name: "OpenBee" },
          { key: "@_user_2", open_id: "ou_tom", union_id: "on_tom", name: "Tom" },
        ],
      },
    },
    time: 1700000000123,
  });
  const reaction = await fake.waitFor((c) => c.route === "reaction_add");
  assert.deepEqual(reaction.params, ["om_1"]);
  assert.deepEqual(reaction.body, { reaction_type: { emoji_type: "Typing" } });
  assert.equal(reaction.headers.authorization, `Bearer ${TOKEN}`);
});

test("mentions are null in the context when there are none", async (t) => {
  const fake = await fakeFeishu(t);
  const { connector, dispatched } = await startChannel(t, fake, { botName: "" });
  await connector.deliver(messageEvent({ content: { text: "@_user_1 hi" }, mentions: [{ key: "@_user_1", name: "OpenBee", id: {} }] }));
  await waitUntil(() => dispatched.length === 1);
  assert.equal(dispatched[0].text, "@_user_1 hi");
  await connector.deliver(messageEvent({ messageId: "om_2", content: { text: "plain" } }));
  await waitUntil(() => dispatched.length === 2);
  assert.equal(dispatched[1].context.message.mentions, null);
});

test("the event handler returns before slow downloads finish", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const fake = await fakeFeishu(t, {
    resource: async () => {
      await gate;
      return undefined;
    },
  });
  fake.resources.set("img_slow", PNG);
  const { connector, dispatched } = await startChannel(t, fake);
  await connector.deliver(messageEvent({ type: "image", content: { image_key: "img_slow" } }));
  await fake.waitFor((c) => c.route === "resource");
  assert.equal(dispatched.length, 0);
  release();
  await waitUntil(() => dispatched.length === 1);
  assert.equal(dispatched[0].attachments[0].type, "image");
});

test("media messages download attachments or keep a placeholder", async (t) => {
  const fake = await fakeFeishu(t);
  fake.resources.set("img_ok", PNG);
  fake.resources.set("file_ok", PDF);
  fake.resources.set("file_audio", OGG);
  fake.resources.set("file_video", MP4);
  fake.resources.set("file_big", Buffer.alloc(2048));
  const { connector, dispatched, mediaDir, logs } = await startChannel(t, fake, { config: { max_media_size: 1024 } });
  const cases = [
    ["om_img", "image", { image_key: "img_ok" }],
    ["om_file", "file", { file_key: "file_ok", file_name: "report.pdf" }],
    ["om_audio", "audio", { file_key: "file_audio", duration: 2000 }],
    ["om_video", "media", { file_key: "file_video", file_name: "clip.mp4", image_key: "img_cover" }],
    ["om_sticker", "sticker", { file_key: "sticker_ok" }],
    ["om_big", "file", { file_key: "file_big", file_name: "big.zip" }],
    ["om_missing", "video", { file_key: "file_gone", file_name: "gone.mov" }],
    ["om_badkey", "file", { file_key: "../etc/passwd", file_name: "x.txt" }],
  ];
  for (const [messageId, type, content] of cases) await connector.deliver(messageEvent({ messageId, type, content }));
  await waitUntil(() => dispatched.length === cases.length, 3000, "all media dispatches");
  const byId = Object.fromEntries(dispatched.map((m) => [m.message_id, m]));
  for (const m of dispatched) assert.equal(m.text, "");

  const [img] = byId.om_img.attachments;
  assert.equal(img.type, "image");
  assert.equal(img.name, undefined);
  assert.equal(dirname(img.path), mediaDir);
  assert.match(img.path, /\.png$/);
  assert.deepEqual(readFileSync(img.path), PNG);

  const [file] = byId.om_file.attachments;
  assert.equal(file.type, "document");
  assert.equal(file.name, "report.pdf");
  assert.match(file.path, /\.pdf$/);

  const [audio] = byId.om_audio.attachments;
  assert.equal(audio.type, "audio");
  assert.match(audio.path, /\.ogg$/);

  const [video] = byId.om_video.attachments;
  assert.deepEqual({ type: video.type, name: video.name }, { type: "video", name: "clip.mp4" });
  assert.match(video.path, /\.mp4$/);

  assert.deepEqual(byId.om_sticker.attachments, [{ type: "sticker", path: "" }]);
  assert.deepEqual(byId.om_big.attachments, [{ type: "document", path: "", name: "big.zip" }]);
  assert.deepEqual(byId.om_missing.attachments, [{ type: "video", path: "", name: "gone.mov" }]);
  assert.deepEqual(byId.om_badkey.attachments, [{ type: "document", path: "", name: "x.txt" }]);

  const resourceCalls = fake.of("resource");
  const imageCall = resourceCalls.find((c) => c.params[1] === "img_ok");
  assert.deepEqual(imageCall.params, ["om_img", "img_ok"]);
  assert.equal(imageCall.query.type, "image");
  assert.equal(resourceCalls.find((c) => c.params[1] === "file_ok").query.type, "file");
  assert.equal(resourceCalls.find((c) => c.params[1] === "sticker_ok"), undefined);
  assert.equal(resourceCalls.some((c) => c.path.includes("passwd")), false);
  assert.ok(logs.some((l) => l.level === "error" && l.message === "download media failed" && /too large/.test(l.fields.error)));
  assert.ok(logs.some((l) => l.message === "download media failed" && /code=234003/.test(l.fields.error)));
});

test("sticker messages use the image resource type", async (t) => {
  const fake = await fakeFeishu(t);
  fake.resources.set("img_sticker", PNG);
  const { connector, dispatched } = await startChannel(t, fake);
  await connector.deliver(messageEvent({ type: "sticker", content: { image_key: "img_sticker" } }));
  await waitUntil(() => dispatched.length === 1);
  const [att] = dispatched[0].attachments;
  assert.equal(att.type, "sticker");
  assert.match(att.path, /\.png$/);
  assert.equal(fake.of("resource")[0].query.type, "image");
});

test("media messages without a key keep a placeholder", async (t) => {
  const fake = await fakeFeishu(t);
  const { connector, dispatched } = await startChannel(t, fake);
  await connector.deliver(messageEvent({ type: "file", content: { file_name: "a.pdf" } }));
  await waitUntil(() => dispatched.length === 1);
  assert.deepEqual(dispatched[0].attachments, [{ type: "document", path: "", name: "a.pdf" }]);
  assert.equal(fake.of("resource").length, 0);
});

test("post messages keep text and download embedded media in order", async (t) => {
  const fake = await fakeFeishu(t);
  fake.resources.set("img_a", PNG);
  fake.resources.set("file_v", MP4);
  const { connector, dispatched } = await startChannel(t, fake);
  const content = {
    zh_cn: {
      title: "Weekly",
      content: [
        [
          { tag: "at", user_id: "@_user_1", user_name: "OpenBee" },
          { tag: "text", text: " see " },
          { tag: "text", text: "this", style: ["bold"] },
        ],
        [{ tag: "img", image_key: "img_a" }, { tag: "img", image_key: "img_missing" }],
        [{ tag: "media", file_key: "file_v", file_name: "demo.mp4", image_key: "img_cover" }],
        [{ tag: "media", file_key: "file_gone", file_name: "notes.pdf" }],
      ],
    },
  };
  await connector.deliver(messageEvent({ type: "post", content }));
  await waitUntil(() => dispatched.length === 1);
  const m = dispatched[0];
  assert.equal(m.text, "Weekly\n@OpenBee see **this**");
  assert.equal(m.attachments.length, 4);
  assert.equal(m.attachments[0].type, "image");
  assert.match(m.attachments[0].path, /\.png$/);
  assert.deepEqual(m.attachments[1], { type: "image", path: "" });
  assert.equal(m.attachments[2].type, "video");
  assert.equal(m.attachments[2].name, "demo.mp4");
  assert.match(m.attachments[2].path, /\.mp4$/);
  assert.deepEqual(m.attachments[3], { type: "document", path: "", name: "notes.pdf" });
  assert.equal(m.context.message.message_type, "post");
  const types = Object.fromEntries(fake.of("resource").map((c) => [c.params[1], c.query.type]));
  assert.deepEqual(types, { img_a: "image", img_missing: "image", file_v: "file", file_gone: "file" });
});

test("empty or unparsable posts fall back to a localized placeholder", async (t) => {
  const fake = await fakeFeishu(t);
  const en = await startChannel(t, fake);
  await en.connector.deliver(messageEvent({ type: "post", content: { title: "", content: [[{ tag: "unknown" }]] } }));
  await en.connector.deliver(messageEvent({ messageId: "om_2", type: "post", content: "{not json" }));
  await waitUntil(() => en.dispatched.length === 2);
  assert.deepEqual(
    en.dispatched.map((m) => [m.text, m.attachments]),
    [
      ["[Rich text message]", []],
      ["[Rich text message]", []],
    ],
  );
  const zh = await startChannel(t, fake, { language: "zh" });
  await zh.connector.deliver(messageEvent({ type: "post", content: { post: { zh_cn: { title: "", content: [] } } } }));
  await waitUntil(() => zh.dispatched.length === 1);
  assert.equal(zh.dispatched[0].text, "[富文本消息]");
});

test("unsupported, empty and anonymous messages are skipped", async (t) => {
  const fake = await fakeFeishu(t);
  const { connector, dispatched, logs } = await startChannel(t, fake);
  await connector.deliver(messageEvent({ messageId: "om_card", type: "interactive", content: { title: "card" } }));
  await connector.deliver(messageEvent({ messageId: "om_empty", content: { text: "" } }));
  await connector.deliver(messageEvent({ messageId: "om_bad", content: "not json" }));
  await connector.deliver(messageEvent({ messageId: "om_anon", sender: { union_id: "on_x" } }));
  await connector.deliver(messageEvent({ messageId: "om_nochat", chatId: "" }));
  await connector.deliver(messageEvent({ messageId: "om_ok", content: { text: "ok" } }));
  await waitUntil(() => dispatched.length === 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    dispatched.map((m) => m.message_id),
    ["om_ok"],
  );
  assert.ok(logs.some((l) => l.level === "warn" && l.message === "skipping unsupported message type" && l.fields.message_type === "interactive"));
  assert.ok(logs.some((l) => l.message === "skipping message without sender open_id"));
  assert.ok(logs.some((l) => l.message === "skipping message without chat_id"));
  assert.deepEqual(
    fake.of("reaction_add").map((c) => c.params[0]),
    ["om_ok"],
  );
});

test("adding the typing reaction is retried with backoff", async (t) => {
  let attempts = 0;
  const fake = await fakeFeishu(t, {
    reaction_add: () => (++attempts < 3 ? { status: 500, body: { code: 1, msg: "busy" } } : undefined),
  });
  const { connector } = await startChannel(t, fake);
  await connector.deliver(messageEvent());
  await waitUntil(() => fake.of("reaction_add").length === 3);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.of("reaction_add").length, 3);
});

test("a group reply quotes the message and recalls the typing reaction", async (t) => {
  const fake = await fakeFeishu(t);
  const { connector, channel, ctx, dispatched } = await startChannel(t, fake);
  await connector.deliver(messageEvent());
  await waitUntil(() => dispatched.length === 1);
  await fake.waitFor((c) => c.route === "reaction_add");
  const res = await channel.send(
    sendRequest({ reply_to: { message_id: "om_1", raw: dispatched[0].raw }, content: "## Done\n- item" }),
    ctx,
    new AbortController().signal,
  );
  const [reply] = fake.of("reply");
  assert.deepEqual(reply.params, ["om_1"]);
  assert.equal(reply.body.msg_type, "post");
  assert.equal(reply.body.content, buildPostContent("## Done\n- item"));
  assert.deepEqual(JSON.parse(reply.body.content), {
    zh_cn: { title: "", content: [[{ tag: "md", text: "## Done" }], [{ tag: "md", text: "- item" }]] },
  });
  assert.match(res.platform_message_id, /^om_sent_/);
  const recall = await fake.waitFor((c) => c.route === "reaction_delete");
  assert.equal(recall.params[0], "om_1");
  assert.match(recall.params[1], /^r_/);
  assert.equal(fake.of("create").length, 0);

  await channel.send(sendRequest({ reply_to: { message_id: "om_1", raw: dispatched[0].raw }, content: "again" }), ctx, new AbortController().signal);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.of("reaction_delete").length, 1);
});

test("the reaction recall waits for a slow reaction and then gives up", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const fake = await fakeFeishu(t, {
    reaction_add: async () => {
      await gate;
      return undefined;
    },
  });
  const { connector, channel, ctx, dispatched, logs } = await startChannel(t, fake, { timing: { recallWait: 30 } });
  await connector.deliver(messageEvent());
  await waitUntil(() => dispatched.length === 1);
  await channel.send(sendRequest({ reply_to: { raw: dispatched[0].raw }, content: "hi" }), ctx, new AbortController().signal);
  await waitUntil(() => logs.some((l) => l.message === "timed out waiting for reaction ID"), 2000, "recall timeout log");
  release();
  await fake.waitFor((c) => c.route === "reaction_add");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.of("reaction_delete").length, 0);
});

test("p2p replies and replies without a message id create a message", async (t) => {
  const fake = await fakeFeishu(t);
  const { channel, ctx } = await startChannel(t, fake);
  const p2pRaw = JSON.stringify({ event: { message: { message_id: "om_p", chat_id: "oc_p2p", chat_type: "p2p" } } });
  await channel.send(sendRequest({ chat_id: "oc_p2p", reply_to: { message_id: "om_p", raw: p2pRaw }, content: "hi" }), ctx, new AbortController().signal);
  await channel.send(sendRequest({ chat_id: "oc_other", reply_to: { raw: "garbage" }, content: "hello" }), ctx, new AbortController().signal);
  const creates = fake.of("create");
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0].query, { receive_id_type: "chat_id" });
  assert.equal(creates[0].body.receive_id, "oc_p2p");
  assert.equal(creates[0].body.msg_type, "post");
  assert.equal(creates[1].body.receive_id, "oc_other");
  assert.equal(fake.of("reply").length, 0);
});

test("legacy raw from the built-in channel is replied to", async (t) => {
  const fake = await fakeFeishu(t);
  const { channel, ctx } = await startChannel(t, fake);
  const legacy = JSON.stringify({
    schema: "2.0",
    header: { event_id: "e1", token: "", create_time: "1", event_type: "im.message.receive_v1", tenant_key: "tk", app_id: APP_ID },
    event: {
      sender: { sender_id: { open_id: "ou_user", union_id: "on_user", user_id: "u1" }, sender_type: "user", tenant_key: "tk" },
      message: {
        message_id: "om_legacy",
        root_id: "",
        parent_id: "",
        create_time: "1700000000000",
        chat_id: "oc_group",
        chat_type: "group",
        message_type: "text",
        content: '{"text":"hi"}',
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot", union_id: "on_bot", user_id: "" }, name: "OpenBee", tenant_key: "tk" }],
      },
    },
  });
  await channel.send(sendRequest({ reply_to: { raw: legacy }, content: "done" }), ctx, new AbortController().signal);
  const [reply] = fake.of("reply");
  assert.deepEqual(reply.params, ["om_legacy"]);
});

test("replies fall back to a new message when the original is gone", async (t) => {
  for (const code of [230011, 231003]) {
    const fake = await fakeFeishu(t, { reply: () => ({ status: 400, body: { code, msg: "The message was withdrawn." } }) });
    const { channel, ctx, logs } = await startChannel(t, fake);
    const res = await channel.send(sendRequest({ reply_to: { raw: groupRaw }, content: "hi" }), ctx, new AbortController().signal);
    assert.match(res.platform_message_id, /^om_sent_/);
    const [create] = fake.of("create");
    assert.equal(create.body.receive_id, "oc_group");
    assert.ok(logs.some((l) => l.level === "warn" && l.message === "reply failed, falling back to direct send" && l.fields.code === code));
  }
});

test("other reply errors fail the send with code and message", async (t) => {
  const fake = await fakeFeishu(t, { reply: () => ({ status: 400, body: { code: 230002, msg: "Bot/User can NOT be out of the chat." } }) });
  const { channel, ctx } = await startChannel(t, fake);
  await assert.rejects(
    channel.send(sendRequest({ reply_to: { raw: groupRaw }, content: "hi" }), ctx, new AbortController().signal),
    /reply message failed: code=230002 msg=Bot\/User can NOT be out of the chat\./,
  );
  assert.equal(fake.of("create").length, 0);

  const ok200 = await fakeFeishu(t, { create: () => ({ status: 200, body: { code: 230001, msg: "invalid receive_id" } }) });
  const second = await startChannel(t, ok200);
  await assert.rejects(
    second.channel.send(sendRequest({ proactive: true, content: "hi" }), second.ctx, new AbortController().signal),
    /create message failed: code=230001 msg=invalid receive_id/,
  );
});

test("text and a file are sent as two replies, text first", async (t) => {
  const fake = await fakeFeishu(t);
  const { channel, ctx, mediaDir } = await startChannel(t, fake);
  const file = join(mediaDir, "1700-abc.pdf");
  writeFileSync(file, PDF);
  const res = await channel.send(
    sendRequest({ reply_to: { raw: groupRaw }, content: "report attached", media: { path: file, name: 'Q3 "final"/report.pdf' } }),
    ctx,
    new AbortController().signal,
  );
  const order = fake.calls.filter((c) => c.route !== "token").map((c) => c.route);
  assert.deepEqual(order, ["reply", "file_upload", "reply"]);
  const [upload] = fake.of("file_upload");
  assert.match(upload.contentType, /multipart\/form-data/);
  assert.match(upload.body, /name="file_type"\r\n\r\npdf\r\n/);
  assert.match(upload.body, /name="file_name"\r\n\r\nQ3 _final_report\.pdf\r\n/);
  assert.match(upload.body, /%PDF-1\.4/);
  const replies = fake.of("reply");
  assert.equal(replies[1].body.msg_type, "file");
  assert.deepEqual(JSON.parse(replies[1].body.content), { file_key: "file_up_2" });
  assert.equal(res.platform_message_id, "om_sent_3");
});

test("images, videos and voice notes use their message types", async (t) => {
  const fake = await fakeFeishu(t);
  const { channel, ctx, mediaDir } = await startChannel(t, fake);
  const png = join(mediaDir, "chart.PNG");
  const mp4 = join(mediaDir, "clip.mov");
  const opus = join(mediaDir, "voice.ogg");
  const other = join(mediaDir, "data.csv");
  writeFileSync(png, PNG);
  writeFileSync(mp4, MP4);
  writeFileSync(opus, OGG);
  writeFileSync(other, "a,b\n");
  const signal = new AbortController().signal;
  await channel.send(sendRequest({ proactive: true, media: { path: png, name: "chart.PNG" } }), ctx, signal);
  await channel.send(sendRequest({ proactive: true, media: { path: mp4, name: "clip.mov" } }), ctx, signal);
  await channel.send(sendRequest({ proactive: true, media: { path: opus, name: "voice.ogg" } }), ctx, signal);
  await channel.send(sendRequest({ proactive: true, media: { path: other, name: "data.csv" } }), ctx, signal);

  const [image] = fake.of("image_upload");
  assert.match(image.body, /name="image_type"\r\n\r\nmessage\r\n/);
  const uploads = fake.of("file_upload");
  assert.match(uploads[0].body, /name="file_type"\r\n\r\nmp4\r\n/);
  assert.match(uploads[1].body, /name="file_type"\r\n\r\nopus\r\n/);
  assert.match(uploads[2].body, /name="file_type"\r\n\r\nstream\r\n/);
  const sent = fake.of("create").map((c) => [c.body.msg_type, JSON.parse(c.body.content)]);
  assert.deepEqual(sent, [
    ["image", { image_key: "img_up_1" }],
    ["media", { file_key: "file_up_3", file_name: "clip.mov" }],
    ["audio", { file_key: "file_up_5" }],
    ["file", { file_key: "file_up_7" }],
  ]);
});

test("proactive sends post to the chat and leave reactions alone", async (t) => {
  const fake = await fakeFeishu(t);
  const { connector, channel, ctx, dispatched } = await startChannel(t, fake);
  await connector.deliver(messageEvent());
  await waitUntil(() => dispatched.length === 1);
  await fake.waitFor((c) => c.route === "reaction_add");
  const stale = JSON.stringify({ event: { message: { chat_id: "oc_old", chat_type: "group", message_id: "om_1" } } });
  const res = await channel.send(
    sendRequest({ chat_id: "oc_group", proactive: true, reply_to: { raw: stale }, content: "daily report" }),
    ctx,
    new AbortController().signal,
  );
  assert.match(res.platform_message_id, /^om_sent_/);
  const [create] = fake.of("create");
  assert.equal(create.body.receive_id, "oc_group");
  assert.equal(create.body.msg_type, "post");
  assert.equal(fake.of("reply").length, 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.of("reaction_delete").length, 0);

  await channel.send(sendRequest({ reply_to: { raw: dispatched[0].raw }, content: "now a reply" }), ctx, new AbortController().signal);
  await fake.waitFor((c) => c.route === "reaction_delete");
});

test("media errors fail the send", async (t) => {
  const fake = await fakeFeishu(t, { image_upload: () => ({ status: 400, body: { code: 234001, msg: "Invalid request param." } }) });
  const { channel, ctx, mediaDir } = await startChannel(t, fake);
  const signal = new AbortController().signal;
  await assert.rejects(
    channel.send(sendRequest({ proactive: true, media: { path: join(mediaDir, "nope.pdf"), name: "nope.pdf" } }), ctx, signal),
    /read media file: ENOENT/,
  );
  const big = join(mediaDir, "big.bin");
  writeFileSync(big, Buffer.alloc(30 * 1024 * 1024 + 1));
  await assert.rejects(channel.send(sendRequest({ proactive: true, media: { path: big, name: "big.bin" } }), ctx, signal), /file too large: 31457281 bytes \(max 30MB\)/);
  const png = join(mediaDir, "x.png");
  writeFileSync(png, PNG);
  await assert.rejects(channel.send(sendRequest({ proactive: true, media: { path: png, name: "x.png" } }), ctx, signal), /upload image failed: code=234001 msg=Invalid request param\./);
  assert.equal(fake.of("create").length, 0);
});

test("a cancelled send does not start new requests", async (t) => {
  const fake = await fakeFeishu(t);
  const { channel, ctx } = await startChannel(t, fake);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(channel.send(sendRequest({ proactive: true, content: "hi" }), ctx, controller.signal), /send cancelled/);
  assert.equal(fake.of("create").length, 0);
});

test("SDK log output is forwarded without secrets", async (t) => {
  const fake = await fakeFeishu(t, { create: () => ({ status: 400, body: { code: 230001, msg: "invalid receive_id" } }) });
  const { channel, ctx, logs } = await startChannel(t, fake);
  await channel.send(sendRequest({ proactive: true, content: "hi" }), ctx, new AbortController().signal).catch(() => undefined);
  const sdk = logs.filter((l) => l.fields?.source === "lark-sdk");
  assert.ok(sdk.some((l) => l.level === "error" && /code=230001/.test(l.message) && /\/open-apis\/im\/v1\/messages/.test(l.message)));
  for (const l of logs) {
    assert.doesNotMatch(JSON.stringify(l), new RegExp(APP_SECRET));
    assert.doesNotMatch(JSON.stringify(l), new RegExp(TOKEN));
  }
});

const dropConnection = (call, res) => {
  res.socket.destroy();
  return "handled";
};

const retryLogs = (logs) => logs.filter((l) => l.level === "warn" && l.message === "download media failed, retrying");

test("a dropped download is retried until the image arrives", async (t) => {
  let drops = 2;
  const fake = await fakeFeishu(t, {
    resource: (call, res) => (drops-- > 0 ? dropConnection(call, res) : undefined),
  });
  fake.resources.set("img_flaky", PNG);
  const { connector, dispatched, logs } = await startChannel(t, fake);
  await connector.deliver(
    messageEvent({ type: "post", content: { title: "", content: [[{ tag: "text", text: "see" }], [{ tag: "img", image_key: "img_flaky" }]] } }),
  );
  await waitUntil(() => dispatched.length === 1);
  assert.equal(dispatched[0].text, "see");
  assert.deepEqual(readFileSync(dispatched[0].attachments[0].path), PNG);
  assert.equal(fake.of("resource").length, 3);
  const retries = retryLogs(logs);
  assert.equal(retries.length, 2);
  assert.equal(retries[0].fields.key, "img_flaky");
  assert.ok(retries[0].fields.error);
});

test("a download that keeps failing stops after three attempts", async (t) => {
  const fake = await fakeFeishu(t, { resource: dropConnection });
  const { connector, dispatched, logs } = await startChannel(t, fake);
  await connector.deliver(messageEvent({ type: "image", content: { image_key: "img_down" } }));
  await waitUntil(() => dispatched.length === 1);
  assert.deepEqual(dispatched[0].attachments, [{ type: "image", path: "" }]);
  assert.equal(fake.of("resource").length, 3);
  assert.equal(retryLogs(logs).length, 2);
  assert.equal(logs.filter((l) => l.level === "error" && l.message === "download media failed").length, 1);
});

test("a Feishu error response is retried", async (t) => {
  const fake = await fakeFeishu(t);
  const { connector, dispatched } = await startChannel(t, fake);
  await connector.deliver(messageEvent({ type: "image", content: { image_key: "img_missing" } }));
  await waitUntil(() => dispatched.length === 1);
  assert.equal(fake.of("resource").length, 3);
});

test("oversized resources are not retried", async (t) => {
  const fake = await fakeFeishu(t, {
    resource: (call, res) => {
      if (call.params[1] !== "file_rejected") return undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 234037, msg: "file size exceeds limit" }));
      return "handled";
    },
  });
  fake.resources.set("file_big", Buffer.alloc(2048));
  const { connector, dispatched, logs } = await startChannel(t, fake, { config: { max_media_size: 1024 } });
  await connector.deliver(messageEvent({ messageId: "om_big", type: "file", content: { file_key: "file_big", file_name: "big.zip" } }));
  await connector.deliver(messageEvent({ messageId: "om_rejected", type: "file", content: { file_key: "file_rejected", file_name: "huge.zip" } }));
  await waitUntil(() => dispatched.length === 2);
  assert.equal(fake.of("resource").filter((c) => c.params[1] === "file_big").length, 1);
  assert.equal(fake.of("resource").filter((c) => c.params[1] === "file_rejected").length, 1);
  assert.equal(retryLogs(logs).length, 0);
});

test("stopping the channel cancels a pending download retry", async (t) => {
  const fake = await fakeFeishu(t, { resource: dropConnection });
  const { connector, dispatched, handle, logs } = await startChannel(t, fake, { timing: { retryDelay: 60_000 } });
  await connector.deliver(messageEvent({ type: "image", content: { image_key: "img_down" } }));
  await waitUntil(() => retryLogs(logs).length === 1);
  await handle.stop();
  await waitUntil(() => dispatched.length === 1);
  assert.deepEqual(dispatched[0].attachments, [{ type: "image", path: "" }]);
  assert.equal(fake.of("resource").length, 1);
});
