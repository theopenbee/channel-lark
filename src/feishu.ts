import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import { EventDispatcher, LoggerLevel } from "@larksuiteoapi/node-sdk";
import {
  ConfigError,
  type Attachment,
  type AttachmentType,
  type ChannelContext,
  type ChannelDefinition,
  type SendRequest,
  type SendResult,
} from "@theopenbee/channel-sdk";

import {
  CredentialsRejectedError,
  FeishuApi,
  FeishuError,
  REQUEST_TIMEOUT,
  httpWithTimeout,
  isRetryableDownload,
  resolveDomain,
  sdkDomain,
  verifyCredentials,
} from "./api.js";
import {
  buildContext,
  encodeRaw,
  errorText,
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
  type MessageEvent,
  type ReplyTarget,
} from "./helpers.js";
import { larkLogger } from "./logger.js";
import { detectMime, extensionFromMime, fileExt, mediaTypeFromMime, mimeFromExtension } from "./mime.js";
import { buildPostContent, parsePostContent } from "./post.js";
import { connectWebSocket, type Connection, type Connector } from "./ws.js";

export const DEFAULT_MAX_MEDIA_SIZE = 100 * 1024 * 1024;
export const MAX_UPLOAD_SIZE = 30 * 1024 * 1024;
const TYPING_EMOJI = "Typing";
const REPLY_FALLBACK_CODES = new Set([230011, 231003]);
const APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/;
const MEDIA_MESSAGE_TYPES = new Set(["image", "file", "audio", "video", "media", "sticker"]);

export interface Timing {
  connectTimeout: number;
  retryAttempts: number;
  retryDelay: number;
  downloadAttempts: number;
  reactionTimeout: number;
  recallWait: number;
  pendingTtl: number;
}

export const DEFAULT_TIMING: Timing = {
  connectTimeout: 30_000,
  retryAttempts: 5,
  retryDelay: 500,
  downloadAttempts: 3,
  reactionTimeout: 30_000,
  recallWait: 5_000,
  pendingTtl: 10 * 60_000,
};

export interface FeishuChannelOptions {
  connect?: Connector;
  timing?: Partial<Timing>;
  onFatal?: (reason: string) => void;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  maxMediaSize: number;
  baseUrl: string;
}

export function readConfig(raw: Record<string, unknown>): FeishuConfig {
  const appId = typeof raw.app_id === "string" ? raw.app_id.trim() : "";
  const appSecret = typeof raw.app_secret === "string" ? raw.app_secret.trim() : "";
  if (!appId) throw new ConfigError("app_id is required");
  if (!appSecret) throw new ConfigError("app_secret is required");
  if (!APP_ID_PATTERN.test(appId)) throw new ConfigError("app_id must be cli_ followed by 16 hex characters");
  const maxMediaSize =
    typeof raw.max_media_size === "number" && Number.isFinite(raw.max_media_size) && raw.max_media_size > 0
      ? Math.floor(raw.max_media_size)
      : DEFAULT_MAX_MEDIA_SIZE;
  const domain = typeof raw.domain === "string" ? raw.domain : "";
  const baseUrl = resolveDomain(domain);
  if (!baseUrl) throw new ConfigError(`domain must be feishu, lark or an http(s) base URL, got "${domain}"`);
  return { appId, appSecret, maxMediaSize, baseUrl };
}

function defaultFatal(reason: string): void {
  process.stderr.write(`fatal: ${reason}\n`);
  process.exit(1);
}

function attachment(type: AttachmentType, path: string, name: string): Attachment {
  return name ? { type, path, name } : { type, path };
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("send cancelled");
}

interface PendingReaction {
  reaction: Promise<string | undefined>;
  timer?: NodeJS.Timeout;
}

function waitFor<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
    void promise.then((value) => {
      clearTimeout(timer);
      resolve({ value });
    });
  });
}

export function createFeishuChannel(options: FeishuChannelOptions = {}): ChannelDefinition {
  const connect = options.connect ?? connectWebSocket;
  const timing: Timing = { ...DEFAULT_TIMING, ...options.timing };
  const onFatal = options.onFatal ?? defaultFatal;
  const pending = new Map<string, PendingReaction>();
  let cfg: FeishuConfig;
  let api: FeishuApi | undefined;
  let lifetime = new AbortController();

  const retry = <T>(fn: () => Promise<T>, signal: AbortSignal) =>
    retryWithBackoff(fn, { attempts: timing.retryAttempts, delay: timing.retryDelay, signal });

  const deadline = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(timing.reactionTimeout)]);

  const trackReaction = (ctx: ChannelContext, messageId: string) => {
    let settle!: (id: string | undefined) => void;
    const entry: PendingReaction = { reaction: new Promise((resolve) => (settle = resolve)) };
    pending.set(messageId, entry);
    return () => {
      retry(() => api!.addReaction(messageId, TYPING_EMOJI), deadline())
        .then(
          (id) => settle(id || undefined),
          (err) => {
            if (!lifetime.signal.aborted) ctx.log.error("add reaction failed after retries", { message_id: messageId, error: errorText(err) });
            settle(undefined);
          },
        )
        .finally(() => {
          if (lifetime.signal.aborted) return;
          entry.timer = setTimeout(() => {
            if (pending.get(messageId) === entry) pending.delete(messageId);
          }, timing.pendingTtl);
          entry.timer.unref();
        });
    };
  };

  const recallReaction = (ctx: ChannelContext, messageId: string) => {
    const entry = pending.get(messageId);
    if (!entry) return;
    pending.delete(messageId);
    if (entry.timer) clearTimeout(entry.timer);
    void (async () => {
      const signal = deadline();
      const result = await waitFor(entry.reaction, timing.recallWait);
      if (!result) {
        ctx.log.warn("timed out waiting for reaction ID", { message_id: messageId });
        return;
      }
      const reactionId = result.value;
      if (!reactionId) return;
      try {
        await retry(() => api!.deleteReaction(messageId, reactionId), signal);
      } catch (err) {
        ctx.log.warn("recall reaction failed after retries", { message_id: messageId, error: errorText(err) });
      }
    })();
  };

  const download = async (
    ctx: ChannelContext,
    messageId: string,
    key: string,
    resType: "image" | "file",
    type: AttachmentType | undefined,
    fileName: string,
  ): Promise<Attachment> => {
    try {
      if (!isValidKey(key)) throw new Error(`invalid file key: ${key}`);
      const data = await retryWithBackoff(() => api!.downloadResource(messageId, key, resType, cfg.maxMediaSize), {
        attempts: timing.downloadAttempts,
        delay: timing.retryDelay,
        signal: lifetime.signal,
        shouldRetry: (err) => {
          if (!isRetryableDownload(err)) return false;
          ctx.log.warn("download media failed, retrying", { key, error: errorText(err) });
          return true;
        },
      });
      const mime = detectMime(data, fileName);
      const ext = (fileName ? fileExt(fileName) : "") || extensionFromMime(mime);
      const path = await ctx.saveMedia(data, ext);
      return attachment(type ?? mediaTypeFromMime(mime), path, fileName);
    } catch (err) {
      ctx.log.error("download media failed", { key, error: errorText(err) });
      return attachment(type ?? mediaTypeFromMime(mimeFromExtension(fileExt(fileName))), "", fileName);
    }
  };

  const resolveMedia = async (ctx: ChannelContext, messageId: string, msgType: string, content: string): Promise<Attachment> => {
    const { imageKey, fileKey, fileName } = parseMediaKeys(content, msgType);
    const key = imageKey || fileKey;
    const type = mediaTypeForMsgType(msgType);
    if (!key) {
      ctx.log.warn("no file key found in content", { message_type: msgType });
      return attachment(type, "", fileName);
    }
    return download(ctx, messageId, key, resourceType(msgType), type, fileName);
  };

  const resolvePost = async (ctx: ChannelContext, messageId: string, content: string): Promise<{ text: string; attachments: Attachment[] }> => {
    let result;
    try {
      result = parsePostContent(content);
    } catch (err) {
      ctx.log.warn("failed to parse post content", { error: errorText(err) });
      return { text: richTextFallback(ctx.language), attachments: [] };
    }
    const attachments = await Promise.all([
      ...result.imageKeys.map((key) => download(ctx, messageId, key, "image", "image", "")),
      ...result.mediaKeys.map((m) => download(ctx, messageId, m.fileKey, "file", undefined, m.fileName)),
    ]);
    const text = result.textContent || (attachments.length === 0 ? richTextFallback(ctx.language) : "");
    return { text, attachments };
  };

  const handleEvent = async (ctx: ChannelContext, event: MessageEvent) => {
    const msg = event.message;
    if (!msg) return;
    const messageId = msg.message_id ?? "";
    const chatId = msg.chat_id ?? "";
    const msgType = msg.message_type ?? "";
    const content = msg.content ?? "";
    const senderId = event.sender?.sender_id?.open_id ?? "";
    ctx.log.info("received event", {
      message_id: messageId,
      chat_id: chatId,
      chat_type: msg.chat_type ?? "",
      message_type: msgType,
      sender_open_id: senderId,
    });
    if (!senderId) {
      ctx.log.warn("skipping message without sender open_id", { message_id: messageId });
      return;
    }
    if (!chatId) {
      ctx.log.warn("skipping message without chat_id", { message_id: messageId });
      return;
    }
    if (!messageId) {
      ctx.log.warn("skipping message without message_id", { chat_id: chatId });
      return;
    }

    let text = "";
    let attachments: Attachment[] = [];
    if (msgType === "text") {
      const parsed = parseTextContent(content);
      if (parsed === undefined) {
        ctx.log.warn("skipping text message with invalid content", { message_id: messageId });
        return;
      }
      text = parsed;
    } else if (msgType === "post") {
      ({ text, attachments } = await resolvePost(ctx, messageId, content));
    } else if (MEDIA_MESSAGE_TYPES.has(msgType)) {
      attachments = [await resolveMedia(ctx, messageId, msgType, content)];
    } else {
      ctx.log.warn("skipping unsupported message type", { message_type: msgType });
      return;
    }
    if (!text && attachments.length === 0) return;
    text = resolveMentions(text, msg.mentions, ctx.botName);

    const startReaction = trackReaction(ctx, messageId);
    ctx.dispatch({
      chat_id: chatId,
      sender_id: senderId,
      message_id: messageId,
      text,
      attachments,
      raw: encodeRaw(msg),
      context: buildContext(event),
      time: parseMillis(msg.create_time),
    });
    startReaction();
  };

  const deliver = async (ctx: ChannelContext, target: ReplyTarget, msgType: string, content: string): Promise<string | undefined> => {
    if (target.chatType === "p2p" || !target.messageId) return api!.createMessage(target.chatId, msgType, content);
    try {
      return await api!.replyMessage(target.messageId, msgType, content);
    } catch (err) {
      if (!(err instanceof FeishuError) || !REPLY_FALLBACK_CODES.has(err.code)) throw err;
      ctx.log.warn("reply failed, falling back to direct send", { code: err.code });
      return api!.createMessage(target.chatId, msgType, content);
    }
  };

  const sendMedia = async (
    ctx: ChannelContext,
    target: ReplyTarget,
    media: NonNullable<SendRequest["media"]>,
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    const readError = (err: unknown) => new Error(`read media file: ${errorText(err)}`);
    const { size } = await stat(media.path).catch((err) => Promise.reject(readError(err)));
    if (size > MAX_UPLOAD_SIZE) throw new Error(`file too large: ${size} bytes (max 30MB)`);
    const data = await readFile(media.path).catch((err) => Promise.reject(readError(err)));
    const typeSource = fileExt(media.path) ? media.path : media.name;
    const info = lookupFileType(typeSource);
    if (info.category === "image") {
      const imageKey = await api!.uploadImage(data);
      cancelled(signal);
      return deliver(ctx, target, "image", JSON.stringify({ image_key: imageKey }));
    }
    const fileName = sanitizeFileName(media.name || basename(media.path));
    const fileKey = await api!.uploadFile(data, info.fileType, fileName);
    cancelled(signal);
    const msgType = feishuMediaMsgType(info.fileType);
    const content = msgType === "media" ? { file_key: fileKey, file_name: fileName } : { file_key: fileKey };
    return deliver(ctx, target, msgType, JSON.stringify(content));
  };

  const openConnection = (ctx: ChannelContext, dispatcher: EventDispatcher): Promise<Connection> => {
    let connection: Connection | undefined;
    let state: "pending" | "ready" | "failed" = "pending";
    return new Promise<Connection>((resolve, reject) => {
      const fail = (err: Error) => {
        if (state !== "pending") return;
        state = "failed";
        clearTimeout(timer);
        connection?.close();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error("timed out connecting to the Feishu long connection")), timing.connectTimeout);
      try {
        connection = connect({
          appId: cfg.appId,
          appSecret: cfg.appSecret,
          domain: sdkDomain(cfg.baseUrl),
          logger: larkLogger(ctx.log),
          http: httpWithTimeout(REQUEST_TIMEOUT),
          eventDispatcher: dispatcher,
          onReady: () => {
            if (state !== "pending") return;
            state = "ready";
            clearTimeout(timer);
            queueMicrotask(() => resolve(connection!));
          },
          onError: (err) => {
            if (state === "pending") {
              fail(new Error(`Feishu long connection failed: ${err.message}`));
              return;
            }
            if (state === "failed" || lifetime.signal.aborted) return;
            onFatal(`Feishu long connection failed: ${err.message}`);
          },
          onReconnecting: () => ctx.log.warn("Feishu long connection lost, reconnecting"),
          onReconnected: () => ctx.log.info("Feishu long connection re-established"),
        });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  return {
    async start(ctx) {
      cfg = readConfig(ctx.config);
      lifetime = new AbortController();
      const http = httpWithTimeout(REQUEST_TIMEOUT);
      try {
        await verifyCredentials(http, cfg.baseUrl, cfg.appId, cfg.appSecret);
      } catch (err) {
        if (err instanceof CredentialsRejectedError) throw new ConfigError(err.message);
        throw err;
      }
      const logger = larkLogger(ctx.log);
      api = new FeishuApi({ appId: cfg.appId, appSecret: cfg.appSecret, baseUrl: cfg.baseUrl, logger, http });
      const dispatcher = new EventDispatcher({ logger, loggerLevel: LoggerLevel.info }).register({
        "im.message.receive_v1": (data) => {
          handleEvent(ctx, data as MessageEvent).catch((err) => ctx.log.error("handle message failed", { error: errorText(err) }));
        },
      });
      const connection = await openConnection(ctx, dispatcher);
      ctx.log.info("feishu bot connected", { app_id: cfg.appId, domain: cfg.baseUrl });
      return {
        stop: () => {
          lifetime.abort();
          for (const entry of pending.values()) if (entry.timer) clearTimeout(entry.timer);
          pending.clear();
          connection.close();
        },
      };
    },

    async send(msg: SendRequest, ctx, signal): Promise<SendResult> {
      if (!api) throw new Error("feishu channel is not started");
      const fromRaw = msg.proactive ? undefined : targetFromRaw(msg.reply_to?.raw);
      const target: ReplyTarget = fromRaw ?? { chatId: msg.chat_id, chatType: "", messageId: "" };
      if (!target.chatId) throw new Error("no chat to send to");
      if (fromRaw) recallReaction(ctx, fromRaw.messageId);
      let last: string | undefined;
      if (msg.content) {
        cancelled(signal);
        last = await deliver(ctx, target, "post", buildPostContent(msg.content));
      }
      if (msg.media) {
        cancelled(signal);
        last = await sendMedia(ctx, target, msg.media, signal);
      }
      return last ? { platform_message_id: last } : {};
    },
  };
}
