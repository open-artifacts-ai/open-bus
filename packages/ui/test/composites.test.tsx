// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, render } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { type Status, StatusBadge } from "../src/composites";

afterEach(cleanup);

const WORDS: Record<Status, string> = {
  live: "Live",
  offline: "Offline",
  revoked: "Revoked",
  queued: "Queued",
  closed: "Closed",
};

const badge = (status: Status) => {
  const { container } = render(<StatusBadge status={status} />);
  const el = container.firstElementChild as HTMLElement;
  const dot = el.querySelector('[data-slot="status-badge-dot"]') as Element;
  return { el, dot };
};

describe("StatusBadge", () => {
  for (const [status, word] of Object.entries(WORDS) as [Status, string][]) {
    it(`${status} renders a shadcn Badge with its word and a 6px dot`, () => {
      const { el, dot } = badge(status);
      expect(el.dataset.slot).toBe("badge");
      expect(el.dataset.status).toBe(status);
      expect(el.textContent).toBe(word);
      expect(dot).not.toBeNull();
      expect(dot.getAttribute("aria-hidden")).toBe("true");
      expect(dot.getAttribute("class")).toContain("size-1.5");
      expect(dot.getAttribute("class")).toContain("rounded-full");
    });
  }

  it("never relies on color alone: every status has its own word", () => {
    const words = (Object.keys(WORDS) as Status[]).map(
      (s) => badge(s).el.textContent,
    );
    expect(new Set(words).size).toBe(words.length);
    for (const w of words) expect(w?.trim().length).toBeGreaterThan(0);
  });

  it("uses the state tokens, with a hollow dot only for revoked", () => {
    const cls = (s: Status) => badge(s).el.className;
    const dot = (s: Status) => badge(s).dot.getAttribute("class") as string;
    expect(cls("live")).toContain("bg-(--ob-success-soft)");
    expect(cls("live")).toContain("text-(--ob-success-fg)");
    expect(cls("revoked")).toContain("bg-(--ob-danger-soft)");
    expect(cls("revoked")).toContain("text-(--ob-danger)");
    expect(cls("queued")).toContain("bg-(--ob-warning-soft)");
    expect(cls("queued")).toContain("text-(--ob-warning)");
    for (const s of ["offline", "closed"] as const)
      expect(dot(s)).toContain("bg-(--ob-border-strong)");
    expect(dot("revoked")).toContain("bg-transparent");
    expect(dot("revoked")).toContain("border-current");
    for (const s of ["live", "offline", "queued", "closed"] as const)
      expect(dot(s)).not.toContain("bg-transparent");
  });

  it("passes className and props through", () => {
    const { container } = render(
      <StatusBadge status="live" className="ml-2" title="since 10:02" />,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("ml-2");
    expect(el.title).toBe("since 10:02");
  });

  it("has no axe violations", async () => {
    render(
      <main>
        {(Object.keys(WORDS) as Status[]).map((s) => (
          <StatusBadge key={s} status={s} />
        ))}
      </main>,
    );
    const result = await axe.run(document.body);
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("@ob/ui/composites", () => {
  it("is its own export", () => {
    const pkg = JSON.parse(
      readFileSync(`${import.meta.dirname}/../package.json`, "utf8"),
    );
    expect(pkg.exports["./composites"]).toBe("./src/composites/index.ts");
  });

  it("is scanned by the shadcn theme, so apps get its classes", () => {
    const theme = readFileSync(
      `${import.meta.dirname}/../src/shadcn/theme.css`,
      "utf8",
    );
    expect(theme).toMatch(/@source "\.\.\/composites";/);
  });
});
