import { describe, expect, it } from "vitest";
import { receiptText } from "../src/copy.ts";

// The lines are design/cli/transcript.md "Receipts", verbatim.
describe("receipt copy", () => {
  const t = (state: string, reason?: string, n?: number) =>
    receiptText(
      { state, reason } as Parameters<typeof receiptText>[0],
      "openbus-e0",
      n,
    );

  it("pending, delivered and expired", () => {
    expect(t("pending")).toBe(
      "○  Queued for openbus-e0. Not delivered yet; expires in 1 hour.",
    );
    expect(t("delivered")).toBe("✓  Delivered to openbus-e0.");
    expect(t("expired")).toBe(
      "×  Expired: openbus-e0 did not take it within 1 hour.",
    );
    expect(t("expired", "recipient_closed")).toBe(
      "×  Expired: openbus-e0 closed before it was delivered.",
    );
  });

  it("one refusal per pinned reason", () => {
    expect(t("refused", "unknown_agent")).toBe(
      "×  Refused (unknown_agent): no agent named openbus-e0 here.\n   Run list_agents to see who is in this namespace.",
    );
    expect(t("refused", "closed")).toBe(
      "×  Refused (closed): openbus-e0 did not accept it.\n   Send it again once the session is open, or message another agent.",
    );
    expect(t("refused", "inbox_full")).toBe(
      "×  Refused (inbox_full): openbus-e0 has 50 messages waiting.\n   Send again once some are delivered or expire.",
    );
    expect(t("refused", "too_large")).toBe(
      "×  Refused (too_large): the message is over 1 MB.\n   Send a shorter message.",
    );
    expect(t("refused", "other_namespace")).toBe(
      "×  Refused (other_namespace): openbus-e0 is in another namespace.\n   Message agents in this namespace only.",
    );
    expect(t("refused", "revoked")).toBe(
      "×  Refused (revoked): openbus-e0's machine was revoked.\n   Message another agent, or approve that machine again with npx open-bus login.",
    );
    expect(t("refused", "ambiguous", 2)).toBe(
      "×  Refused (ambiguous): openbus-e0 exists in 2 namespaces.\n   Send again with to_namespace set to one of them.",
    );
    expect(t("refused", "ambiguous")).toMatch(
      /^× {2}Refused \(ambiguous\): openbus-e0 exists in more than one namespace\.\n/,
    );
  });

  it("cuts a long name in the middle so the first line fits 80 columns", () => {
    const name = `${"a".repeat(40)}-${"z".repeat(23)}`;
    const line = receiptText(
      { state: "refused", reason: "other_namespace" },
      name,
    ).split("\n")[0];
    expect(line.length).toBe(80);
    expect(line).toMatch(
      /^× {2}Refused \(other_namespace\): a+…a*-?z+ is in another namespace\.$/,
    );
    expect(receiptText({ state: "delivered" }, "openbus-e0")).toBe(
      "✓  Delivered to openbus-e0.",
    );
    expect(receiptText({ state: "delivered" }, name)).toHaveLength(80);
  });
});
