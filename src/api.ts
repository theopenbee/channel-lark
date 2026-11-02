import type { Readable } from "node:stream";

import { Client, DefaultCache, Domain, LoggerLevel, defaultHttpInstance, type HttpInstance, type HttpRequestOptions, type Logger } from "@larksuiteoapi/node-sdk";

import { errorText } from "./helpers.js";

export const REQUEST_TIMEOUT = 120_000;
const ERROR_BODY_LIMIT = 64 * 1024;
const RESOURCE_SIZE_LIMIT_CODE = 234037;

export const FEISHU_BASE_URL = "https://open.feishu.cn";
export const LARK_BASE_URL = "https://open.larksuite.com";

export class FeishuError extends Error {
  constructor(
    readonly op: string,
    readonly code: number,
    readonly msg: string,
  ) {
    super(`${op} failed: code=${code} msg=${msg}`);
    this.name = "FeishuError";
  }
}

export class ResourceTooLargeError extends Error {
  constructor(maxSize: number) {
    super(`resource too large: exceeds ${maxSize} bytes`);
    this.name = "ResourceTooLargeError";
  }
}

export function isRetryableDownload(err: unknown): boolean {
  if (err instanceof ResourceTooLargeError) return false;
  return !(err instanceof FeishuError && err.code === RESOURCE_SIZE_LIMIT_CODE);
}

export class CredentialsRejectedError extends Error {
  constructor(
    readonly code: number,
    readonly msg: string,
  ) {
    super(`Feishu rejected the app credentials: ${msg} (code ${code})`);
    this.name = "CredentialsRejectedError";
  }
}

export function resolveDomain(domain: string): string | undefined {
  const value = domain.trim();
  if (!value || value.toLowerCase() === "feishu") return FEISHU_BASE_URL;
  if (value.toLowerCase() === "lark") return LARK_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return value.replace(/\/+$/, "");
}

export function sdkDomain(baseUrl: string): Domain | string {
  if (baseUrl === FEISHU_BASE_URL) return Domain.Feishu;
  if (baseUrl === LARK_BASE_URL) return Domain.Lark;
  return baseUrl;
}

export function httpWithTimeout(timeout: number, base: HttpInstance = defaultHttpInstance as unknown as HttpInstance): HttpInstance {
  const withTimeout = <D>(opts?: HttpRequestOptions<D>): HttpRequestOptions<D> => ({ ...opts, timeout: opts?.timeout ?? timeout });
  return {
    request<T = any, R = T, D = any>(opts: HttpRequestOptions<D>): Promise<R> {
      return base.request<T, R, D>(withTimeout(opts));
    },
    get<T = any, R = T, D = any>(url: string, opts?: HttpRequestOptions<D>): Promise<R> {
      return base.get<T, R, D>(url, withTimeout(opts));
    },
    delete<T = any, R = T, D = any>(url: string, opts?: HttpRequestOptions<D>): Promise<R> {
      return base.delete<T, R, D>(url, withTimeout(opts));
    },
    head<T = any, R = T, D = any>(url: string, opts?: HttpRequestOptions<D>): Promise<R> {
      return base.head<T, R, D>(url, withTimeout(opts));
    },
    options<T = any, R = T, D = any>(url: string, opts?: HttpRequestOptions<D>): Promise<R> {
      return base.options<T, R, D>(url, withTimeout(opts));
    },
    post<T = any, R = T, D = any>(url: string, data?: D, opts?: HttpRequestOptions<D>): Promise<R> {
      return base.post<T, R, D>(url, data, withTimeout(opts));
    },
    put<T = any, R = T, D = any>(url: string, data?: D, opts?: HttpRequestOptions<D>): Promise<R> {
      return base.put<T, R, D>(url, data, withTimeout(opts));
    },
    patch<T = any, R = T, D = any>(url: string, data?: D, opts?: HttpRequestOptions<D>): Promise<R> {
      return base.patch<T, R, D>(url, data, withTimeout(opts));
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReadable(value: unknown): value is Readable {
  return isObject(value) && typeof value.pipe === "function" && typeof value.on === "function";
}

export async function readLimited(stream: Readable, max: number, tooLarge: () => Error): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > max) throw tooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function errorBody(data: unknown): Promise<Record<string, unknown> | undefined> {
  if (isReadable(data)) {
    try {
      const buf = await readLimited(data, ERROR_BODY_LIMIT, () => new Error("error body too large"));
      return parseJsonObject(buf.toString("utf8"));
    } catch {
      return undefined;
    }
  }
  if (typeof data === "string") return parseJsonObject(data);
  if (Buffer.isBuffer(data)) return parseJsonObject(data.toString("utf8"));
  return isObject(data) ? data : undefined;
}

interface HttpFailure {
  status?: number;
  body?: Record<string, unknown>;
  message: string;
}

async function httpFailure(err: unknown): Promise<HttpFailure> {
  const response = isObject(err) && isObject(err.response) ? err.response : undefined;
  return {
    status: typeof response?.status === "number" ? response.status : undefined,
    body: response ? await errorBody(response.data) : undefined,
    message: errorText(err),
  };
}

async function toFeishuError(op: string, err: unknown): Promise<Error> {
  if (err instanceof FeishuError) return err;
  const failure = await httpFailure(err);
  if (failure.body && typeof failure.body.code === "number") {
    return new FeishuError(op, failure.body.code, typeof failure.body.msg === "string" ? failure.body.msg : "");
  }
  if (failure.status !== undefined) return new Error(`${op} failed: HTTP ${failure.status}`);
  return new Error(`${op} failed: ${failure.message}`);
}

async function call<T>(op: string, fn: () => Promise<T>): Promise<T> {
  let res: T;
  try {
    res = await fn();
  } catch (err) {
    throw await toFeishuError(op, err);
  }
  if (isObject(res) && typeof res.code === "number" && res.code !== 0) {
    throw new FeishuError(op, res.code, typeof res.msg === "string" ? res.msg : "");
  }
  return res;
}

export async function verifyCredentials(http: HttpInstance, baseUrl: string, appId: string, appSecret: string): Promise<void> {
  let body: unknown;
  try {
    body = await http.post(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, { app_id: appId, app_secret: appSecret });
  } catch (err) {
    const failure = await httpFailure(err);
    const code = failure.body?.code;
    if (failure.status !== undefined && failure.status < 500 && typeof code === "number" && code !== 0) {
      throw new CredentialsRejectedError(code, typeof failure.body?.msg === "string" ? failure.body.msg : "");
    }
    throw new Error(`verify credentials failed: ${failure.status !== undefined ? `HTTP ${failure.status}` : failure.message}`);
  }
  if (!isObject(body)) throw new Error("verify credentials failed: unexpected response");
  if (typeof body.code === "number" && body.code !== 0) {
    throw new CredentialsRejectedError(body.code, typeof body.msg === "string" ? body.msg : "");
  }
  if (typeof body.tenant_access_token !== "string" || !body.tenant_access_token) {
    throw new Error("verify credentials failed: no tenant_access_token in response");
  }
}

export interface ApiOptions {
  appId: string;
  appSecret: string;
  baseUrl: string;
  logger: Logger;
  http: HttpInstance;
}

export class FeishuApi {
  readonly client: Client;

  constructor(opts: ApiOptions) {
    this.client = new Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: sdkDomain(opts.baseUrl),
      logger: opts.logger,
      loggerLevel: LoggerLevel.info,
      httpInstance: opts.http,
      cache: new DefaultCache(),
    });
  }

  async createMessage(chatId: string, msgType: string, content: string): Promise<string | undefined> {
    const res = await call("create message", () =>
      this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: msgType, content },
      }),
    );
    return res.data?.message_id;
  }

  async replyMessage(messageId: string, msgType: string, content: string): Promise<string | undefined> {
    const res = await call("reply message", () =>
      this.client.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: msgType, content },
      }),
    );
    return res.data?.message_id;
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    const res = await call("add reaction", () =>
      this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      }),
    );
    return res.data?.reaction_id;
  }

  async deleteReaction(messageId: string, reactionId: string): Promise<void> {
    await call("recall reaction", () =>
      this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      }),
    );
  }

  async uploadImage(data: Buffer): Promise<string> {
    const res = await call("upload image", () => this.client.im.image.create({ data: { image_type: "message", image: data } }));
    if (!res?.image_key) throw new Error("upload image failed: no image_key in response");
    return res.image_key;
  }

  async uploadFile(data: Buffer, fileType: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream", fileName: string): Promise<string> {
    const res = await call("upload file", () =>
      this.client.im.file.create({ data: { file_type: fileType, file_name: fileName, file: data } }),
    );
    if (!res?.file_key) throw new Error("upload file failed: no file_key in response");
    return res.file_key;
  }

  async downloadResource(messageId: string, fileKey: string, type: string, maxSize: number): Promise<Buffer> {
    let stream: Readable;
    let contentType = "";
    try {
      const res = await this.client.im.messageResource.get({
        params: { type },
        path: { message_id: messageId, file_key: fileKey },
      });
      stream = res.getReadableStream();
      const header: unknown = isObject(res.headers) ? res.headers["content-type"] : undefined;
      if (typeof header === "string") contentType = header;
    } catch (err) {
      throw await toFeishuError("download resource", err);
    }
    let data: Buffer;
    try {
      data = await readLimited(stream, maxSize, () => new ResourceTooLargeError(maxSize));
    } catch (err) {
      stream.destroy();
      if (err instanceof ResourceTooLargeError) throw err;
      throw new Error(`read resource: ${errorText(err)}`);
    }
    if (contentType.includes("application/json")) {
      const body = parseJsonObject(data.toString("utf8"));
      if (body && typeof body.code === "number" && body.code !== 0) {
        throw new FeishuError("download resource", body.code, typeof body.msg === "string" ? body.msg : "");
      }
    }
    return data;
  }
}
