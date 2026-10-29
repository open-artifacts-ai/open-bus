import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  currentOf,
  generateCardKey,
  kidFor,
  kidTime,
  publicOf,
} from "../src/card-key.ts";
import { run } from "../src/index.ts";
import { secrets } from "../src/steps/secrets.ts";
import { FLAGS, ROOT } from "./fakes.ts";
import { SEEDED, world } from "./world.ts";

const NOW = Date.parse("2026-10-29T15:00:00Z");
const H = 3600_000;
const ALL = [
  "ACCESS_CLIENT_SECRET",
  "SESSION_SECRET",
  "CARD_SIGNING_KEY",
  "CARD_OWNER_SALT",
];
const ROTATE = [...FLAGS, "--rotate-card-key"];

/** A JWKS whose current key was made `hoursAgo` hours before NOW. */
const jwksAt = (hoursAgo: number) => ({
  keys: [
    {
      kty: "OKP",
      crv: "Ed25519",
      x: "x-current",
      kid: kidFor(NOW - hoursAgo * H),
      alg: "EdDSA",
    },
    // An older previous key: never picked as current.
    {
      kty: "OKP",
      crv: "Ed25519",
      x: "x-older",
      kid: kidFor(NOW - 500 * H),
      alg: "EdDSA",
    },
  ],
});

const bulkOf = (c: ReturnType<typeof world>) =>
  c.wrangler("secret").filter((x) => x.args[2] === "bulk");
const payloadOf = (c: ReturnType<typeof world>) =>
  JSON.parse(bulkOf(c)[0]?.input ?? "{}") as Record<string, string>;
const at = (c: ReturnType<typeof world>) => {
  c.deps.now = () => NOW;
  return c;
};

describe("card keys (I11)", () => {
  it("generates an Ed25519 private JWK with a timestamped kid that signs and verifies", async () => {
    const k = await generateCardKey(NOW);
    expect(k).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA" });
    expect(k.kid).toMatch(/^ob-20261029T150000Z-[0-9a-f]{6}$/);
    expect(kidTime(k.kid)).toBe(NOW);
    const priv = await webcrypto.subtle.importKey(
      "jwk",
      { kty: k.kty, crv: k.crv, x: k.x, d: k.d },
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const pub = await webcrypto.subtle.importKey(
      "jwk",
      { kty: k.kty, crv: k.crv, x: k.x },
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const msg = new TextEncoder().encode("card");
    const sig = await webcrypto.subtle.sign({ name: "Ed25519" }, priv, msg);
    expect(
      await webcrypto.subtle.verify({ name: "Ed25519" }, pub, sig, msg),
    ).toBe(true);
  });

  it("the public half has no d", async () => {
    const k = await generateCardKey(NOW);
    expect(publicOf(k)).not.toHaveProperty("d");
    expect(JSON.stringify(publicOf(k))).not.toContain(k.d);
  });

  it("currentOf picks the newest timestamped Ed25519 key and ignores the rest", () => {
    expect(currentOf(jwksAt(30))?.x).toBe("x-current");
    expect(
      currentOf({ keys: [{ kty: "RSA", kid: kidFor(NOW) }, { x: "y" }] }),
    ).toBeUndefined();
    expect(currentOf({})).toBeUndefined();
    expect(kidTime("not-a-kid")).toBeUndefined();
  });

  it("a Worker without card secrets gets CARD_SIGNING_KEY and CARD_OWNER_SALT in the same bulk, on stdin", async () => {
    const c = at(
      world({
        secrets: ["ACCESS_CLIENT_SECRET", "SESSION_SECRET"],
        state: SEEDED,
      }),
    );
    expect(await run(FLAGS, c.deps, ROOT, [secrets])).toBe(0);
    expect(bulkOf(c)).toHaveLength(1);
    const p = payloadOf(c);
    expect(Object.keys(p).sort()).toEqual([
      "CARD_OWNER_SALT",
      "CARD_SIGNING_KEY",
    ]);
    expect(p.CARD_OWNER_SALT).toMatch(/^[A-Za-z0-9_-]{48}$/);
    const key = JSON.parse(p.CARD_SIGNING_KEY);
    expect(key).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA" });
    expect(typeof key.d).toBe("string");
    for (const x of c.calls) {
      expect(x.args.join(" ")).not.toContain(key.d);
      expect(x.args.join(" ")).not.toContain(p.CARD_OWNER_SALT);
    }
    expect(c.out()).not.toContain(key.d);
    expect(c.out()).not.toContain(p.CARD_OWNER_SALT);
    expect(c.lines().at(-1).message).toContain(
      "set CARD_SIGNING_KEY, CARD_OWNER_SALT",
    );
  });

  it("never replaces an existing CARD_SIGNING_KEY without --rotate-card-key", async () => {
    const c = at(world({ secrets: [...ALL], state: SEEDED }));
    expect(await run(FLAGS, c.deps, ROOT, [secrets])).toBe(0);
    expect(bulkOf(c)).toEqual([]);
  });

  it("never rotates an existing CARD_OWNER_SALT, under every flag", async () => {
    for (const argv of [FLAGS, ROTATE, [...ROTATE, "--force"]]) {
      const c = at(
        world({ secrets: [...ALL], state: SEEDED, jwks: jwksAt(0) }),
      );
      await run(argv, c.deps, ROOT, [secrets]);
      for (const b of bulkOf(c))
        expect(Object.keys(JSON.parse(b.input ?? "{}"))).not.toContain(
          "CARD_OWNER_SALT",
        );
    }
  });

  it("--check reports the missing card secrets as todo, naming them", async () => {
    const c = at(
      world({
        secrets: ["ACCESS_CLIENT_SECRET", "SESSION_SECRET", "CARD_OWNER_SALT"],
        state: SEEDED,
      }),
    );
    expect(await run([...FLAGS, "--check"], c.deps, ROOT, [secrets])).toBe(2);
    expect(c.lines().at(-1)).toMatchObject({
      step: "secrets",
      status: "todo",
      message: "todo; adds CARD_SIGNING_KEY",
    });
    expect(bulkOf(c)).toEqual([]);
  });

  it("--check names nothing when a non-card secret is missing", async () => {
    const c = at(world({ secrets: ["SESSION_SECRET"], state: SEEDED }));
    await run([...FLAGS, "--check"], c.deps, ROOT, [secrets]);
    expect(c.lines().at(-1)).toMatchObject({ status: "todo", message: "todo" });
  });
});

describe("--rotate-card-key (I11)", () => {
  it("reads the current key from the JWKS and puts a new key plus the old public half as _PREV, in one bulk", async () => {
    const jwks = jwksAt(30);
    const c = at(world({ secrets: [...ALL], state: SEEDED, jwks }));
    expect(await run(ROTATE, c.deps, ROOT, [secrets])).toBe(0);
    expect(bulkOf(c)).toHaveLength(1);
    const p = payloadOf(c);
    expect(Object.keys(p).sort()).toEqual([
      "CARD_SIGNING_KEY",
      "CARD_SIGNING_KEY_PREV",
    ]);
    const prev = JSON.parse(p.CARD_SIGNING_KEY_PREV);
    expect(prev).toEqual(jwks.keys[0]);
    expect(prev).not.toHaveProperty("d");
    const next = JSON.parse(p.CARD_SIGNING_KEY);
    expect(next.x).not.toBe("x-current");
    expect(kidTime(next.kid)).toBe(NOW);
    expect(c.lines().at(-1).message).toContain("stays published as previous");
  });

  it("refuses within 24 h of the current kid, naming when it may run; --force overrides", async () => {
    const c = at(world({ secrets: [...ALL], state: SEEDED, jwks: jwksAt(23) }));
    expect(await run(ROTATE, c.deps, ROOT, [secrets])).toBe(1);
    expect(bulkOf(c)).toEqual([]);
    const msg = c.lines().at(-1).message;
    expect(msg).toContain("under 24 hours old");
    expect(msg).toContain(new Date(NOW + H).toISOString());
    expect(msg).toContain("--force");

    const f = at(world({ secrets: [...ALL], state: SEEDED, jwks: jwksAt(23) }));
    expect(await run([...ROTATE, "--force"], f.deps, ROOT, [secrets])).toBe(0);
    expect(Object.keys(payloadOf(f)).sort()).toEqual([
      "CARD_SIGNING_KEY",
      "CARD_SIGNING_KEY_PREV",
    ]);
  });

  it("refuses, changing nothing, when the JWKS is unreachable or lists no key", async () => {
    for (const jwks of [undefined, { keys: [] }]) {
      const c = at(world({ secrets: [...ALL], state: SEEDED, jwks }));
      expect(await run([...ROTATE, "--force"], c.deps, ROOT, [secrets])).toBe(
        1,
      );
      expect(bulkOf(c)).toEqual([]);
      expect(c.lines().at(-1).message).toMatch(/nothing changed/);
    }
  });

  it("a bus reporting problem: test_card_key gets a new key and no _PREV, without reading the JWKS", async () => {
    const c = at(
      world({ secrets: [...ALL], state: SEEDED, problem: "test_card_key" }),
    );
    expect(await run([...ROTATE, "--force"], c.deps, ROOT, [secrets])).toBe(0);
    expect(Object.keys(payloadOf(c))).toEqual(["CARD_SIGNING_KEY"]);
    expect(c.ops).not.toContain("GET /.well-known/jwks.json");
    expect(c.lines().at(-1).message).toContain("not kept as previous");
  });

  it("with no key on the Worker yet, generates one instead", async () => {
    const c = at(
      world({
        secrets: ["ACCESS_CLIENT_SECRET", "SESSION_SECRET", "CARD_OWNER_SALT"],
        state: SEEDED,
      }),
    );
    expect(await run(ROTATE, c.deps, ROOT, [secrets])).toBe(0);
    expect(Object.keys(payloadOf(c))).toEqual(["CARD_SIGNING_KEY"]);
    expect(c.lines().at(-1).message).toContain("no CARD_SIGNING_KEY to rotate");
  });

  it("never runs under --check, --ci or --destroy, and --force needs it", async () => {
    for (const extra of [["--check"], ["--ci"], ["--destroy"]]) {
      const c = at(
        world({ secrets: [...ALL], state: SEEDED, jwks: jwksAt(30) }),
      );
      expect(await run([...ROTATE, ...extra], c.deps, ROOT, [secrets])).toBe(1);
      expect(bulkOf(c)).toEqual([]);
    }
    const c = at(world({ secrets: [...ALL], state: SEEDED }));
    expect(await run([...FLAGS, "--force"], c.deps, ROOT, [secrets])).toBe(1);
    expect(c.out()).toContain("--force needs --rotate-card-key");
  });
});
