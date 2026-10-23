// The spec's Verification scenarios (docs/superpowers/specs/2026-10-21-openbus-design.md)
// against a real hub. Run with `pnpm e2e:staging`; needs E2E_HUB and E2E_STORAGE_STATE.
// Skipped while E2E_HUB is unset or its /hub is 404; any other unhealthy hub fails.
import { ClientFrameSchema, frameId, namespaceFrom, newId } from "@ob/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  eventually,
  gitRepo,
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
const hub = gate.state === "run" ? gate.hub : "";
if (gate.state === "skip") console.warn(`e2e:staging skipped: ${gate.reason}`);

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
/** Before a negative check: long enough for a wrong delivery to have landed. */
const settle = () => sleep(3_000);
/** The hub's own roster state for `name`, as `sender` sees it. */
const awaitState = (sender: Session, name: string, state: "live" | "queued") =>
  eventually(
    async () =>
      expect(await sender.hubRoster()).toContainEqual(
        expect.objectContaining({ bus_name: name, state }),
      ),
    { timeoutMs: 30_000 },
  );

afterEach(async () => {
  await Promise.all(machines.splice(0).map((m) => m.dispose()));
});

if (gate.state === "fail") {
  describe("staging gate", () => {
    it("E2E_HUB is set, so the hub must be healthy", () => {
      throw new Error(gate.reason);
    });
  });
}

describe.skipIf(gate.state !== "run")(
  gate.state === "skip"
    ? `staging scenarios (skipped: ${gate.reason})`
    : `staging scenarios on ${hub}`,
  () => {
    it("1: a Claude session and an OpenCode session on two machines see each other and a message each way lands, and the reply routes back", async () => {
      // One repo cloned twice: ssh on one machine, https on the other, no .openbus.json.
      const remote = `openbus-e2e/run-${run}`;
      const sshDir = gitRepo(`git@github.com:${remote}.git`);
      const httpsDir = gitRepo(`https://github.com/${remote}`);
      const ns = namespaceFrom({
        remoteUrl: `https://github.com/${remote}`,
        gitRootName: "repo",
        cwd: httpsDir,
      });
      const [m1, m2] = [await mk("a"), await mk("b")];
      const claude = await m1.session(
        "claude-code",
        `claude-${run}-1`,
        sshDir,
        {
          name: `claude-${run}`,
        },
      );
      const bystander = await m1.session("opencode", `ses_${run}1x`, sshDir, {
        name: `bystander-${run}`,
      });
      const oc = await m2.session("opencode", `ses_${run}1`, httpsDir, {
        name: `opencode-${run}`,
      });
      expect((await claude.info()).namespace).toBe(ns);
      expect((await oc.info()).namespace).toBe(ns);
      const [cName, oName] = [await claude.name(), await oc.name()];
      await sees(claude, oName);
      await sees(oc, cName);

      const out = await claude.send(oName, "ping from claude");
      expect(out.state).toBe("pending");
      const got = await lands(oc, "ping from claude");
      // Delivered to the right agent_ref, from the sender's bus name, in the shared namespace.
      expect(got).toMatchObject({ from_name: cName, namespace: ns });
      await eventually(() =>
        expect(m1.receipts(out.msg_id)).toContain("delivered"),
      );

      // The reply is addressed by the from_name it arrived with, and routes back.
      await oc.send(got.from_name, "pong from opencode");
      const back = await lands(claude, "pong from opencode");
      expect(back.from_name).toBe(oName);
      await settle();
      expect(claude.inbox().map((m) => m.body)).toEqual(["pong from opencode"]);
      expect(oc.inbox().map((m) => m.body)).toEqual(["ping from claude"]);
      expect(bystander.inbox()).toEqual([]);
    });

    it("1b: a frame naming another machine's from_ref is rejected (Review Focus 1)", async () => {
      const ns = `e2e-${run}-spoof`;
      const [m1, m2] = [await mk("a"), await mk("b")];
      const victim = await m1.session(
        "claude-code",
        `claude-${run}-1b`,
        workspace(ns),
        {
          name: `victim-${run}`,
        },
      );
      const target = await m2.session(
        "opencode",
        `ses_${run}1b`,
        workspace(ns),
        {
          name: `target-${run}`,
        },
      );
      const name = await target.name();
      await sees(victim, name);
      // m2's own link claims m1's session as the sender.
      const spoof = ClientFrameSchema.parse({
        v: 1,
        id: frameId(),
        type: "send",
        from_ref: victim.ref,
        to_name: name,
        body: "spoofed",
      });
      const closes = m2.closeCodes().length;
      const reply = await m2.raw(spoof);
      // Pinned: error{id, code:"not_registered"}, no receipt, the socket stays open.
      expect(reply).toMatchObject({
        v: 1,
        id: spoof.id,
        type: "error",
        code: "not_registered",
      });
      await settle();
      expect(
        m2.exchanges().filter((x) => x.req.id === spoof.id),
        "one reply, and it is not a receipt",
      ).toEqual([{ req: expect.anything(), res: reply }]);
      expect(m2.closeCodes()).toHaveLength(closes);
      // The same link still serves m2's real session.
      expect(await names(target)).toContain(name);
      expect(target.inbox()).toEqual([]);
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
      await settle();
      expect(first.inbox().map((m) => m.body)).toEqual(["for the first"]);
      expect(second.inbox().map((m) => m.body)).toEqual(["for the second"]);
    });

    it("3: a closed OpenCode TUI refuses sends and nothing is injected (the session ended)", async () => {
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

      // Presence gone and the adapter disconnected; closed agents leave the roster.
      await oc.close();
      await eventually(async () =>
        expect(await names(sender)).not.toContain(name),
      );
      expect(await sender.send(name, "are you there?")).toMatchObject({
        state: "refused",
        reason: "closed",
      });
      await settle();
      expect(oc.inbox()).toEqual([]);
    });

    // TUI closed, adapter still connected. Split in two so that only the C6
    // expectation can be the expected failure: the first test runs the scenario
    // and asserts the hub link is healthy (any unrelated breakage fails it); the
    // `it.fails` holds only what Client's presence gate (C6) will make true.
    let tuiClosed:
      | { receipt: Awaited<ReturnType<Session["send"]>>; calls: number }
      | undefined;
    it("3: a closed OpenCode TUI (adapter still connected): the hub link stays healthy", async () => {
      const ns = `e2e-${run}-threeb`;
      const [m1, m2] = [await mk("a"), await mk("b")];
      const sender = await m1.session(
        "claude-code",
        `claude-${run}-3b`,
        workspace(ns),
        { name: `sender-${run}` },
      );
      const oc = await m2.session("opencode", `ses_${run}3b`, workspace(ns), {
        name: `tui-${run}`,
      });
      const name = await oc.name();
      await sees(sender, name);

      await oc.closeTui();
      await settle();
      const receipt = await sender.send(name, "are you there?");
      await settle();
      tuiClosed = { receipt, calls: oc.inbox().length };
      // Healthy: a receipt came back, neither link dropped, both daemons answer.
      expect(["pending", "refused"]).toContain(receipt.state);
      expect(m1.closeCodes()).toEqual([]);
      expect(m2.closeCodes()).toEqual([]);
      expect(await oc.name()).toBe(name);
      expect(await names(sender)).toBeInstanceOf(Array);
    });

    // Expected to fail until Client lands the OpenCode presence gate (C6): the
    // daemon has no presence check yet, so the mail is pushed and injected.
    it.fails("3: a closed OpenCode TUI refuses sends and nothing is injected (TUI closed, adapter still connected)", () => {
      // Without the sibling's result this passes, and a passing it.fails fails the suite.
      if (!tuiClosed) return;
      expect(tuiClosed.receipt).toMatchObject({
        state: "refused",
        reason: "closed",
      });
      expect(tuiClosed.calls).toBe(0);
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
      await awaitState(sender, name, "queued");
      const r = await sender.send(name, "while you were out");
      expect(r.state).toBe("pending");
      await settle();
      expect(oc.inbox(), "nothing is delivered while offline").toEqual([]);
      expect(m1.receipts(r.msg_id)).toEqual([]);

      await m2.online();
      await lands(oc, "while you were out");
      await eventually(
        () => expect(m1.receipts(r.msg_id)).toContain("delivered"),
        { timeoutMs: 30_000 },
      );
      await settle();
      expect(oc.inbox().map((m) => m.body)).toEqual(["while you were out"]);
    });

    it("4: a session closed while its machine is offline: its mail expires at once and a reopened session gets none", async () => {
      const ns = `e2e-${run}-fourc`;
      const [m1, m2] = [await mk("a"), await mk("b")];
      const sender = await m1.session(
        "claude-code",
        `claude-${run}-4c`,
        workspace(ns),
        {
          name: `sender-${run}`,
        },
      );
      const oc = await m2.session("opencode", `ses_${run}4c`, workspace(ns), {
        name: `closed-${run}`,
      });
      const name = await oc.name();
      await sees(sender, name);

      await m2.offline();
      await awaitState(sender, name, "queued");
      const r = await sender.send(name, "for a session that closes");
      expect(r.state).toBe("pending");
      await oc.close();
      await m2.online();
      await eventually(
        () =>
          expect(m1.receipts(r.msg_id)).toEqual(["expired: recipient_closed"]),
        { timeoutMs: 30_000 },
      );
      await oc.reopen();
      await settle();
      expect(oc.inbox()).toEqual([]);
    });

    it("4: a link dropped before the ack gives one copy and never a false delivered (Review Focus 3)", async () => {
      const ns = `e2e-${run}-fourd`;
      const [m1, m2] = [await mk("a"), await mk("b")];
      const sender = await m1.session(
        "claude-code",
        `claude-${run}-4d`,
        workspace(ns),
        {
          name: `sender-${run}`,
        },
      );
      const oc = await m2.session("opencode", `ses_${run}4d`, workspace(ns), {
        name: `flaky-${run}`,
      });
      const name = await oc.name();
      await sees(sender, name);

      m2.holdAcks(true);
      const r = await sender.send(name, "exactly once");
      await lands(oc, "exactly once");
      await settle();
      expect(m1.receipts(r.msg_id), "no ack reached the hub").toEqual([]);
      m2.holdAcks(false);
      m2.sever();
      await eventually(
        () => expect(m1.receipts(r.msg_id)).toEqual(["delivered"]),
        { timeoutMs: 60_000 },
      );
      await settle();
      expect(oc.inbox().map((m) => m.body)).toEqual(["exactly once"]);
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
          await awaitState(sender, name, "queued");
          const r = await sender.send(name, "this will expire");
          expect(r.state).toBe("pending");
          await eventually(
            () =>
              expect(
                m1.receipts(r.msg_id).some((x) => x.startsWith("expired")),
              ).toBe(true),
            { timeoutMs: 65 * 60_000, intervalMs: 30_000 },
          );
          await m2.online();
          await settle();
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
      await settle();
      expect(oc.inbox()).toEqual([]);
    });

    it("6: another namespace is invisible and unreachable; a global agent reaches both", async () => {
      const [n1, n2] = [`e2e-${run}-six-a`, `e2e-${run}-six-b`];
      const [m1, m2] = [await mk("a"), await mk("b")];
      // Two namespaces on one machine; the global agent on the other.
      const a = await m1.session(
        "claude-code",
        `claude-${run}-6`,
        workspace(n1),
        {
          name: `a-${run}`,
        },
      );
      const b = await m1.session("opencode", `ses_${run}6b`, workspace(n2), {
        name: `b-${run}`,
      });
      const g = await m2.session(
        "opencode",
        `ses_${run}6g`,
        workspace(`e2e-${run}-six-g`, { global: true }),
        { name: `global-${run}` },
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

      await a.send(gn, "a to global");
      await b.send(gn, "b to global");
      await lands(g, "a to global");
      await lands(g, "b to global");
      await g.send(an, "global to a");
      // Over the inline cap, so b holds a fetchable notice.
      await g.send(bn, `global to b ${"x".repeat(40_000)}`);
      await lands(a, "global to a");
      const notice = await eventually(() => {
        const [m] = b.inbox();
        expect(m?.body).toContain(m?.msg_id);
        return m as NonNullable<typeof m>;
      });

      // Pinned: a msg_id not addressed to the fetching agent gets the same
      // error{id, code:"not_found"} as an unknown id, never other_namespace.
      const crossLocal = await a.fetch(notice.msg_id);
      const cross = a.hubReply("fetch", (q) => q.msg_id === notice.msg_id);
      expect(cross).toMatchObject({ v: 1, type: "error", code: "not_found" });
      expect(crossLocal).toMatchObject({ type: "error", code: "not_found" });
      const unknownId = newId();
      await a.fetch(unknownId);
      const unknown = a.hubReply("fetch", (q) => q.msg_id === unknownId);
      expect(unknown).toMatchObject({ v: 1, type: "error", code: "not_found" });
      expect(JSON.stringify(cross)).not.toContain("other_namespace");
      await settle();
      expect(a.inbox().map((m) => m.body)).toEqual(["global to a"]);
      expect(b.inbox()).toHaveLength(1);
    });

    it("6: a global agent's send to a name held in two namespaces is refused as ambiguous", async () => {
      const [n1, n2] = [`e2e-${run}-amb-a`, `e2e-${run}-amb-b`];
      const [m1, m2] = [await mk("a"), await mk("b")];
      const twin = `twin-${run}`;
      const x = await m1.session(
        "claude-code",
        `claude-${run}-6x`,
        workspace(n1),
        {
          name: twin,
        },
      );
      const y = await m2.session("opencode", `ses_${run}6y`, workspace(n2), {
        name: twin,
      });
      const g = await m1.session(
        "opencode",
        `ses_${run}6amb`,
        workspace(`e2e-${run}-amb-g`, { global: true }),
        { name: `global-${run}` },
      );
      // Names are unique per namespace, so both keep the same name.
      expect(await x.name()).toBe(twin);
      expect(await y.name()).toBe(twin);
      await eventually(async () =>
        expect((await names(g)).filter((n) => n === twin)).toHaveLength(2),
      );

      // `ambiguous` is newer than @ob/shared on main, so the daemon may drop the
      // receipt as a bad frame; the hub's reply is read by frame id, by string.
      await g.send(twin, "which one?").catch(() => undefined);
      const reply = await eventually(() => {
        const r = g.hubReply("send", (q) => q.to_name === twin);
        expect(r).toBeDefined();
        return r;
      });
      expect(reply).toMatchObject({
        type: "receipt",
        state: "refused",
        reason: "ambiguous",
      });
      await settle();
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
