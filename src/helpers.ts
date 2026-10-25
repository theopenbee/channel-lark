import type { AttachmentType } from "@theopenbee/channel-sdk";

import { fileExt } from "./mime.js";

export const MENTION_PREFIX = "@";

const VALID_KEY = /^[a-zA-Z0-9_-]+$/;

export function isValidKey(key: string): boolean {
  return VALID_KEY.test(key);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface MediaKeys {
  imageKey: string;
  fileKey: string;
  fileName: string;
}

export function parseMediaKeys(contentJSON: string, msgType: string): MediaKeys {
  const empty = { imageKey: "", fileKey: "", fileName: "" };
  let content: unknown;
  try {
    content = JSON.parse(contentJSON);
  } catch {
    return empty;
  }
  if (!isObject(content)) return empty;
  if (msgType === "image" || msgType === "sticker") return { ...empty, imageKey: str(content.image_key) };
  return { ...empty, fileKey: str(content.file_key), fileName: str(content.file_name) };
}

export function parseTextContent(contentJSON: string): string | undefined {
  let content: unknown;
  try {
    content = JSON.parse(contentJSON);
  } catch {
    return undefined;
  }
  if (content === null) return "";
  if (!isObject(content)) return undefined;
  for (const value of Object.values(content)) {
    if (value !== null && typeof value !== "string") return undefined;
  }
  return str(content.text);
}

export function resourceType(msgType: string): "image" | "file" {
  return msgType === "image" || msgType === "sticker" ? "image" : "file";
}

export function mediaTypeForMsgType(msgType: string): AttachmentType {
  switch (msgType) {
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "video":
    case "media":
      return "video";
    case "sticker":
      return "sticker";
    default:
      return "document";
  }
}

export type FeishuFileType = "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";

export interface FileTypeInfo {
  category: "image" | "audio" | "video" | "file";
  fileType: FeishuFileType;
  msgType: "audio" | "media" | "file";
}

const IMAGE: FileTypeInfo = { category: "image", fileType: "stream", msgType: "file" };
const AUDIO_STREAM: FileTypeInfo = { category: "audio", fileType: "stream", msgType: "file" };
const OPUS: FileTypeInfo = { category: "audio", fileType: "opus", msgType: "audio" };
const VIDEO: FileTypeInfo = { category: "video", fileType: "mp4", msgType: "media" };
const doc = (fileType: FeishuFileType): FileTypeInfo => ({ category: "file", fileType, msgType: "file" });

const extFileTypeMap: Record<string, FileTypeInfo> = {
  ".jpg": IMAGE,
  ".jpeg": IMAGE,
  ".png": IMAGE,
  ".gif": IMAGE,
  ".webp": IMAGE,
  ".bmp": IMAGE,
  ".ico": IMAGE,
  ".tiff": IMAGE,
  ".opus": OPUS,
  ".ogg": OPUS,
  ".mp3": AUDIO_STREAM,
  ".wav": AUDIO_STREAM,
  ".amr": AUDIO_STREAM,
  ".aac": AUDIO_STREAM,
  ".flac": AUDIO_STREAM,
  ".m4a": AUDIO_STREAM,
  ".mp4": VIDEO,
  ".mov": VIDEO,
  ".avi": VIDEO,
  ".pdf": doc("pdf"),
  ".doc": doc("doc"),
  ".docx": doc("doc"),
  ".xls": doc("xls"),
  ".xlsx": doc("xls"),
  ".ppt": doc("ppt"),
  ".pptx": doc("ppt"),
};

const DEFAULT_FILE_TYPE: FileTypeInfo = doc("stream");

export function lookupFileType(name: string): FileTypeInfo {
  return extFileTypeMap[fileExt(name).toLowerCase()] ?? DEFAULT_FILE_TYPE;
}

export function feishuMediaMsgType(fileType: string): "audio" | "media" | "file" {
  switch (fileType) {
    case "opus":
      return "audio";
    case "mp4":
      return "media";
    default:
      return "file";
  }
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f\r\n"\\/:]+/g, "_");
}

export interface Mention {
  key?: string | null;
  name?: string | null;
  id?: { open_id?: string | null; union_id?: string | null; user_id?: string | null } | null;
}

export function resolveMentions(text: string, mentions: Mention[] | null | undefined, botName: string): string {
  if (!mentions || mentions.length === 0 || !botName) return text;
  for (const m of mentions) {
    if (typeof m?.key !== "string" || typeof m.name !== "string") continue;
    if (m.name === botName) return text.split(m.key).join(MENTION_PREFIX + m.name);
  }
  return text;
}

export interface MessageEvent {
  sender?: {
    sender_id?: { open_id?: string; union_id?: string; user_id?: string } | null;
    sender_type?: string;
    tenant_key?: string;
  } | null;
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    create_time?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Mention[] | null;
  } | null;
}

export function encodeRaw(message: NonNullable<MessageEvent["message"]>): string {
  return JSON.stringify({
    event: { message: { message_id: message.message_id, chat_id: message.chat_id, chat_type: message.chat_type } },
  });
}

export interface ReplyTarget {
  chatId: string;
  chatType: string;
  messageId: string;
}

export function targetFromRaw(raw: string | undefined): ReplyTarget | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || !isObject(parsed.event) || !isObject(parsed.event.message)) return undefined;
  const { chat_id, chat_type, message_id } = parsed.event.message;
  if (typeof chat_id !== "string" || typeof chat_type !== "string" || typeof message_id !== "string") return undefined;
  if (!chat_id || !message_id) return undefined;
  return { chatId: chat_id, chatType: chat_type, messageId: message_id };
}

export interface MentionContext {
  key: string;
  open_id: string;
  union_id: string;
  name: string;
}

export function buildContext(event: MessageEvent): Record<string, unknown> {
  const sender = event.sender ?? {};
  const message = event.message ?? {};
  const mentions: MentionContext[] = [];
  for (const m of message.mentions ?? []) {
    if (typeof m?.key !== "string" || typeof m.name !== "string") continue;
    mentions.push({ key: m.key, open_id: str(m.id?.open_id), union_id: str(m.id?.union_id), name: m.name });
  }
  return {
    sender: {
      open_id: str(sender.sender_id?.open_id),
      union_id: str(sender.sender_id?.union_id),
      sender_type: str(sender.sender_type),
    },
    message: {
      chat_id: str(message.chat_id),
      chat_type: str(message.chat_type),
      message_id: str(message.message_id),
      message_type: str(message.message_type),
      mentions: mentions.length > 0 ? mentions : null,
    },
  };
}

export function parseMillis(value: string | undefined): number | undefined {
  if (!value || !/^[+-]?\d+$/.test(value)) return undefined;
  const ms = Number(value);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

export function richTextFallback(language: string): string {
  return language === "zh" ? "[富文本消息]" : "[Rich text message]";
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RetryOptions {
  attempts: number;
  delay: number;
  signal?: AbortSignal;
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, { attempts, delay, signal }: RetryOptions): Promise<T> {
  if (attempts <= 0) return fn();
  let lastError: unknown;
  let wait = delay;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw signal.reason;
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
    if (i < attempts - 1) {
      await sleep(wait, signal);
      wait *= 2;
    }
  }
  throw lastError;
}
