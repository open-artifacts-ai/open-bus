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

it("stays under 8 KB with a max-length plain label", async () => {
  const label = "w".repeat(2 * LIMITS.maxLabelChars);
  const html = await render(label);
  expect(html).toContain(label);
  expect(bytes(html)).toBeLessThan(8 * 1024);
});

/**
 * Worst case: the page budget for a label of 128 `"` (the most a valid label
 * can expand). MachineLabelSchema allows 2 * maxLabelChars = 128 UTF-16 units
 * and `"` escapes to `&quot;` (6 bytes; no unit expands more: a surrogate pair
 * is 4 UTF-8 bytes for 2 units). The label appears 4 times (title, client
 * line, heading, warning note); every other value is fixed length or
 * configuration. Design's 8 KB assumed a label of at most 64 plain bytes:
 * 8192 + 4 * (128 * 6 - 64) = 8192 + 2816 = 11008 bytes.
 */
export const WORST_CASE_BUDGET =
  8 * 1024 + 4 * (2 * LIMITS.maxLabelChars * 6 - 64);

it(`stays under ${WORST_CASE_BUDGET} bytes with the worst escaped label`, async () => {
  expect(WORST_CASE_BUDGET).toBe(11008);
  const html = await render('"'.repeat(2 * LIMITS.maxLabelChars));
  expect(html.split("&quot;".repeat(2 * LIMITS.maxLabelChars)).length - 1).toBe(
    4,
  );
  expect(bytes(html)).toBeLessThan(WORST_CASE_BUDGET);
});
