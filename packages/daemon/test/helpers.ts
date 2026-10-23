import { WebSocketServer } from "ws";
import type { HubOptions } from "../src/hub.ts";

export const servers: { close: (cb: () => void) => void }[] = [];
export async function closeAll() {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
}
export async function wsServer(): Promise<{
  wss: WebSocketServer;
  url: string;
}> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  if (!wss.address())
    await new Promise<void>((r) => wss.once("listening", () => r()));
  return {
    wss,
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}/hub`,
  };
}
export function opts(url: string, over: Partial<HubOptions> = {}): HubOptions {
  return {
    url,
    token: "ob_machine_SECRETSECRETSECRET",
    label: "laptop",
    version: "0.1.0",
    sessions: () => ({ open: [], closed: [] }),
    onFrame: () => {},
    onRevoked: () => {},
    onOpen: () => {},
    backoffMs: () => 20,
    ...over,
  };
}
export const deliver = (msg_id: string) =>
  JSON.stringify({
    v: 1,
    id: "d1",
    type: "deliver",
    msg_id,
    to_ref: "a1",
    from_name: "x",
    namespace: "n",
    body: "hi",
  });
