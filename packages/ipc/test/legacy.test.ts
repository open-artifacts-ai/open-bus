import { describe, expect, it } from "vitest";
import { forOldClient, LEGACY_KINDS, legacyKind } from "../src/index.ts";

describe("legacyKind (C23c, C26a)", () => {
  it("keeps the three kinds a 0.44.x client knows", () => {
    for (const k of LEGACY_KINDS) expect(legacyKind(k)).toBe(k);
  });

  it("shows omp, codex and later kinds as pi", () => {
    for (const k of ["omp", "codex", "zeta"]) expect(legacyKind(k)).toBe("pi");
  });

  it("keeps a codex row, so an old session can still address it by name", () => {
    const row = {
      name: "codex-1",
      namespace: "ns",
      kind: "codex",
      live: true,
      state: "live" as const,
      global: false,
    };
    expect(
      forOldClient({ v: 1, id: "1", type: "roster", agents: [row] }),
    ).toEqual({
      v: 1,
      id: "1",
      type: "roster",
      agents: [{ ...row, kind: "pi" }],
    });
  });
});
