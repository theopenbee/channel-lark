import { test } from "node:test";
import assert from "node:assert/strict";

import { detectContentType, detectMime, extensionFromMime, fileExt, mediaTypeFromMime, mimeFromExtension } from "../dist/mime.js";

const b = (s) => Buffer.from(s, "latin1");

test("detectContentType follows Go's http.DetectContentType", () => {
  const cases = [
    ["", "text/plain; charset=utf-8"],
    ["\x01\x02\x03", "application/octet-stream"],
    ["hello world", "text/plain; charset=utf-8"],
    ["  <!DOCTYPE html><html>", "text/html; charset=utf-8"],
    ["<HtMl><b>x", "text/html; charset=utf-8"],
    ["<htmlx", "text/plain; charset=utf-8"],
    ["\n<?xml version='1.0'?>", "text/xml; charset=utf-8"],
    ["%PDF-1.7", "application/pdf"],
    ["%!PS-Adobe-3.0", "application/postscript"],
    ["\xFE\xFF\x00a", "text/plain; charset=utf-16be"],
    ["\xFF\xFE\x00a", "text/plain; charset=utf-16le"],
    ["\xEF\xBB\xBFhi", "text/plain; charset=utf-8"],
    ["\x00\x00\x01\x00\x01", "image/x-icon"],
    ["BM\x00\x00", "image/bmp"],
    ["GIF89a...", "image/gif"],
    ["RIFF\x10\x00\x00\x00WEBPVP8 ", "image/webp"],
    ["\x89PNG\x0D\x0A\x1A\x0A....", "image/png"],
    ["\xFF\xD8\xFF\xE0", "image/jpeg"],
    ["FORM\x00\x00\x00\x00AIFF", "audio/aiff"],
    ["ID3\x03", "audio/mpeg"],
    ["OggS\x00\x02", "application/ogg"],
    ["MThd\x00\x00\x00\x06\x00", "audio/midi"],
    ["RIFF\x00\x00\x00\x00AVI LIST", "video/avi"],
    ["RIFF\x00\x00\x00\x00WAVEfmt ", "audio/wave"],
    ["\x00\x00\x00\x18ftypmp420000mp42isom", "video/mp4"],
    ["\x00\x00\x00\x14ftypqt  0000qt  ", "application/octet-stream"],
    ["\x1A\x45\xDF\xA3", "video/webm"],
    ["\x00".repeat(34) + "LP", "application/vnd.ms-fontobject"],
    ["\x00\x01\x00\x00", "font/ttf"],
    ["OTTO", "font/otf"],
    ["wOF2", "font/woff2"],
    ["\x1F\x8B\x08\x00", "application/x-gzip"],
    ["PK\x03\x04", "application/zip"],
    ["Rar!\x1A\x07\x01\x00", "application/x-rar-compressed"],
    ["\x00asm\x01", "application/wasm"],
  ];
  for (const [input, want] of cases) assert.equal(detectContentType(b(input)), want, JSON.stringify(input));
  assert.equal(detectContentType(Buffer.concat([Buffer.alloc(600, 0x61), Buffer.from([0x01])])), "text/plain; charset=utf-8");
});

test("detectMime prefers sniffing, then the file name", () => {
  assert.equal(detectMime(b("OggS\x00\x02"), ""), "audio/ogg");
  assert.equal(detectMime(b("\x89PNG\x0D\x0A\x1A\x0A"), "x.jpg"), "image/png");
  assert.equal(detectMime(b("plain text"), "song.mp3"), "audio/mpeg");
  assert.equal(detectMime(b("plain text"), "notes.md"), "application/octet-stream");
  assert.equal(detectMime(b("plain text"), ""), "text/plain; charset=utf-8");
  assert.equal(detectMime(b("\x01\x02"), ""), "application/octet-stream");
  assert.equal(detectMime(Buffer.alloc(0), "a.pdf"), "application/pdf");
  assert.equal(detectMime(Buffer.alloc(0), ""), "application/octet-stream");
});

test("extensions and media types map like the Go media service", () => {
  assert.equal(extensionFromMime("image/png"), ".png");
  assert.equal(extensionFromMime("image/jpeg"), ".jpg");
  assert.equal(extensionFromMime("audio/ogg"), ".ogg");
  assert.equal(extensionFromMime("video/quicktime"), ".mov");
  assert.equal(extensionFromMime("application/pdf"), ".pdf");
  assert.equal(extensionFromMime("text/plain; charset=utf-8"), ".bin");
  assert.equal(extensionFromMime("application/ogg"), ".bin");
  assert.equal(mimeFromExtension(".JPEG"), "image/jpeg");
  assert.equal(mimeFromExtension(".opus"), "audio/ogg");
  assert.equal(mimeFromExtension(".zip"), "application/octet-stream");
  assert.equal(mediaTypeFromMime("image/webp"), "image");
  assert.equal(mediaTypeFromMime("audio/mpeg"), "audio");
  assert.equal(mediaTypeFromMime("video/mp4; codecs=x"), "video");
  assert.equal(mediaTypeFromMime("application/pdf"), "document");
});

test("fileExt behaves like filepath.Ext", () => {
  assert.equal(fileExt("report.pdf"), ".pdf");
  assert.equal(fileExt("archive.tar.gz"), ".gz");
  assert.equal(fileExt("noext"), "");
  assert.equal(fileExt("dir.v2/noext"), "");
  assert.equal(fileExt(".bashrc"), ".bashrc");
  assert.equal(fileExt(""), "");
});
