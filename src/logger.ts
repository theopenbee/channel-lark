import type { Logger as LarkLogger } from "@larksuiteoapi/node-sdk";
import type { Logger } from "@theopenbee/channel-sdk";

const MAX_DEPTH = 4;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  return i >= 0 ? url.slice(0, i) : url;
}

function codeAndMsg(o: Record<string, unknown>): string[] {
  const parts: string[] = [];
  if (typeof o.code === "number" || typeof o.code === "string") parts.push(`code=${o.code}`);
  if (typeof o.msg === "string" && o.msg) parts.push(`msg=${o.msg}`);
  return parts;
}

function describeObject(o: Record<string, unknown>, isError: boolean): string {
  const parts: string[] = [];
  if (typeof o.message === "string" && o.message) parts.push(o.message);
  const config = o.config;
  if (isObject(config) && typeof config.url === "string") {
    const method = typeof config.method === "string" ? config.method.toUpperCase() + " " : "";
    parts.push(method + stripQuery(config.url));
  }
  const response = o.response;
  if (isObject(response)) {
    if (typeof response.status === "number") parts.push(`status=${response.status}`);
    if (isError && isObject(response.data)) parts.push(...codeAndMsg(response.data));
  }
  if (!isError) parts.push(...codeAndMsg(o));
  return parts.join(" ");
}

export function describeLogArgs(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH || value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((v) => describeLogArgs(v, depth + 1))
      .filter(Boolean)
      .join(" ");
  }
  if (isObject(value)) return describeObject(value, value instanceof Error);
  return "";
}

type Level = "debug" | "info" | "warn" | "error";

export function larkLogger(log: Logger): LarkLogger {
  const forward =
    (level: Level) =>
    (...args: unknown[]) => {
      const message = describeLogArgs(args).replace(/\s+/g, " ").trim();
      if (message) log[level](message, { source: "lark-sdk" });
    };
  return { error: forward("error"), warn: forward("warn"), info: forward("info"), debug: forward("debug"), trace: forward("debug") };
}
