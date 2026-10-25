import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPostContent, parsePostContent } from "../dist/post.js";

test("direct format with title, styles and links", () => {
  const result = parsePostContent(
    JSON.stringify({
      title: "Test Title",
      content: [
        [
          { tag: "text", text: "Hello " },
          { tag: "text", text: "world", style: ["bold"] },
          { tag: "a", text: "link", href: "https://example.com" },
        ],
      ],
    }),
  );
  assert.equal(result.textContent, "Test Title\nHello **world**[link](https://example.com)");
  assert.deepEqual(result.imageKeys, []);
});

test("locale wrapped format", () => {
  const result = parsePostContent('{"zh_cn":{"title":"Chinese Title","content":[[{"tag":"text","text":"hello"}]]}}');
  assert.equal(result.textContent, "Chinese Title\nhello");
});

test("double wrapped format", () => {
  const result = parsePostContent('{"post":{"en_us":{"title":"Title","content":[[{"tag":"text","text":"hello"}]]}}}');
  assert.equal(result.textContent, "Title\nhello");
});

test("images and media keys are collected", () => {
  const result = parsePostContent(
    JSON.stringify({
      title: "",
      content: [
        [
          { tag: "text", text: "see image: " },
          { tag: "img", image_key: "img_v3_abc" },
          { tag: "img", image_key: "" },
          { tag: "media", file_key: "file_v3_xyz", file_name: "report.pdf" },
          { tag: "media", file_key: "" },
        ],
      ],
    }),
  );
  assert.equal(result.textContent, "see image: ");
  assert.deepEqual(result.imageKeys, ["img_v3_abc"]);
  assert.deepEqual(result.mediaKeys, [{ fileKey: "file_v3_xyz", fileName: "report.pdf" }]);
});

test("files attached to a post are collected after inline media", () => {
  const result = parsePostContent(
    JSON.stringify({
      title: "",
      content: [[{ tag: "text", text: "summarize", style: [] }, { tag: "media", file_key: "file_v3_inline", file_name: "clip.mp4" }]],
      files: [
        { file_key: "file_v3_doc", file_name: "report.pdf", is_folder: false },
        { file_key: "file_v3_dir", file_name: "folder", is_folder: true },
        { file_key: "", file_name: "empty.txt" },
        "bogus",
      ],
    }),
  );
  assert.equal(result.textContent, "summarize");
  assert.deepEqual(result.mediaKeys, [
    { fileKey: "file_v3_inline", fileName: "clip.mp4" },
    { fileKey: "file_v3_doc", fileName: "report.pdf" },
  ]);
});

test("every element type renders like the Go parser", () => {
  const result = parsePostContent(
    JSON.stringify({
      title: "",
      content: [
        [
          { tag: "text", text: "normal " },
          { tag: "text", text: "italic", style: ["italic"] },
          { tag: "text", text: "code", style: ["code"] },
          { tag: "text", text: "strike", style: ["strikethrough"] },
          { tag: "text", text: "both", style: ["bold", "italic"] },
          { tag: "at", user_name: "Alice" },
          { tag: "at", user_id: "ou_1" },
          { tag: "code_block", text: "fmt.Println()", language: "go" },
          { tag: "pre", content: "raw" },
          { tag: "code", text: "inline" },
          { tag: "emotion", emoji_type: "SMILE" },
          { tag: "emotion", emoji: "OK" },
          { tag: "br" },
          { tag: "hr" },
        ],
        [],
        [{ tag: "text", text: "second" }],
      ],
    }),
  );
  assert.equal(
    result.textContent,
    "normal *italic*`code`~~strike~~***both***@Alice@ou_1\n```go\nfmt.Println()\n```\n\n```\nraw\n```\n`inline`SMILEOK\n\n---\n\nsecond",
  );
});

test("malformed paragraphs are skipped and null values tolerated", () => {
  const result = parsePostContent(
    JSON.stringify({
      title: null,
      content: [null, "bad", [1, { tag: "text", text: "lost" }], [null, { tag: "text", text: 5 }, { tag: "text", text: "kept" }]],
    }),
  );
  assert.equal(result.textContent, "kept");
  assert.equal(parsePostContent('{"zh_cn":{"title":"T","content":null}}').textContent, "T");
});

test("invalid posts are errors", () => {
  assert.throws(() => parsePostContent(""), /empty post content/);
  assert.throws(() => parsePostContent("{"), /parse post JSON/);
  assert.throws(() => parsePostContent("[1]"), /parse post JSON/);
  assert.throws(() => parsePostContent('{"title":"x"}'), /unrecognized post content format/);
  assert.throws(() => parsePostContent("null"), /unrecognized post content format/);
  assert.throws(() => parsePostContent('{"content":"x"}'), /parse content paragraphs/);
  assert.equal(parsePostContent('{"title":5,"content":[],"en_us":{"title":"E","content":[]}}').textContent, "E");
});

test("buildPostContent puts each line in an md row", () => {
  const built = buildPostContent("## Hello\n- item");
  assert.deepEqual(JSON.parse(built), {
    zh_cn: { title: "", content: [[{ tag: "md", text: "## Hello" }], [{ tag: "md", text: "- item" }]] },
  });
  const md = "**bold** and `code`";
  assert.equal(JSON.parse(buildPostContent(md)).zh_cn.content[0][0].text, md);
  assert.deepEqual(JSON.parse(buildPostContent("")), { zh_cn: { title: "", content: [[{ tag: "md", text: "" }]] } });
});
