// The spec's Verification scenarios (docs/superpowers/specs/2026-10-21-openbus-design.md)
// against a real hub. Run with `pnpm e2e:staging`; needs E2E_HUB and E2E_STORAGE_STATE.
// Skipped, with the reason in the suite name, until E2E_HUB's /hub route exists.
import { newId } from "@ob/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  eventually,
  liveHub,
  type Machine,
  machine,
  probeUpgrade,
  type Session,
  sleep,
  stagingRest,
  workspace,
} from "./harness.ts";

const gate = await liveHub();
if (!gate.ok) console.warn(`e2e:staging skipped: ${gate.reason}`);
const hub = gate.ok ? gate.hub : "";

/** Unique per run: staging is shared and keeps names and namespaces between runs. */
const run = newId().slice(0, 8).toLowerCase();
const machines: Machine[] = [];

async function mk(label: string): Promise<Machine> {
  const m = await machine(`e2e-${run}-${label}`, {
    hub,
    rest: stagingRest(hub),
  });
  machines.push(m);
  return m;
}

const names = async (s: Session) => (await s.roster()).map((a) => a.name);
const sees = (s: Session, name: string) =>
  eventually(async () => expect(await names(s)).toContain(name));
const lands = (s: Session, body: string) =>
  eventually(
    () => {
      const m = s.inbox().find((x) => x.body === body);
      expect(m, `${body} in ${s.ref}'s inbox`).toBeDefined();
      return m as NonNullable<typeof m>;
    },
    { timeoutMs: 30_000 },
  );

afterEach(async () => {
  await Promise.all(machines.splice(0).map((m) => m.dispose()));
});

describe.skipIf(!gate.ok)(
  gate.ok
    ? `staging scenarios on ${hub}`
    : `staging scenarios (skipped: ${gate.reason})`,
  () => {
    it("1: a Claude session and an OpenCode session on two machines see each other and a message each way lands, and the reply routes back", async () => {
      const ns = `e2e-${run}-one`;
      const [m1, m2] = [await mk("a"), await mk("b")];
      const claude = await m1.session(
        "claude-code",
        `claude-${run}-1`,
        workspace(ns),
        {
          name: `claude-${run}`,
        },
      );
      const oc = await m2.session("opencode", `ses_${run}1`, workspace(ns), {
        name: `opencode-${run}`,
      });
      const [cName, oName] = [await claude.name(), await oc.name()];
      await sees(claude, oName);
      await sees(oc, cName);

      const out = await claude.send(oName, "ping from claude");
      expect(out.state).toBe("pending");
      const got = await lands(oc, "ping from claude");
      // Delivered to the right agent_ref, from the sender's bus name, in the shared namespace.
      expect(got).toMatchObject({ from_name: cName, namespace: ns });
      expect(claude.inbox()).toEqual([]);
      await eventually(() =>
        expect(m1.receipts(out.msg_id)).toContain("delivered"),
      );

      // The reply is addressed by the from_name it arrived with, and routes back.
      await oc.send(got.from_name, "pong from opencode");
      const back = await lands(claude, "pong from opencode");
      expect(back.from_name).toBe(oName);
    });

    it("2: a second OpenCode session in the same service has its own identity and never sees the first one's mail", async () => {
      const ns = `e2e-${run}-two`;
      const [m1, m2] = [await mk("a"), await mk("b")];
      const sender = await m1.session(
        "claude-code",
        `claude-${run}-2`,
        workspace(ns),
        {
          name: `sender-${run}`,
        },
      );
      // Same machine, same service, same proposed name: two agent_refs.
      const dir = workspace(ns);
      const first = await m2.session("opencode", `ses_${run}2a`, dir, {
        name: `oc-${run}`,
      });
      const second = await m2.session("opencode", `ses_${run}2b`, dir, {
        name: `oc-${run}`,
      });
      const [n1, n2] = [await first.name(), await second.name()];
      expect(n1).not.toBe(n2);
      await sees(sender, n1);
      await sees(sender, n2);

      await sender.send(n1, "for the first");
      await sender.send(n2, "for the second");
      await lands(first, "for the first");
      await lands(second, "for the second");
      await sleep(2_000); // a misroute would land by now
      expect(first.inbox().map((m) => m.body)).toEqual(["for the first"]);
      expect(second.inbox().map((m) => m.body)).toEqual(["for the second"]);
    });

    it("3: a closed OpenCode TUI refuses sends and nothing is injected", async () => {
      const ns = `e2e-${run}-three`;
      const [m1, m2] = [await mk("a"), await mk("b")];
      const sender = await m1.session(
        "claude-code",
        `claude-${run}-3`,
        workspace(ns),
        {
          name: `sender-${run}`,
        },
      );
      const oc = await m2.session("opencode", `ses_${run}3`, workspace(ns), {
        name: `closing-${run}`,
      });
      const name = await oc.name();
      await sees(sender, name);

      // Presence file removed and the adapter gone.
      await oc.closeTui();
      await eventually(async () =>
        expect(await sender.send(name, "are you there?")).toMatchObject({
          state: "refused",
          reason: "closed",
        }),
      );
      expect(oc.inbox()).toEqual([]);
    });

    it("4: mail to an offline machine waits and is delivered on reconnect", async () => {
      const ns = `e2e-${run}-four`;
      const [m1, m2] = [await mk("a"), await mk("b")];
      const sender = await m1.session(
        "claude-code",
        `claude-${run}-4`,
        workspace(ns),
        {
          name: `sender-${run}`,
        },
      );
      const oc = await m2.session("opencode", `ses_${run}4`, workspace(ns), {
        name: `offline-${run}`,
      });
      const name = await oc.name();
      await sees(sender, name);

      await m2.offline();
      const r = await eventually(async () => {
        // Until the hub notices the drop it may still push; wait for a queued send.
        const x = await sender.send(name, "while you were out");
        expect(x.state).toBe("pending");
        return x;
      });
      expect(oc.inbox()).toEqual([]);
      await m2.online();
      await lands(oc, "while you were out");
      await eventually(
        () => expect(m1.receipts(r.msg_id)).toContain("delivered"),
        {
          timeoutMs: 30_000,
        },
      );
      await sleep(3_000);
      expect(
        oc.inbox().filter((m) => m.body === "while you were out"),
      ).toHaveLength(1);
    });

    describe.skipIf(!process.env.E2E_SLOW)("4b (E2E_SLOW)", () => {
      it(
        "4b: undelivered mail expires after an hour and the sender is told",
        async () => {
          const ns = `e2e-${run}-fourb`;
          const [m1, m2] = [await mk("a"), await mk("b")];
          const sender = await m1.session(
            "claude-code",
            `claude-${run}-4b`,
            workspace(ns),
            {
              name: `sender-${run}`,
            },
          );
          const oc = await m2.session(
            "opencode",
            `ses_${run}4b`,
            workspace(ns),
            {
              name: `gone-${run}`,
            },
          );
          const name = await oc.name();
          await sees(sender, name);
          await m2.offline();
          const r = await eventually(async () => {
            const x = await sender.send(name, "this will expire");
            expect(x.state).toBe("pending");
            return x;
          });
          await eventually(
            () => expect(m1.receipts(r.msg_id)).toContain("expired"),
            {
              timeoutMs: 65 * 60_000,
              intervalMs: 30_000,
            },
          );
          await m2.online();
          await sleep(10_000);
          expect(oc.inbox()).toEqual([]);
        },
        70 * 60_000,
      );
    });

    it("5: revoking a machine closes its socket with 4403 and its agents leave the roster", async () => {
      const ns = `e2e-${run}-five`;
      const [m1, m2] = [await mk("a"), await mk("b")];
      const sender = await m1.session(
        "claude-code",
        `claude-${run}-5`,
        workspace(ns),
        {
          name: `sender-${run}`,
        },
      );
      const oc = await m2.session("opencode", `ses_${run}5`, workspace(ns), {
        name: `revoked-${run}`,
      });
      const name = await oc.name();
      await sees(sender, name);

      await m2.revoke();
      await eventually(() => expect(m2.closeCodes()).toContain(4403));
      await eventually(() => expect(m2.revoked()).toBe(true));
      await eventually(async () =>
        expect(await names(sender)).not.toContain(name),
      );
      expect(await sender.send(name, "hello?")).toMatchObject({
        state: "refused",
        reason: "revoked",
      });
      // Reconnecting with the revoked token is refused at the upgrade.
      expect([401, 403]).toContain(await probeUpgrade(m2.hub, m2.token()));
      expect(oc.inbox()).toEqual([]);
    });

    it("6: another namespace is invisible and unreachable; a global agent reaches both", async () => {
      const [n1, n2] = [`e2e-${run}-six-a`, `e2e-${run}-six-b`];
      const [m1, m2] = [await mk("a"), await mk("b")];
      const a = await m1.session(
        "claude-code",
        `claude-${run}-6`,
        workspace(n1),
        {
          name: `a-${run}`,
        },
      );
      const b = await m2.session("opencode", `ses_${run}6b`, workspace(n2), {
        name: `b-${run}`,
      });
      const g = await m2.session(
        "opencode",
        `ses_${run}6g`,
        workspace(`e2e-${run}-six-g`, { global: true }),
        {
          name: `global-${run}`,
        },
      );
      const [an, bn, gn] = [await a.name(), await b.name(), await g.name()];

      // The global agent appears in both rosters and sees both.
      await sees(a, gn);
      await sees(b, gn);
      await sees(g, an);
      await sees(g, bn);
      expect(await names(a)).not.toContain(bn);
      expect(await names(b)).not.toContain(an);

      expect(await a.send(bn, "across")).toMatchObject({
        state: "refused",
        reason: "other_namespace",
      });
      expect(b.inbox()).toEqual([]);

      await a.send(gn, "a to global");
      await b.send(gn, "b to global");
      await lands(g, "a to global");
      await lands(g, "b to global");
      await g.send(an, "global to a");
      await g.send(bn, "global to b");
      await lands(a, "global to a");
      await lands(b, "global to b");
    });

    it("6b: a global agent's send to a name held in two namespaces is refused as ambiguous", async () => {
      const [n1, n2] = [`e2e-${run}-amb-a`, `e2e-${run}-amb-b`];
      const [m1, m2] = [await mk("a"), await mk("b")];
      const twin = `twin-${run}`;
      const x = await m1.session(
        "claude-code",
        `claude-${run}-6x`,
        workspace(n1),
        { name: twin },
      );
      const y = await m2.session("opencode", `ses_${run}6y`, workspace(n2), {
        name: twin,
      });
      const g = await m1.session(
        "opencode",
        `ses_${run}6amb`,
        workspace(`e2e-${run}-amb-g`, { global: true }),
        {
          name: `global-${run}`,
        },
      );
      // Names are unique per namespace, so both keep the same name.
      expect(await x.name()).toBe(twin);
      expect(await y.name()).toBe(twin);
      await eventually(async () =>
        expect((await names(g)).filter((n) => n === twin)).toHaveLength(2),
      );

      // `ambiguous` is newer than @ob/shared on main (no 7th reason yet), so the
      // daemon may drop the receipt as a bad frame; read it from the tap by string.
      const local = await g.send(twin, "which one?").catch(() => undefined);
      const raw = m1.rawReceipts().at(-1);
      expect(local?.reason ?? raw?.reason).toBe("ambiguous");
      expect(local?.state ?? raw?.state).toBe("refused");
      await sleep(2_000);
      expect(x.inbox()).toEqual([]);
      expect(y.inbox()).toEqual([]);
    });

    // 7: "A fresh Cloudflare account goes from `llms.txt` to a working bus with only
    // browser approvals from the user." A fresh-account install, not a hub scenario:
    // it is I9 (06-integration), run on the user's own account.
    it.todo(
      "7: a fresh Cloudflare account goes from llms.txt to a working bus with only browser approvals",
    );
  },
);
