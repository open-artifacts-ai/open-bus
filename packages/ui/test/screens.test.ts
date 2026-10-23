import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const file = new URL(
  "../../../design/screens/device-approval.html",
  import.meta.url,
);
const html = readFileSync(file, "utf8");

describe("design/screens/device-approval.html is the Worker's template", () => {
  it("is under 8 KB", () => {
    expect(statSync(file).size).toBeLessThan(8192);
  });

  it("has no JavaScript and no external requests", () => {
    expect(html).not.toMatch(/<script|javascript:/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/@import|url\(/);
  });

  it("offers exactly the approved placeholder set", () => {
    const used = [
      ...new Set([...html.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])),
    ].sort();
    expect(used).toEqual([
      "bus_host",
      "client_version",
      "csrf_token",
      "form_action",
      "machine_label",
      "switch_url",
      "user_code",
      "user_email",
    ]);
  });

  it("posts an approve or deny decision with CSRF", () => {
    expect(html).toMatch(/method="post" action="\{\{form_action\}\}"/);
    expect(html).toMatch(/name="csrf" value="\{\{csrf_token\}\}"/);
    expect(html).toMatch(/name="decision" value="deny"/);
    expect(html).toMatch(/name="decision" value="approve"/);
  });

  it("states its own contract in the header comment", () => {
    expect(html).toMatch(/HTML-escape every value/);
    expect(html).toMatch(/prefers-color-scheme only/);
  });
});
