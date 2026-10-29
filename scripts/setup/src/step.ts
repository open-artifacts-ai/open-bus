import type { Api, Deps, Fs, Wrangler } from "./cf.ts";
import type { State } from "./state.ts";

export type Opts = {
  name: string;
  /** The instance's FQDN, no scheme. Empty under --check, --destroy and --token-links. */
  host: string;
  ownerEmail: string;
  accountId?: string;
  /** Never prompts; one JSON line per step. */
  json: boolean;
  upgrade: boolean;
  /** Read-only: run every check(), never apply, write nothing. */
  check: boolean;
  /** CI mode: implies --json; nothing is written to state. */
  ci: boolean;
  destroy: boolean;
  /** --yes-destroy=<name>: confirms --destroy non-interactively. */
  yesDestroy?: string;
  /** --rotate-card-key: a new CARD_SIGNING_KEY; the current one becomes CARD_SIGNING_KEY_PREV (I11). */
  rotateCardKey?: boolean;
  /** --force: rotate within 24 h of the last rotation. */
  force?: boolean;
};
export type Ctx = {
  deps: Deps;
  fs: Fs;
  root: string;
  opts: Opts;
  api: Api;
  /** Access API client: OB_ACCESS_TOKEN, else the wrangler token. */
  accessApi: Api;
  wrangler: Wrangler;
  /** Notes appended to the current step's reported message. */
  notes: string[];
  /** `data` for the current step's line; `human` replaces it in human output. */
  data?: unknown;
  human?: string;
  /** Set by a step's apply: it had nothing to do, so its line is `skipped`, not `ok`. */
  skipped?: boolean;
  /** The Access token read from `~/.openbus/<name>-access-token`; scrubbed from all output. */
  accessToken?: string;
  /**
   * Worker secret values, in memory only (never state or output): access sets
   * ACCESS_CLIENT_SECRET, the secrets step (I3) puts them. Scrubbed from all output.
   */
  secrets?: Record<string, string>;
  /** The Worker's secret names (I3); absent means "assume present". */
  workerSecretNames?: () => Promise<string[]>;
};

/** Missing input where prompting isn't allowed (--json): reported as action_required, exit 2. */
export class NeedInput extends Error {
  data?: unknown;
  constructor(message: string, data?: unknown) {
    super(message);
    this.data = data;
  }
}
export type ActionRequired = {
  status: "action_required";
  message: string;
  data?: unknown;
};
export type Step = {
  name: string;
  /** Runs on every setup: its todo is not drift. */
  always?: boolean;
  /** A step that only verifies: reports `ok` with this message (not `skipped`) when its check is done. */
  okWhenDone?: string;
  /** Still runs (and prints) when one of these steps failed; the run keeps the failure's exit code. */
  runAfterFailureOf?: string[];
  check: (state: State, ctx: Ctx) => Promise<"done" | "todo">;
  apply: (state: State, ctx: Ctx) => Promise<ActionRequired | undefined>;
};
