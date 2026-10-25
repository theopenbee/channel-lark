import { LoggerLevel, WSClient, type Domain, type EventDispatcher, type HttpInstance, type Logger } from "@larksuiteoapi/node-sdk";

export interface Connection {
  close(): void;
}

export interface ConnectParams {
  appId: string;
  appSecret: string;
  domain: Domain | string;
  logger: Logger;
  http: HttpInstance;
  eventDispatcher: EventDispatcher;
  onReady(): void;
  onError(err: Error): void;
  onReconnecting(): void;
  onReconnected(): void;
}

export type Connector = (params: ConnectParams) => Connection;

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export const connectWebSocket: Connector = (p) => {
  const ws = new WSClient({
    appId: p.appId,
    appSecret: p.appSecret,
    domain: p.domain,
    logger: p.logger,
    loggerLevel: LoggerLevel.info,
    httpInstance: p.http,
    onReady: p.onReady,
    onError: p.onError,
    onReconnecting: p.onReconnecting,
    onReconnected: p.onReconnected,
  });
  ws.start({ eventDispatcher: p.eventDispatcher }).then(
    () => {
      if (ws.getConnectionStatus().state === "idle") p.onError(new Error("the Lark SDK refused to open the long connection"));
    },
    (err) => p.onError(asError(err)),
  );
  return { close: () => ws.close({ force: true }) };
};
