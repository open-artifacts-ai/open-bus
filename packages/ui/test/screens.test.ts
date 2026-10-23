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
