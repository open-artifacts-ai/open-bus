// B4: the approval page stays under 8 KB (design D3), filled at max lengths.
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { LIMITS } from "@ob/shared";
import { expect, it } from "vitest";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import type { Env } from "../src/env.js";

const e = env as unknown as Env;
const ORIGIN = `https://${e.APP_HOST}`;
const bytes = (s: string) => new TextEncoder().encode(s).length;

async function render(label?: string): Promise<string> {
  const r = await SELF.fetch(`${ORIGIN}/device/code`, {
    method: "POST",
    body: JSON.stringify(label === undefined ? {} : { machine_label: label }),
  });
  expect(r.status).toBe(201);
  const code = (await r.json()) as { user_code: string };
  const cookie = `${sessionCookieName(e)}=${await signSession(e)}`;
  const page = await SELF.fetch(`${ORIGIN}/approve/${code.user_code}`, {
    headers: { cookie },
  });
  expect(page.status).toBe(200);
  return page.text();
}

it("renders the approval page under 8 KB", async () => {
  expect(bytes(await render())).toBeLessThan(8 * 1024);
});

it("stays under 8 KB with a max-length label", async () => {
  const label = "w".repeat(2 * LIMITS.maxLabelChars);
  const html = await render(label);
  expect(html).toContain(label);
  expect(bytes(html)).toBeLessThan(8 * 1024);
});
