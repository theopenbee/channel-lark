import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildContext,
  encodeRaw,
  feishuMediaMsgType,
  isValidKey,
  lookupFileType,
  mediaTypeForMsgType,
  parseMediaKeys,
  parseMillis,
  parseTextContent,
  resolveMentions,
  resourceType,
  retryWithBackoff,
  richTextFallback,
  sanitizeFileName,
  targetFromRaw,
} from "../dist/helpers.js";

test("parseMediaKeys reads keys by message type", () => {
  const cases = [
    ['{"image_key":"img_abc123"}', "image", { imageKey: "img_abc123", fileKey: "", fileName: "" }],
    ['{"image_key":"img_sticker"}', "sticker", { imageKey: "img_sticker", fileKey: "", fileName: "" }],
    ['{"file_key":"file_xyz","file_name":"report.pdf"}', "file", { imageKey: "", fileKey: "file_xyz", fileName: "report.pdf" }],
    ['{"file_key":"file_audio"}', "audio", { imageKey: "", fileKey: "file_audio", fileName: "" }],
    ['{"file_key":"file_audio","duration":2000}', "audio", { imageKey: "", fileKey: "file_audio", fileName: "" }],
    ['{"file_key":"file_v","image_key":"img_cover","file_name":"a.mp4"}', "media", { imageKey: "", fileKey: "file_v", fileName: "a.mp4" }],
    ["not json", "image", { imageKey: "", fileKey: "", fileName: "" }],
    ['["x"]', "file", { imageKey: "", fileKey: "", fileName: "" }],
  ];
  for (const [content, type, want] of cases) assert.deepEqual(parseMediaKeys(content, type), want, `${type} ${content}`);
});

test("parseTextContent follows the Go map[string]string decoding", () => {
  assert.equal(parseTextContent('{"text":"hi"}'), "hi");
  assert.equal(parseTextContent('{"text":null}'), "");
  assert.equal(parseTextContent("null"), "");
  assert.equal(parseTextContent("{}"), "");
  assert.equal(parseTextContent('{"text":"hi","n":1}'), undefined);
  assert.equal(parseTextContent('"hi"'), undefined);
  assert.equal(parseTextContent("nope"), undefined);
});

test("resource and attachment types follow the message type", () => {
  const resources = { image: "image", sticker: "image", file: "file", audio: "file", video: "file", media: "file" };
  for (const [type, want] of Object.entries(resources)) assert.equal(resourceType(type), want, type);
  const media = { image: "image", audio: "audio", video: "video", media: "video", sticker: "sticker", file: "document", other: "document" };
  for (const [type, want] of Object.entries(media)) assert.equal(mediaTypeForMsgType(type), want, type);
});

test("keys must be safe identifiers", () => {
  assert.ok(isValidKey("img_v3_02ab-CD"));
  assert.ok(!isValidKey("../x"));
  assert.ok(!isValidKey(""));
  assert.ok(!isValidKey("a b"));
});

test("lookupFileType matches the Go extension table", () => {
  const categories = { "photo.jpg": "image", "photo.PNG": "image", "song.mp3": "audio", "song.opus": "audio", "clip.mp4": "video", "doc.pdf": "file", noext: "file" };
  for (const [path, want] of Object.entries(categories)) assert.equal(lookupFileType(path).category, want, path);
  const fileTypes = {
    "voice.opus": "opus",
    "voice.ogg": "opus",
    "clip.mp4": "mp4",
    "clip.mov": "mp4",
    "clip.avi": "mp4",
    "doc.pdf": "pdf",
    "doc.doc": "doc",
    "doc.docx": "doc",
    "sheet.xls": "xls",
    "sheet.xlsx": "xls",
    "slide.ppt": "ppt",
    "slide.pptx": "ppt",
    "song.mp3": "stream",
    "photo.webp": "stream",
    "other.zip": "stream",
    "/dir.v2/noext": "stream",
  };
  for (const [path, want] of Object.entries(fileTypes)) assert.equal(lookupFileType(path).fileType, want, path);
  const msgTypes = { opus: "audio", mp4: "media", pdf: "file", stream: "file" };
  for (const [ft, want] of Object.entries(msgTypes)) assert.equal(feishuMediaMsgType(ft), want, ft);
});

test("sanitizeFileName matches the Go sanitizer", () => {
  const cases = [
    ["report.pdf", "report.pdf"],
    ["my report.pdf", "my report.pdf"],
    ["file\x00name\x1f.txt", "file_name_.txt"],
    ["file\r\nname.txt", "file_name.txt"],
    ["file\\name.txt", "file_name.txt"],
    ['file"name.txt', "file_name.txt"],
    ["path/to/file.txt", "path_to_file.txt"],
    ["C:file.txt", "C_file.txt"],
    ["a\x00\x01\x02b.txt", "a_b.txt"],
    ["", ""],
    ["café.pdf", "café.pdf"],
    ["file\x7fname.txt", "file_name.txt"],
  ];
  for (const [input, want] of cases) assert.equal(sanitizeFileName(input), want, JSON.stringify(input));
});

test("resolveMentions only resolves the bot's own key", () => {
  const cases = [
    ["@_user_1 @_user_2 hello", [{ key: "@_user_1", name: "OpenBee" }, { key: "@_user_2", name: "Tom" }], "OpenBee", "@OpenBee @_user_2 hello"],
    ["@_user_1 and @_user_2", [{ key: "@_user_1", name: "Tom" }, { key: "@_user_2", name: "Alice" }], "OpenBee", "@_user_1 and @_user_2"],
    ["@_user_1 hello", undefined, "OpenBee", "@_user_1 hello"],
    ["@_user_1 hello", [{ key: "@_user_1", name: "Tom" }], "", "@_user_1 hello"],
    ["@_user_1 hello", [{ key: null, name: "OpenBee" }, { key: "@_user_1", name: "OpenBee" }], "OpenBee", "@OpenBee hello"],
    ["@_user_1 hello", [{ key: "@_user_1", name: null }], "OpenBee", "@_user_1 hello"],
    ["@_user_1 x @_user_1", [{ key: "@_user_1", name: "OpenBee" }], "OpenBee", "@OpenBee x @OpenBee"],
  ];
  for (const [text, mentions, bot, want] of cases) assert.equal(resolveMentions(text, mentions, bot), want);
});

test("raw round-trips into a reply target and legacy raw is understood", () => {
  const raw = encodeRaw({ message_id: "om_1", chat_id: "oc_1", chat_type: "group", content: "{}", message_type: "text" });
  assert.equal(raw, '{"event":{"message":{"message_id":"om_1","chat_id":"oc_1","chat_type":"group"}}}');
  assert.deepEqual(targetFromRaw(raw), { chatId: "oc_1", chatType: "group", messageId: "om_1" });

  const legacy = JSON.stringify({
    schema: "2.0",
    header: { event_id: "evt1", event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: "ou_abc", union_id: "on_abc" }, sender_type: "user", tenant_key: "tk1" },
      message: { message_id: "om_9", chat_id: "oc_xyz", chat_type: "p2p", message_type: "text", content: '{"text":"x"}' },
    },
  });
  assert.deepEqual(targetFromRaw(legacy), { chatId: "oc_xyz", chatType: "p2p", messageId: "om_9" });

  for (const bad of [undefined, "", "not json", "{}", '{"event":{}}', '{"event":{"message":{"chat_id":"oc","chat_type":"group"}}}', '{"event":{"message":{"chat_id":"oc","message_id":"om"}}}']) {
    assert.equal(targetFromRaw(bad), undefined, String(bad));
  }
});

test("buildContext mirrors the Go ExtractContext output", () => {
  const ctx = buildContext({
    sender: { sender_id: { open_id: "ou_abc", union_id: "on_abc", user_id: "u" }, sender_type: "user", tenant_key: "tk1" },
    message: {
      message_id: "om_1",
      chat_id: "oc_xyz",
      chat_type: "group",
      message_type: "text",
      mentions: [
        { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Bot" },
        { key: "@_user_2", name: "NoId" },
        { name: "NoKey" },
        { key: "@_user_3" },
      ],
    },
  });
  assert.deepEqual(ctx, {
    sender: { open_id: "ou_abc", union_id: "on_abc", sender_type: "user" },
    message: {
      chat_id: "oc_xyz",
      chat_type: "group",
      message_id: "om_1",
      message_type: "text",
      mentions: [
        { key: "@_user_1", open_id: "ou_bot", union_id: "", name: "Bot" },
        { key: "@_user_2", open_id: "", union_id: "", name: "NoId" },
      ],
    },
  });
  assert.deepEqual(buildContext({ sender: { sender_id: {} }, message: {} }), {
    sender: { open_id: "", union_id: "", sender_type: "" },
    message: { chat_id: "", chat_type: "", message_id: "", message_type: "", mentions: null },
  });
});

test("parseMillis accepts only integer strings", () => {
  assert.equal(parseMillis("1700000000123"), 1700000000123);
  assert.equal(parseMillis(undefined), undefined);
  assert.equal(parseMillis("abc"), undefined);
  assert.equal(parseMillis("1.5"), undefined);
  assert.equal(parseMillis("0"), undefined);
});

test("richTextFallback is localized", () => {
  assert.equal(richTextFallback("zh"), "[富文本消息]");
  assert.equal(richTextFallback("en"), "[Rich text message]");
  assert.equal(richTextFallback("ja"), "[Rich text message]");
});

test("retryWithBackoff retries with doubling delays and stops on abort", async () => {
  const times = [];
  let n = 0;
  const value = await retryWithBackoff(
    async () => {
      times.push(Date.now());
      if (++n < 3) throw new Error(`fail ${n}`);
      return "ok";
    },
    { attempts: 5, delay: 20 },
  );
  assert.equal(value, "ok");
  assert.equal(n, 3);
  assert.ok(times[2] - times[1] >= times[1] - times[0]);

  let calls = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => {
        calls++;
        throw new Error("always");
      },
      { attempts: 3, delay: 1 },
    ),
    /always/,
  );
  assert.equal(calls, 3);

  const controller = new AbortController();
  let aborted = 0;
  const pending = retryWithBackoff(
    async () => {
      aborted++;
      throw new Error("x");
    },
    { attempts: 5, delay: 10_000, signal: controller.signal },
  );
  controller.abort(new Error("stopped"));
  await assert.rejects(pending, /stopped/);
  assert.equal(aborted, 1);
});
