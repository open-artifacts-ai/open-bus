import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { login } from "../src/commands/login.ts";

const home = () => mkdtempSync(join(tmpdir(), "ob-home-"));
const TOKEN = `ob_machine_${"a".repeat(32)}`;
const URI = "https://bus.test/approve/ABCD-2345";
const code = () =>
  Response.json({
    device_code: "dev-1",
    user_code: "ABCD-2345",
    verification_uri: URI,
    expires_in: 600,
    interval: 5,
  });

const hub = (tokens: unknown[]) => {
  const bodies: unknown[] = [];
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/device/code")) {
        bodies.push(JSON.parse(String(init?.body)));
        return code();
      }
      return Response.json(tokens.shift());
    },
  );
  return { fetch, bodies };
};

const base = (fetch: typeof globalThis.fetch) => ({
  hub: "https://bus.test",
  home: home(),
  label: "laptop",
  fetch,
  openBrowser: vi.fn(async () => true),
  sleep: vi.fn(async () => {}),
  print: vi.fn(),
  now: () => 0,
});

describe("device login", () => {
  it("polls through pending to approved and stores the token 0600", async () => {
    const h = hub([
      { status: "pending" },
      { status: "approved", token: TOKEN, machine_id: "m1" },
    ]);
    const a = base(h.fetch);
    const result = await login(a);
    expect(h.bodies[0]).toEqual({ machine_label: "laptop" });
    expect(a.openBrowser).toHaveBeenCalledWith(URI);
    expect(a.sleep).toHaveBeenCalledTimes(2);
    expect(result.machineToken).toBe(TOKEN);
    const file = join(result.home, "machine.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      hub: "https://bus.test",
      machine_id: "m1",
      label: "laptop",
      machine_token: TOKEN,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(result.home).mode & 0o777).toBe(0o700);
  });

  it("prints the URL and user code with noOpen", async () => {
    const a = base(
      hub([{ status: "approved", token: TOKEN, machine_id: "m1" }]).fetch,
    );
    await login({ ...a, noOpen: true });
    expect(a.openBrowser).not.toHaveBeenCalled();
    const out = a.print.mock.calls.flat().join("\n");
    expect(out).toContain(URI);
    expect(out).toContain("ABCD-2345");
  });

  it("throws on denied", async () => {
    const a = base(hub([{ status: "denied" }]).fetch);
    await expect(login(a)).rejects.toThrow(/denied/);
  });

  it("throws on expired", async () => {
    const a = base(hub([{ status: "expired" }]).fetch);
    await expect(login(a)).rejects.toThrow(/expired.*open-bus login/);
  });

  it("rejects a malformed token and stores nothing", async () => {
    const a = base(
      hub([{ status: "approved", token: "ob_machine_short", machine_id: "m1" }])
        .fetch,
    );
    await expect(login(a)).rejects.toThrow();
    expect(() => statSync(join(a.home, "machine.json"))).toThrow();
  });

  it("rejects a malformed response shape", async () => {
    const a = base(hub([{ nope: 1 }]).fetch);
    await expect(login(a)).rejects.toThrow();
  });

  it("times out when never approved", async () => {
    let t = 0;
    const a = {
      ...base(hub(Array(200).fill({ status: "pending" })).fetch),
      now: () => (t += 100_000),
    };
    await expect(login(a)).rejects.toThrow(/timed out/);
  });
});
