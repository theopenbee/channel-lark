import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFeishuChannel } from "../dist/feishu.js";
import { APP_ID, APP_SECRET } from "./fake-feishu.mjs";

export const FAST_TIMING = {
  connectTimeout: 2000,
  retryAttempts: 5,
  retryDelay: 5,
  reactionTimeout: 3000,
  recallWait: 1000,
  pendingTtl: 60_000,
};

export function fakeContext({ config = {}, language = "en", botName = "OpenBee" } = {}) {
  const mediaDir = mkdtempSync(join(tmpdir(), "feishu-media-"));
  const dispatched = [];
  const logs = [];
  let n = 0;
  const log = {};
  for (const level of ["debug", "info", "warn", "error"]) {
    log[level] = (message, fields) => logs.push({ level, message, fields });
  }
  const ctx = {
    channelId: "feishu",
    config,
    botName,
    language,
    dataDir: mediaDir,
    mediaDir,
    openbeeVersion: "test",
    dispatch: (m) => dispatched.push(m),
    migrateChat() {},
    saveMedia: async (data, ext) => {
      const suffix = ext ? (ext.startsWith(".") ? ext : "." + ext) : "";
      const path = join(mediaDir, `${Date.now()}-${n++}${suffix}`);
      writeFileSync(path, data);
      return path;
    },
    log,
  };
  return { ctx, dispatched, logs, mediaDir };
}

export function fakeConnector({ fail, failAfterReady } = {}) {
  const state = { params: undefined, closed: 0 };
  const connect = (params) => {
    state.params = params;
    setImmediate(() => {
      if (fail) params.onError(new Error(fail));
      else if (fail !== null) params.onReady();
      if (failAfterReady) setImmediate(() => params.onError(new Error(failAfterReady)));
    });
    return {
      close() {
        state.closed++;
      },
    };
  };
  return {
    connect,
    state,
    deliver(event) {
      return state.params.eventDispatcher.invoke(event, { needCheck: false });
    },
  };
}

export async function waitUntil(check, ms = 3000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export async function startChannel(t, fake, { config = {}, language, botName, timing = {}, connector = fakeConnector(), onFatal } = {}) {
  const channel = createFeishuChannel({ connect: connector.connect, timing: { ...FAST_TIMING, ...timing }, onFatal });
  const env = fakeContext({ config: { app_id: APP_ID, app_secret: APP_SECRET, domain: fake.url, ...config }, language, botName });
  const handle = await channel.start(env.ctx);
  t.after(() => handle?.stop?.());
  return { channel, handle, connector, ...env };
}

export function sendRequest(overrides = {}) {
  return {
    session_key: "feishu:oc_group:ou_user",
    chat_id: "oc_group",
    session_scope: "ou_user",
    proactive: false,
    ...overrides,
  };
}
