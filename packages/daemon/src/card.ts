import type { Unframed } from "@ob/ipc";
import {
  AGENT_CARD_MIN_CLIENT,
  type ClientFrame,
  frameId,
  type ServerFrame,
  type StatusState,
  semverGte,
} from "@ob/shared";
import type { Timer } from "./sent.ts";

/** How long a card request waits for `card` or `card_refused`. Never retried: a nonce is single use. */
export const CARD_TIMEOUT_MS = 10_000;
/**
 * The hub answers a good `status` with nothing, and a bad one with an error
 * at once. A set_status reply waits this long for that error.
 */
export const STATUS_SETTLE_MS = 1000;
/**
 * The local guard: at most one `status` frame per agent this often. Updates
 * in between are coalesced, the latest kept, as the hub does in its 5 s
 * window; this only keeps a runaway adapter off the socket's frame budget.
 */
export const STATUS_EVERY_MS = 1000;

/** DRAFT copy (Design to confirm), AC5a: what an agent sees when set_status or card is refused. */
export const CARD_COPY = {
  not_linked:
    "That app is not linked to your bus. Ask your owner to link it from the app's settings.",
  bad_nonce:
    "The app did not accept that nonce. Ask it for a new one and try again.",
  rate_limited:
    "This agent asked for too many cards. Wait a minute and try again.",
  timeout:
    "The hub did not answer in time. Ask the app for a new nonce and try again.",
  hub_unavailable: "The hub is not connected. Try again in a moment.",
  not_registered:
    "This session is not registered on the bus yet. Try again in a moment.",
  bad_frame: "The hub did not accept that request.",
  hub_outdated: "Your OpenBus hub is too old for this. Update the hub.",
  unsupported: "This OpenBus daemon is too old for this. Update OpenBus.",
} as const;

/** This daemon offers set_status and card: its build is at or above the gate. */
export const offersCard = (version: string): boolean =>
  semverGte(version, AGENT_CARD_MIN_CLIENT);

/**
 * True when the hub's version (from hello_ok) is a release below the gate. An
 * unknown or non-release version (`dev`) is let through: the hub answers
 * bad_frame itself if it cannot read the frame.
 */
export const hubTooOld = (hubVersion: string | undefined): boolean =>
  hubVersion !== undefined &&
  semverGte(hubVersion, "0.0.0") &&
  !semverGte(hubVersion, AGENT_CARD_MIN_CLIENT);

type Reply = (f: Unframed) => unknown;
const refuse = (code: keyof typeof CARD_COPY | string): Unframed => ({
  type: "error",
  code,
  message: CARD_COPY[code as keyof typeof CARD_COPY] ?? CARD_COPY.bad_frame,
});

type Wait = { reply: Reply; stop: () => void; card: boolean };
type Update = { state: StatusState; label?: string; reply: Reply };
type Guard = { queued?: Update; stop: () => void };

const unrefTimer: Timer = (ms, fn) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

/**
 * The agent card requests (AC5a): set_status becomes a hub `status` frame,
 * card a `card_request` answered by `card` or `card_refused`. The JWS passes
 * through untouched: never logged, never stored.
 */
export class AgentCard {
  readonly #waits = new Map<string, Wait>();
  readonly #guards = new Map<string, Guard>();
  readonly #after: Timer;

  constructor(
    private readonly opts: {
      send: (f: ClientFrame) => boolean;
      cancel: (id: string) => void;
      after?: Timer;
      cardTimeoutMs?: number;
      statusSettleMs?: number;
      statusEveryMs?: number;
    },
  ) {
    this.#after = opts.after ?? unrefTimer;
  }

  status(
    ref: string,
    state: StatusState,
    label: string | undefined,
    reply: Reply,
  ): void {
    const update: Update = {
      state,
      ...(label === undefined ? {} : { label }),
      reply,
    };
    const g = this.#guards.get(ref);
    if (g) {
      // Superseded before it went: the newer claim wins, as at the hub.
      g.queued?.reply({ type: "status_set" });
      g.queued = update;
      return;
    }
    this.#sendStatus(ref, update);
  }

  #sendStatus(ref: string, u: Update): void {
    const id = frameId();
    const ok = this.opts.send({
      v: 1,
      id,
      type: "status",
      from_ref: ref,
      state: u.state,
      ...(u.label === undefined ? {} : { label: u.label }),
    });
    if (!ok) {
      u.reply(refuse("hub_unavailable"));
      return;
    }
    const guard: Guard = {
      stop: this.#after(this.opts.statusEveryMs ?? STATUS_EVERY_MS, () => {
        this.#guards.delete(ref);
        if (guard.queued) this.#sendStatus(ref, guard.queued);
      }),
    };
    this.#guards.set(ref, guard);
    this.#wait(
      id,
      u.reply,
      false,
      this.opts.statusSettleMs ?? STATUS_SETTLE_MS,
    );
  }

  card(ref: string, aud: string, nonce: string, reply: Reply): void {
    const id = frameId();
    if (
      !this.opts.send({
        v: 1,
        id,
        type: "card_request",
        from_ref: ref,
        aud,
        nonce,
      })
    ) {
      reply(refuse("hub_unavailable"));
      return;
    }
    this.#wait(id, reply, true, this.opts.cardTimeoutMs ?? CARD_TIMEOUT_MS);
  }

  #wait(id: string, reply: Reply, card: boolean, ms: number): void {
    const stop = this.#after(ms, () => {
      if (!this.#waits.delete(id)) return;
      if (!card) {
        reply({ type: "status_set" });
        return;
      }
      // Not resent: the nonce may already be spent.
      this.opts.cancel(id);
      reply(refuse("timeout"));
    });
    this.#waits.set(id, { reply, stop, card });
  }

  /** A hub frame answering one of these requests; false for anything else. */
  answer(f: ServerFrame): boolean {
    if (f.type !== "card" && f.type !== "card_refused" && f.type !== "error")
      return false;
    const w = this.#waits.get(f.id);
    if (!w) return false;
    this.#waits.delete(f.id);
    w.stop();
    if (f.type === "card" && w.card) w.reply({ type: "card", jwt: f.jwt });
    else if (f.type === "card") w.reply(refuse("bad_frame"));
    else w.reply(refuse(f.code));
    return true;
  }

  /** The hub link dropped: nothing in flight will be answered. */
  dropped(): void {
    for (const [id, w] of [...this.#waits]) {
      this.#waits.delete(id);
      w.stop();
      w.reply(refuse("hub_unavailable"));
    }
    for (const g of this.#guards.values()) {
      g.stop();
      g.queued?.reply(refuse("hub_unavailable"));
    }
    this.#guards.clear();
  }
}
