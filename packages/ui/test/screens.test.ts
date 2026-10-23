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

  it("isolates every body machine_label in <bdi>", () => {
    const body = html
      .replace(/<!--.*?-->/s, "")
      .replace(/<title>.*?<\/title>/s, "");
    const all = body.match(/\{\{machine_label\}\}/g) ?? [];
    const isolated = body.match(/<bdi>\{\{machine_label\}\}<\/bdi>/g) ?? [];
    expect(all.length).toBeGreaterThan(0);
    expect(isolated.length).toBe(all.length);
  });
});

/** Every class token in a class="" attribute has a selector in the inline <style>. */
function undefinedClasses(page: string): string[] {
  const style = [...page.matchAll(/<style>(.*?)<\/style>/gs)]
    .map((m) => m[1])
    .join("");
  const tokens = new Set(
    [...page.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) =>
      m[1].split(/\s+/).filter(Boolean),
    ),
  );
  return [...tokens].filter((t) => {
    const sel = `.${t.replace(/[^\w-]/g, "\\$&")}`;
    // the selector must end there: next char is not part of a class name
    return !new RegExp(
      `${sel.replace(/[\\.[\]()*+?^$|{}]/g, "\\$&")}(?![\\w-])`,
    ).test(style);
  });
}

describe("design/screens/device-approval.html uses shadcn markup", () => {
  it("stays under 8 KB served: comment stripped, placeholders at max", () => {
    const max: Record<string, string> = {
      machine_label: "m".repeat(128),
      user_email: `${"u".repeat(242)}@example.com`,
      bus_host: "h".repeat(253),
      csrf_token: "c".repeat(64),
      client_version: "v".repeat(16),
      user_code: "XXXX-XXXX",
      form_action: "/approve/XXXX-XXXX",
      switch_url: "s".repeat(200),
    };
    const served = html
      .replace(/^(<!doctype html>\n)<!--.*?-->\n/s, "$1")
      .replace(/\{\{(\w+)\}\}/g, (_, k: string) => max[k]);
    expect(served).not.toMatch(/<!--|\{\{/);
    expect(new TextEncoder().encode(served).length).toBeLessThan(8192);
  });

  it("styles a link Button for the not-you state", () => {
    expect(html).toContain("a[data-slot=button]{text-decoration:none}");
  });

  it("renders a shadcn Card with shadcn Buttons", () => {
    expect(html).toMatch(/data-slot="card"/);
    for (const slot of [
      "card-header",
      "card-title",
      "card-content",
      "card-footer",
    ])
      expect(html).toContain(`data-slot="${slot}"`);
    expect(html.match(/data-slot="button"/g)?.length).toBe(2);
    expect(html).toMatch(
      /data-slot="button" data-variant="outline"[^>]*value="deny"|value="deny"[^>]*data-variant="outline"/s,
    );
  });

  it("defines every class it uses in the inline <style>", () => {
    expect(html).toMatch(/\sclass="/);
    expect(undefinedClasses(html)).toEqual([]);
  });

  it("isolates bus_host and user_email in <bdi>", () => {
    const body = html.replace(/<!--.*?-->/s, "");
    for (const p of ["bus_host", "user_email"]) {
      const all = body.match(new RegExp(`\\{\\{${p}\\}\\}`, "g")) ?? [];
      const iso =
        body.match(new RegExp(`<bdi>\\{\\{${p}\\}\\}</bdi>`, "g")) ?? [];
      expect(all.length).toBeGreaterThan(0);
      expect(iso.length).toBe(all.length);
    }
  });

  it("shows the user code in the anti-phishing note", () => {
    expect(html).toMatch(/role="note">(?:(?!<\/div>).)*\{\{user_code\}\}/s);
  });
});

const edgeFile = new URL(
  "../../../design/screens/edge-pages.html",
  import.meta.url,
);
const edge = readFileSync(edgeFile, "utf8");

describe("design/screens/edge-pages.html uses shadcn markup", () => {
  it("keeps the four states, each in a shadcn Card", () => {
    for (const s of ["expired", "approved", "denied", "not-you"])
      expect(edge).toContain(`data-state="${s}"`);
    expect(edge.match(/data-slot="card"/g)?.length).toBe(4);
    expect(edge).toMatch(
      /data-slot="button"[^>]*href="\{\{switch_url\}\}"|href="\{\{switch_url\}\}"[^>]*data-slot="button"/,
    );
  });

  it("defines every class it uses in the inline <style>", () => {
    expect(undefinedClasses(edge)).toEqual([]);
  });
});

const machinesFile = new URL(
  "../../../design/screens/machines.html",
  import.meta.url,
);
const machines = readFileSync(machinesFile, "utf8");
const rows = [...machines.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/gs)].map(
  (m) => m[0],
);

describe("design/screens/machines.html (D4)", () => {
  it("links the tokens and its generated Tailwind CSS", () => {
    expect(machines).toContain(
      '<link rel="stylesheet" href="../../packages/ui/src/tokens/tokens.css">',
    );
    expect(machines).toContain('<link rel="stylesheet" href="machines.css">');
    const css = readFileSync(
      new URL("../../../design/screens/machines.css", import.meta.url),
      "utf8",
    );
    expect(css).toMatch(/^\/\* Generated[\s\S]*build:screens/);
  });

  it("uses the shadcn primitives and the StatusBadge markup", () => {
    for (const slot of [
      "sidebar",
      "table",
      "table-row",
      "button",
      "dropdown-menu-content",
      "alert-dialog-content",
      "skeleton",
      "card",
      "avatar",
      "badge",
      "status-badge-dot",
    ])
      expect(machines).toContain(`data-slot="${slot}"`);
    expect(machines).toContain("data-sonner-toaster");
  });

  it("gives every live or offline row a visible Revoke, and revoked rows none", () => {
    const body = rows.filter((r) => r.includes('data-slot="table-cell"'));
    const real = body.filter((r) => !r.includes('data-slot="skeleton"'));
    expect(real.length).toBe(4);
    for (const r of real) {
      const revoked = r.includes('data-status="revoked"');
      expect(r.includes("data-revoke=")).toBe(!revoked);
      if (revoked) expect(r).toMatch(/>Revoked [A-Z][a-z]{2} \d{1,2}, \d{4}</);
    }
    // never hover-only
    expect(machines).not.toMatch(/data-revoke[^>]*(opacity-0|invisible)/);
  });

  it("names the machine in the confirm dialog, modal, with Cancel", () => {
    expect(machines).toMatch(/role="alertdialog" aria-modal="true"/);
    expect(machines).toMatch(
      /Revoke “<bdi data-confirm-label[^>]*>leo-macbook-pro<\/bdi>”\?/,
    );
    expect(machines).toContain(">Cancel</button>");
  });

  it("isolates machine labels in <bdi> and has no em dashes", () => {
    for (const label of ["leo-macbook-pro", "leo-mac-mini", "build-vm-01"]) {
      const shown = rows.join("").match(new RegExp(`>${label}<`, "g")) ?? [];
      const iso =
        rows.join("").match(new RegExp(`<bdi[^>]*>${label}</bdi>`, "g")) ?? [];
      expect(shown.length).toBeGreaterThan(0);
      expect(iso.length).toBe(shown.length);
    }
    expect(machines).not.toContain("—");
  });
});
