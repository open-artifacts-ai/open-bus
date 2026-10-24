import { describe, expect, it } from "vitest";
import { MachineLabelSchema } from "./refs.js";
import {
  AgentSchema,
  ApprovalBodySchema,
  DeviceCodeRequestSchema,
  MachineSchema,
  newMachineLabel,
} from "./rest.js";

const ISO = "2026-10-21T15:32:52.652Z";
const machine = {
  id: "7Yb3kQmZ1xRt9PvA",
  label: "MacBook",
  createdAt: ISO,
  lastUsed: ISO,
  revokedAt: null,
  connected: false,
};
const agent = {
  id: "8Zc4mRnA2ySu9QwB",
  namespace: "github.com/a/b",
  name: "x",
  kind: "pi",
  machineId: machine.id,
  machineLabel: "MacBook",
  global: false,
  state: "live",
  updatedAt: ISO,
};
const BAD = [
  "Mac‮kooB",
  "Mac\u0000Book",
  "Mac\nBook",
  "Mac​Book",
  "Mac⁦Book",
  " MacBook",
  "MacBook\t",
];

describe("adv F2.4: labels bypass MachineLabelSchema", () => {
  // Anonymous POST /device/code: label is rendered on the approval page.
  it("DeviceCodeRequestSchema.machine_label rejects control/bidi/zero-width", () => {
    for (const l of BAD)
      expect(
        DeviceCodeRequestSchema.safeParse({ machine_label: l }).success,
        JSON.stringify(l),
      ).toBe(false);
  });
  it("ApprovalBodySchema.label rejects control/bidi/zero-width and blank", () => {
    for (const l of [...BAD, "   "])
      expect(
        ApprovalBodySchema.safeParse({ decision: "approve", label: l }).success,
        JSON.stringify(l),
      ).toBe(false);
  });
  it("MachineSchema.label rejects control/bidi (dashboard trust boundary)", () => {
    for (const l of BAD)
      expect(
        MachineSchema.safeParse({ ...machine, label: l }).success,
        JSON.stringify(l),
      ).toBe(false);
  });
  it("AgentSchema.machineLabel is bounded, non-empty and clean", () => {
    expect(AgentSchema.safeParse({ ...agent, machineLabel: "" }).success).toBe(
      false,
    );
    expect(
      AgentSchema.safeParse({ ...agent, machineLabel: "x".repeat(100_000) })
        .success,
    ).toBe(false);
    for (const l of BAD)
      expect(
        AgentSchema.safeParse({ ...agent, machineLabel: l }).success,
        JSON.stringify(l),
      ).toBe(false);
  });
  // Spec: label <=128. MachineLabelSchema (used by the hello frame) allows 128, MachineSchema caps at 64.
  it("MachineSchema accepts every label MachineLabelSchema accepts (<=128)", () => {
    const l = "M".repeat(100);
    expect(MachineLabelSchema.safeParse(l).success).toBe(true);
    expect(MachineSchema.safeParse({ ...machine, label: l }).success).toBe(
      true,
    );
  });
  // newMachineLabel feeds the stored label from an anonymous hostname.
  it("newMachineLabel always returns a valid MachineLabelSchema value", () => {
    for (const h of [
      `${"a".repeat(63)} b`,
      `${"a".repeat(63)}\u{1F600}`,
      "‮evil",
      "Mac\u0000Book",
      "​",
    ]) {
      const out = newMachineLabel(h);
      expect(
        MachineLabelSchema.safeParse(out).success,
        JSON.stringify(out),
      ).toBe(true);
      expect(
        MachineSchema.safeParse({ ...machine, label: out }).success,
        JSON.stringify(out),
      ).toBe(true);
    }
  });
});

describe("newMachineLabel hostile inputs", () => {
  it("is always a valid label", () => {
    const parts = [
      "a",
      " ",
      "\u{1F600}",
      "‮",
      "\u0000",
      "​",
      "é",
      "é",
      "\n",
      "x".repeat(70),
      "\uD83D",
    ];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 500; i++) {
      let h = "";
      const n = rnd() % 8;
      for (let j = 0; j < n; j++) h += parts[rnd() % parts.length];
      const out = newMachineLabel(h);
      expect(MachineLabelSchema.safeParse(out).success, JSON.stringify(h)).toBe(
        true,
      );
      expect(out).toBe(out.normalize("NFC"));
    }
    expect(newMachineLabel("​")).toBe("machine");
  });
});
