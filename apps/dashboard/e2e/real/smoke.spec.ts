// Read-only smoke against a real Worker (local `wrangler dev` or staging).
// Mutates nothing: no revoke, no approve. Safe on staging.
import { MeSchema } from "@ob/shared";
import { expect, test, watchErrors } from "./fixtures";

test("the owner is signed in: /api/v1/me answers 200 with the owner email", async ({
  signedIn: page,
}) => {
  const res = await page.request.get("/api/v1/me");
  expect(res.status()).toBe(200);
  const me = MeSchema.parse(await res.json());
  if (process.env.E2E_OWNER_EMAIL)
    expect(me.user.email).toBe(process.env.E2E_OWNER_EMAIL);
});

test("Machines shows its heading and either the empty state or rows; Agents shows its summary; the stream goes live with no console errors", async ({
  signedIn: page,
}) => {
  const errors = watchErrors(page);
  // The shell's one stream is live once the hub has sent hello and both snapshots.
  const seen = new Set<string>();
  const live = new Promise<void>((resolve) => {
    page.on("websocket", (ws) => {
      if (!new URL(ws.url()).pathname.endsWith("/api/v1/events")) return;
      ws.on("framereceived", (f) => {
        try {
          const { type } = JSON.parse(String(f.payload)) as { type?: string };
          if (type) seen.add(type);
        } catch {}
        if (["hello", "machines", "agents"].every((t) => seen.has(t)))
          resolve();
      });
    });
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Machines", exact: true, level: 1 }),
  ).toBeVisible();
  const empty = page.getByText("No machines yet");
  const rows = page.getByRole("row");
  await expect(empty.or(rows.first())).toBeVisible();
  await expect(page.getByText("Couldn't load machines")).toHaveCount(0);

  await Promise.race([
    live,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `stream never went live; frames seen: ${[...seen].join(", ") || "none"}`,
            ),
          ),
        15_000,
      ),
    ),
  ]);

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /^Agents\b/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true, level: 1 }),
  ).toBeVisible();
  // "No agents" on an empty roster, else "N agents in <ns> · K live".
  await expect(page.locator("[data-summary]")).toHaveText(
    /^(No agents|.*\d+ .*· \d+ live)$/s,
  );
  // Still live after a settle window: a drop right after hello would show here.
  await page.waitForTimeout(1_500);
  await expect(page.getByText("Live updates paused.")).toHaveCount(0);

  expect(errors, "console errors and CSP violations").toEqual([]);
});
