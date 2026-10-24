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
  const hello = new Promise<void>((resolve) => {
    page.on("websocket", (ws) => {
      if (!new URL(ws.url()).pathname.endsWith("/api/v1/events")) return;
      ws.on("framereceived", (f) => {
        if (String(f.payload).includes('"hello"')) resolve();
      });
    });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Machines" })).toBeVisible();
  const empty = page.getByText("No machines yet");
  const rows = page.getByRole("row");
  await expect(empty.or(rows.first())).toBeVisible();

  // The shell's one stream: the Worker accepted the upgrade and sent a hello.
  await hello;

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /^Agents\b/ })
    .click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  // "No agents" on an empty roster, else "N agents in <ns> · K live".
  await expect(page.locator("[data-summary]")).toHaveText(
    /^(No agents|.*\d+ .*· \d+ live)$/s,
  );
  // Not paused, so the stream stayed up.
  await expect(page.getByText("Live updates paused.")).toHaveCount(0);

  expect(errors, "console errors and CSP violations").toEqual([]);
});
