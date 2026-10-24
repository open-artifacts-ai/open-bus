import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { excerptOf, receiptText } from "../src/copy.ts";

const Q = "Can you regenerate the API reference pag…";
const TRANSCRIPT = readFileSync(
  new URL("../../../design/cli/transcript.md", import.meta.url),
  "utf8",
);

/** The transcript's Receipts code blocks, colour tags removed, one string per notice. */
function transcriptNotices(): string[] {
  const section =
    (TRANSCRIPT.split("\n## Receipts")[1] ?? "").split("\n## ")[0] ?? "";
  const blocks = [...section.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]);
  return blocks
    .flatMap((b) =>
      b
        .replace(/\[\[\/?[a-z]+\]\]/g, "")
        .split(/\n(?=[○✓×])/)
        .map((s) => s.trimEnd()),
    )
    .filter(Boolean);
}

describe("receipt copy", () => {
  const t = (state: string, reason?: string, n?: number, to = "openbus-e0") =>
    receiptText(
      { state, reason } as Parameters<typeof receiptText>[0],
      to,
      n,
      Q,
    );

  it("pending and delivered", () => {
    expect(receiptText({ state: "pending" }, "openbus-e0")).toBe(
      "○  Queued for openbus-e0. Not delivered yet; expires in 1 hour.",
    );
    expect(receiptText({ state: "delivered" }, "openbus-e0")).toBe(
      "✓  Delivered to openbus-e0.",
    );
  });

  it("every notice in the transcript renders word for word", () => {
    const want = transcriptNotices();
    const got = [
      t("pending"),
      t("delivered"),
      t("expired"),
      t("expired", "recipient_closed"),
      t("refused", "unknown_agent", undefined, "openbus-qa"),
      t("refused", "closed"),
      t("refused", "inbox_full"),
      t("refused", "too_large"),
      t("refused", "other_namespace"),
      t("refused", "revoked"),
      t("refused", "ambiguous", 2, "docs-writer"),
    ];
    expect(got).toEqual(want);
  });

  it("an expired notice moves the quote down when line 1 would pass 80 columns", () => {
    const long = excerptOf("x".repeat(60)) as string;
    const s = receiptText({ state: "expired" }, "openbus-e0", undefined, long);
    // The quote and its tail fit on their own line.
    expect(s).toBe(
      `×  Expired: your message to openbus-e0,\n   "${long}", was not taken within 1 hour.`,
    );
    // Every line after the first is indented three spaces, the quote included.
    expect(
      s
        .split("\n")
        .slice(1)
        .every((l) => l.startsWith("   ") && l[3] !== " "),
    ).toBe(true);
    for (const l of s.split("\n")) expect(l.length).toBeLessThanOrEqual(80);
  });

  it("moves the tail down too when the quote's line would pass 80 columns", () => {
    const long = excerptOf("x".repeat(60)) as string;
    const s = receiptText(
      { state: "expired", reason: "recipient_closed" },
      "openbus-e0",
      undefined,
      long,
    );
    expect(s).toBe(
      `×  Expired: your message to openbus-e0,\n   "${long}",\n   was not delivered because openbus-e0 closed first.`,
    );
  });

  it("keeps the quote on line 1 when it fits, the tail below", () => {
    expect(receiptText({ state: "expired" }, "e0", undefined, "hi")).toBe(
      `×  Expired: your message to e0, "hi",\n   was not taken within 1 hour.`,
    );
    expect(
      receiptText(
        { state: "refused", reason: "closed" },
        "e0",
        undefined,
        "hi",
      ),
    ).toBe(
      `×  Refused (closed): your message to e0, "hi",\n   was not delivered.\n   Send it again once the session is open, or message another agent.`,
    );
  });

  it("without an excerpt (a legacy entry) the quote is omitted", () => {
    expect(receiptText({ state: "expired" }, "peer")).toBe(
      "×  Expired: your message to peer was not taken within 1 hour.",
    );
    expect(
      receiptText({ state: "expired", reason: "recipient_closed" }, "peer"),
    ).toBe(
      "×  Expired: your message to peer was not delivered because peer closed first.",
    );
    expect(receiptText({ state: "refused", reason: "closed" }, "peer")).toBe(
      "×  Refused (closed): your message to peer was not delivered.\n   Send it again once the session is open, or message another agent.",
    );
  });

  it("an unnamed ambiguity count says more than one namespace", () => {
    expect(t("refused", "ambiguous")).toContain(
      "That name exists in more than one namespace.",
    );
  });

  it("cuts a long name in the middle so no line passes 80 columns", () => {
    const name = `${"a".repeat(60)}-${"z".repeat(30)}`;
    for (const r of [
      { state: "refused", reason: "other_namespace" },
      { state: "expired" },
      { state: "expired", reason: "recipient_closed" },
    ] as const)
      for (const l of receiptText(r, name, undefined, Q).split("\n"))
        expect(l.length).toBeLessThanOrEqual(80);
    expect(receiptText({ state: "delivered" }, name)).toHaveLength(80);
  });
});

describe("excerptOf", () => {
  it("keeps a short body whole, with no ellipsis", () => {
    expect(excerptOf("hello there")).toBe("hello there");
    expect(excerptOf("x".repeat(40))).toBe("x".repeat(40));
  });
  it("cuts at 40 characters and appends an ellipsis", () => {
    expect(excerptOf("x".repeat(41))).toBe(`${"x".repeat(40)}…`);
    expect(
      excerptOf("Can you regenerate the API reference for the docs site?"),
    ).toBe("Can you regenerate the API reference for…");
  });
  it("never splits a surrogate pair at the boundary", () => {
    expect(excerptOf(`${"x".repeat(39)}😀tail`)).toBe(`${"x".repeat(39)}😀…`);
    expect(excerptOf(`${"x".repeat(40)}😀`)).toBe(`${"x".repeat(40)}…`);
    expect(excerptOf("😀".repeat(41))).toBe(`${"😀".repeat(40)}…`);
  });
  it("collapses whitespace and newlines to single spaces and trims", () => {
    expect(excerptOf("  a\n\n b\t\tc \r\n d  ")).toBe("a b c d");
  });
  it("strips terminal controls", () => {
    expect(excerptOf("a\x1b]52;c;cHduZWQ=\x07b\x1b[31mc")).toBe("abc");
  });
  it("cannot break the quoting", () => {
    expect(excerptOf('say "hi" now')).not.toContain('"');
  });
  it("is undefined when nothing visible is left", () => {
    expect(excerptOf(" \n\t ")).toBeUndefined();
    expect(excerptOf("\x1b[31m")).toBeUndefined();
  });
});
