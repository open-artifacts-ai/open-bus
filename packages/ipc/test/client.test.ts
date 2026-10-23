import { describe, expect, it } from "vitest";
import { connectDaemon } from "../src/client.ts";
import { fakeDaemon, hello, tmpSock, welcomeLine, within } from "./helpers.ts";

const deliverLine = (msg_id: string) =>
  `${JSON.stringify({ v: 1, id: "0", type: "deliver", msg_id, from_name: "peer", namespace: "n", body: "hi" })}\n`;

describe("client", () => {
  it("a deliver in the same chunk as the welcome is not dropped", async () => {
    const path = tmpSock();
    await fakeDaemon(path, (sock, l) => {
      if (l.type === "hello") sock.write(welcomeLine() + deliverLine("m1"));
    });
    const c = await connectDaemon({ path, hello: hello() });
    const got = new Promise((r) => c.onDeliver((f) => r(f.msg_id)));
    expect(await within(got, 300)).toBe("m1");
    c.close();
  });

  it("a throwing onDeliver callback does not tear down the daemon connection", async () => {
    const path = tmpSock();
    await fakeDaemon(path, (sock, l) => {
      if (l.type === "hello") sock.write(welcomeLine());
      if (l.type === "self") {
        sock.write(deliverLine("m2"));
        setTimeout(
          () =>
            sock.write(
              `${JSON.stringify({ v: 1, id: l.id, type: "agent", agent: null })}\n`,
            ),
          50,
        );
      }
    });
    const c = await connectDaemon({ path, hello: hello() });
    c.onDeliver(() => {
      throw new Error("adapter bug");
    });
    const r = await c.request({ type: "self" }).catch((e) => e);
    expect(r).toMatchObject({ type: "agent" });
    expect(c.state).toBe("open");
  });

  it("delivers buffered before onDeliver registers are flushed in order", async () => {
    const path = tmpSock();
    await fakeDaemon(path, (sock, l) => {
      if (l.type === "hello")
        sock.write(welcomeLine() + deliverLine("a") + deliverLine("b"));
    });
    const c = await connectDaemon({ path, hello: hello() });
    await new Promise((r) => setTimeout(r, 30));
    const seen: string[] = [];
    c.onDeliver((f) => seen.push(f.msg_id));
    expect(seen).toEqual(["a", "b"]);
    c.close();
  });

  it("a throwing onDeliver is reported to onError", async () => {
    const path = tmpSock();
    await fakeDaemon(path, (sock, l) => {
      if (l.type === "hello") sock.write(welcomeLine() + deliverLine("a"));
    });
    const errors: unknown[] = [];
    const c = await connectDaemon({
      path,
      hello: hello(),
      onError: (e) => errors.push(e),
    });
    c.onDeliver(() => {
      throw new Error("adapter bug");
    });
    expect(errors).toHaveLength(1);
    expect(c.state).toBe("open");
    c.close();
  });
});
