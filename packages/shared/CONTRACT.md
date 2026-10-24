# OpenBus contract (v1)

Source of truth: `packages/shared/src/*.ts` (`@ob/shared`). This is the summary.
Owner: Backend. Before merging any change to `packages/shared`, notify the manager and every affected lead (Frontend, Client, Platform, Design). Open items: issue #71.

## Values

| What                          | Value                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine token                 | `ob_machine_` + 32 base58. The hub stores a hash only (enforced by the hub, B3).                                                                                 |
| Ids, msg ids                  | 16 base58 (no `0 O I l`)                                                                                                                                         |
| Device secret (`device_code`) | 43 base58                                                                                                                                                        |
| User code                     | 8 chars of `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no `I`, `O`, `0`, `1`), shown `XXXX-XXXX`; valid for 600 s; poll every 5 s. Validators accept only this alphabet. |
| Inline body                   | <= 32768 bytes UTF-8 (`inlineBodyBytes`); above it `deliver` carries a notice and the recipient `fetch`es                                                        |
| Max body                      | 1048576 bytes UTF-8 (`maxMessageBytes`)                                                                                                                          |
| Raw frame cap                 | `MAX_RAW_FRAME_CHARS` = 2 MB + 4 KB of JSON text                                                                                                                 |
| Mail TTL                      | 3600 s (`mailTtlSec`)                                                                                                                                            |
| Inbox cap                     | 50 undelivered per agent (`inboxCap`)                                                                                                                            |
| Roster cap                    | 1000 (`maxRosterAgents`): wire roster, `sessions` lists, `GET /agents`, feed agents                                                                              |
| Machines list cap             | 100 (`maxMachinesListed`)                                                                                                                                        |
| Revoke close code             | 4403 (`revokeCloseCode`); protocol violation 1008                                                                                                                |
| Other                         | ack timeout 10 s, ping every 25 s, 1 socket per machine (a reconnect replaces it)                                                                                |

Keepalive is the bare string `ping` / `pong` (`PING`, `PONG`), never a frame. Helpers: `frameId()` makes a correlation id; `formatFrameError(message, frameId|null)` appends `(frame <id>)`.

## Receipts and refusals

States: `pending | delivered | expired | refused`.
Refusal reasons (7, `REFUSAL_REASONS`): `unknown_agent`, `closed`, `inbox_full`, `too_large`, `other_namespace`, `revoked`, `ambiguous`. `other_namespace` answers only an explicit `to_namespace` the sender may not target; without `to_namespace` a name outside the sender's namespace and the globals is `unknown_agent`, whether or not it is live elsewhere (spec goal 5 and scenario 6: other namespaces are "invisible and unreachable"; B8).
`refused` always carries one of the 7. `expired` may carry `recipient_closed` (reason on `ReceiptReasonSchema`, not a send refusal). `pending` and `delivered` carry none. The `receipt` reply to `send` is only `pending` or `refused`; `receipt_update` may carry any state.

## Wire (daemon <-> hub)

`agent_ref`, `from_ref` and `to_ref` are `AgentRefSchema`: `[A-Za-z0-9_.:-]{1,128}`, never `__proto__`, `constructor` or `prototype`. A daemon-local opaque handle, safe as an object key.

One JSON object per WebSocket text message. Every frame is a strict object `{v: 1, id, type, ...}`; `id` matches `[A-Za-z0-9_-]{1,64}`; replies echo the request id. All frame fields are snake_case.

### Client to hub (`CLIENT_FRAMES`)

- `hello {machine_label, client_version}`; `client_version` 1..64 chars
- `agent_up {agent_ref, kind, proposed_name, namespace, global}`; `kind` is `claude-code | opencode | pi`; `proposed_name` <= 256 chars (any string; the hub names the agent via `candidateName`)
- `agent_down {agent_ref}`
- `sessions {open[], closed[]}` of `agent_ref`, each <= 1000, distinct, no overlap
- `send {from_ref, to_name, to_namespace?, body}`
- `ack {msg_id}`
- `refuse {msg_id, reason: "closed", detail: "denied"|"refused"|"expired"|"dropped"}`: the harness did not take the message; the receipt becomes `refused: closed` and the mail is dropped. `held` is not a refusal; the daemon stays silent.
- `list {from_ref}`
- `fetch {from_ref, msg_id}`

### Hub to client (`SERVER_FRAMES`)

- `hello_ok {machine_id, machine_label, server_version}` (`server_version` <= 1024 chars): reply to `hello`.
- `agent_ok {agent_ref, bus_name}`: the final (possibly suffixed `-N`) name.
- `receipt {msg_id, state, reason?}`: reply to `send`.
- `roster {agents: [{bus_name, kind, namespace, global, state?, machine_label?}]}`: reply to `list`. `machine_label` (B13, `MachineLabelSchema`) is the agent's machine label; the hub sends it on every row it already returns (no change to roster scoping), and the field stays optional so older hubs that omit it still decode. `state` is `live | queued`; it is transitionally optional on the wire and a missing value means `live` (`rosterState()`); it becomes required once the daemon migrates (issue #71). Closed agents are omitted (enforced by the hub, B5). REST `Agent.state` is already required.
- `body {msg_id, body}`: reply to `fetch`.
- `error {code, message}`: `code` is `bad_frame | not_registered | not_found | too_large | rate_limited | internal`; `message` <= 1024 chars; the hub echoes the request `id` when the decoder recovered one (enforced by the hub, B5).
  - Frame budget (B11): a socket that exceeds its frame budget is closed with `LIMITS.rateLimitCloseCode` (4429) and reason `"rate limited"`, daemon and dashboard sockets alike. Back off at least `LIMITS.rateLimitCooldownMs` (10 s) before reconnecting: within it the hub answers that machine's `/hub` upgrade with HTTP 429. Daemon budget: 50 frames/s refill, burst 512 (Client paces at 40 frames/s); dashboards: 1/s, burst 16. The `"ping"` keepalive never counts.
  - `rate_limited` in reply to `agent_up` (B11): the agent would exceed a live-agent cap; nothing is registered and the socket stays open (a re-up of an already-live agent is never refused). `message` is exactly `AGENT_CAP_MESSAGES.machine` = `"Too many live agents on this machine"` (past `LIMITS.maxAgentsPerMachine`, 200, on this machine) or `AGENT_CAP_MESSAGES.org` = `"Too many live agents in this account"` (past `LIMITS.maxRosterAgents`, 1000, in the account). Clients may match on these strings.
- `deliver {msg_id, to_ref, from_name, namespace, body | notice}`; `from_name` is a `BusNameSchema` name; exactly one of `body` (<= 32 KB) or `notice {size, msg_id}` (`32768 < size <= 1 MB`, `notice.msg_id === msg_id`). `namespace` is the sender's namespace.
- `receipt_update {msg_id, state, reason?}`: pushed when a pending receipt resolves.
- `roster_changed {namespace}`

### `send` targeting

`to_namespace` names the target only; the sender's identity is `from_ref`, attested by the daemon.
- Only a global sender may target another namespace. A non-global sender may set `to_namespace` only to its own (a no-op) or to reach a global agent whose home namespace is X; anything else is refused `other_namespace`.
- Non-global sender without `to_namespace`: its own namespace first, then global agents. A name found in neither is `unknown_agent` (or `closed` if it closed in the sender's own namespace or was a global), even when it is live in another namespace: other namespaces are "invisible and unreachable" (spec goal 5, scenario 6), so the refusal reveals nothing about them.
- `other_namespace` is only the answer to an explicit `to_namespace` the sender may not target, and it is identical whether or not the name exists there.
- Global sender with `to_namespace`: that name in that namespace.
- Global sender without it: a global target, or a name matching in exactly one namespace, resolves. A name matching in two or more is refused `ambiguous`. Global names are unique, so a global target is never ambiguous.
- The refusal must not leak whether a name exists: a refusal for an inaccessible target is identical whether or not the name exists there.

### `send` idempotency (B14)

The hub dedupes `send` on (sender agent, frame `id`). The sender agent is the hub's agent for (machine, `from_ref`), so the key survives reconnects and socket replacement. No wire change.
- A send frame's `id` must be unique per sender agent for at least 1 h (the hub keeps keys 2 h); use a ULID or UUID.
- A resend after a lost connection must reuse the original `id`, with the same `to_name` (compared case-folded), `to_namespace` and `body`. If the original was accepted, the hub returns its receipt and never delivers, stores or notifies again: `receipt {msg_id, state: "pending"}` with the original `msg_id` (the send receipt is only `pending` or `refused`), followed, when the message is already final, by `receipt_update {msg_id, state, reason?}` with its current state (`delivered`, `expired`, or `refused: closed`).
- `receipt_update` is idempotent per `msg_id`: a daemon may see the same final update twice (for example after such a resend) and must treat the repeat as a no-op.
- A send refused at send time (any reason) delivered nothing and stores no key, so a resend with the same `id` is evaluated again (for example, it succeeds once an `inbox_full` inbox drains).
- Reusing an `id` with a different payload gets `error {id, code: "bad_frame", message: "frame id reused"}`; nothing is stored or delivered.
- The per-agent window is bounded at 200 keys (`inboxCap` x 4). Only accepted sends hold a key. Past the bound, the agent's oldest key is dropped and that send loses its dedupe; the new send still goes through. Pinned by `apps/server/test/hub.idempotent-send.test.ts`.

### Pinned behaviours

- Enforced by the hub (B5/B6/B8/B9), not by shared; the named hub test pins each one.
- `fetch` of a message not addressed to the sender (other namespace, other recipient, already delivered, expired or unknown) returns `error not_found`. No existence oracle. Pinned by `apps/server/test/hub.mail.test.ts` (B8).
- An unregistered or spoofed `from_ref` (on `send`, `list`, `fetch`) returns `error not_registered`: no receipt, and the socket stays open. Abuse is rate limited (`rate_limited`). Pinned by `apps/server/test/hub.from_ref.test.ts` (B5/B6).
- Wire namespaces must be canonical (`WireNamespaceSchema`): `[a-z0-9._~/-]{1,128}`. Daemons normalize (`namespaceFrom` / `NamespaceSchema`) before sending; the hub rejects anything else with `bad_frame`.
- Hub code must never build storage keys or paths by concatenating namespaces.

### Decoders

`decodeClientFrame(raw)` is for the hub (accepts only client frames); `decodeServerFrame(raw)` is for the daemon (only server frames). Both never throw and return `{ok: true, frame}` or `{ok: false, error: "bad_frame" | "too_large", id?}`; `id` is recovered when possible so the hub can echo it. `encodeFrame` puts `v` then `id` first.
Bounds, checked in order before and during parsing:
1. Non-string input is `bad_frame`.
2. Raw length > `MAX_RAW_FRAME_CHARS` is `too_large`, before any parse.
3. Linear pre-scan outside strings: depth <= 4, `:` plus `,` <= 16384 in total and <= 64 directly in one object, structural characters <= 65536. Otherwise `bad_frame`, before `JSON.parse`.
4. After parse, a `body` over 1 MB of UTF-8 is `too_large`; schema failure is `bad_frame`.
   Control-heavy bodies can escape to 6x, so a body under 1 MB can still be `too_large` on the wire.
5. Free-text fields (`body`, `client_version`, `server_version`, `proposed_name`, error `message`) must be well-formed Unicode: a lone surrogate (JSON `"\ud800"`) is `bad_frame`, in both decoders. Valid pairs (emoji) are fine. `to_name`, `from_name`, `bus_name`, namespaces and refs are ASCII-only and `machine_label` rejects `\p{Cs}`, so they cannot carry one. `encodeFrame` throws `RangeError` on such text instead of emitting a frame every peer would refuse; the hub's `sendFrame` catches it.

### Version-gating additive fields

The wire decoders are strict, so a new field breaks every daemon built before it. Until a daemon is published there is no such daemon, and a new field ships unconditionally (as `roster.machine_label` did in B13). After the first published daemon, an additive server-to-daemon field is gated: the hub keeps `hello.client_version` (in the socket attachment, so it survives hibernation) and sends the field only when `semverGte(client_version, <first client version that decodes it>)`. `semverGte(a, b)` compares numeric `major.minor.patch`, ignores `+build` metadata, ranks a pre-release below its release, and returns false for malformed input, so the gate fails closed and the field is withheld.

## REST and the dashboard feed

JSON fields are camelCase; timestamps are ISO 8601 with offset. Public routes are unversioned; the API is under `/api/v1`.

| Route                                                   | Auth (enforced by the Worker, B2/B2b) | Notes                                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                          | none                                  |                                                                                                                                                      |
| `POST /device/code`                                     | none                                  | body `{machine_label?}`                                                                                                                              |
| `POST /device/token`                                    | none                                  | body `{device_code}`                                                                                                                                 |
| `GET /approve/<user_code>`, `POST /approve/<user_code>` | session                               | POST `{decision: "approve"\|"deny", label?}`                                                                                                         |
| `GET /auth/login`, `GET /auth/callback`                 | none                                  | Access OIDC                                                                                                                                          |
| `POST /auth/logout`                                     | session + CSRF                        | 204, clears the cookie (enforced by the Worker, B1b). No GET.                                                                                        |
| `GET /auth/dev-login`                                   | none                                  | only when ENVIRONMENT=dev, else 404                                                                                                                  |
| `GET /api/v1/me`                                        | session                               | `{user: {id, email, name\|null}}`                                                                                                                    |
| `GET /api/v1/machines`                                  | session                               | `{machines}`                                                                                                                                         |
| `DELETE /api/v1/machines/:id`                           | session + CSRF                        | 204 on first revoke; 404 when unknown, already revoked or the id is malformed (enforced by the hub, B9; pinned by `apps/server/test/revoke.test.ts`) |
| `GET /api/v1/agents?namespace=`                         | session                               | `{agents}`; `namespace` is a canonical wire namespace                                                                                                |
| `GET /api/v1/events`                                    | session + Origin                      | WebSocket upgrade (else 426); see Dashboard feed                                                                                                     |
| `GET /hub`                                              | machine token (Bearer)                | WebSocket upgrade                                                                                                                                    |

CSRF (enforced by the Worker, B2b): cookie mutations (`DELETE`, `POST /auth/logout`, `POST /approve/...`) must send `X-OB-Request: 1` (`CSRF_HEADER`, `CSRF_VALUE`); otherwise `403 csrf`.

DTOs (strict objects; the `GET /agents` query `AgentListQuerySchema` is strict too, unknown params rejected):
- `Machine {id, label, createdAt, lastUsed|null, revokedAt|null, connected}`. The list includes revoked machines (`revokedAt` set): active machines first, then revoked, each newest first, <= 100, so every active machine stays visible (enforced by the hub, B3). `connected` is true only while the daemon holds its hub socket and is always false when revoked. `lastUsed` is the last `/hub` upgrade.
- `Agent {id, namespace, name, kind, machineId, machineLabel, global, state: "live"|"queued", updatedAt}`. `live`: machine connected. `queued`: machine disconnected but the session was last reported open (mail waits up to 1 h, enforced by the hub, B7). Closed agents are not listed (enforced by the hub, B5). Revoking a machine removes its agents from `/agents` and the feed. <= 1000.
- Machine labels (`MachineLabelSchema`): 1..128 UTF-16 units, trimmed, and none of the characters `BAD_NS_CHARS` rejects (C0/C1 controls, zero-width, bidi, line/paragraph separators, BOM, lone surrogates, every format char `Cf`, U+034F, Hangul fillers); `newMachineLabel(hostname)` always returns a valid one.

Route helpers throw `RangeError` on bad input: `R.approve(userCode)`, `R.machine(id)`; `R.login` equals `AUTH.login`; `R.dashboard` is `/machines` (redirect target after approval). `MeSchema`: `user.id` 1..32 chars, `email` valid, `name` <= 128 or null. `BusEventSchema` is the dashboard feed union (`hello | machines | agents`).

Errors: `{error: {code, message, details?}}`, strict. `code` is one of `bad_request(400) unauthorized(401) csrf(403) not_found(404) conflict(409) too_large(413) rate_limited(429) internal(500)`. `details` is `{field?, retryAfterSec?}` only.

Dashboard feed (`GET /api/v1/events`, manager ruling B10-ws; replaces SSE): a hibernatable WebSocket, so an idle dashboard costs the hub no CPU while it sleeps (an SSE pipe kept the Worker invocation open, against the 10 ms CPU limit on Free).
- Worker route: anything other than `Upgrade: websocket` is 426. It checks the session and `Origin`, then forwards with `hubFetch(env, EVENTS_DO_PATH, { headers })` (`EVENTS_DO_PATH = "/events"`): a fresh request whose headers are built from scratch, carrying only `Upgrade: websocket`, `x-ob-session-exp` (`SESSION_EXP_HEADER`: the session's expiry, epoch ms) and `x-ob-session-gen` (`SESSION_GEN_HEADER`: the session's generation). Each is set (overwritten) from the verified session, never copied from the client's request; a duplicated value (`"a, b"`) is refused. All three constants are exported from `@ob/shared` (and `@ob/shared/web`).
- Hub `/events`: 426 without an upgrade. 400, with no socket created, when `x-ob-session-exp` is not a decimal integer of at most 16 digits (`^[0-9]{1,16}$`, a safe integer: no sign, point, exponent or hex; leading zeros are fine), is at or before now, or is beyond now + the session max age (B1's `MAX_AGE_S`, 7 days) + 1 min of skew; or when `x-ob-session-gen` is missing, not such a decimal integer, or `!==` the hub's current session generation (read in the same hub turn as any bump, so a logout between the Worker's check and the forward is refused). The socket's attachment keeps `exp` and `gen`.
- Frames: one JSON text frame per `BusEvent`; `type` lives in the JSON. On connect: `hello`, then a full `machines` frame, then a full `agents` frame. Every later change sends a full `machines` frame and a full `agents` frame, never a delta (throttled: at most one push per 500 ms per hub, trailing).
- Client frames: only the bare keepalive `"ping"`, auto-answered `"pong"` without waking the hub. Every other client frame is ignored, never decoded as a daemon frame. A dashboard socket never receives bus frames (`deliver`, `receipt_update`, `roster_changed`, `error`, ...).
- Close codes: `1013` evicted by the cap (16 dashboard sockets per hub; non-open ones first, then the oldest); `1011` a send failed; `4401` (`LIMITS.dashboardSessionClose`) the session ended: `bumpSessionGeneration()` closes every dashboard socket with 4401, and each socket is closed with 4401 once its `x-ob-session-exp` passes (the hub's alarm, and every push, check it). After 4401 the dashboard signs in again; after 1013/1011 it may reconnect.

Device flow:
- `POST /device/code` returns `{device_code, user_code, verification_uri, expires_in: 600, interval: 5}`. `user_code` is the formatted `XXXX-XXXX`.
- `verification_uri` rules (`DeviceCodeResponseSchema`): https, or http only on loopback (`localhost`, `127.0.0.1`, and `[::1]`); no userinfo; `new URL(uri).href` equals the raw string; path exactly `/approve/<user_code>`; no query or fragment. The schema cannot know the hub origin, so the CLI must also check the URI's origin equals its configured hub URL before printing or opening it.
- `POST /device/token` returns `{status: "pending"}`, `{status: "approved", token, machine_id}`, `{status: "denied"}` or `{status: "expired"}`. Consumed, expired and unknown codes all read as `expired` (enforced by the Worker/hub, B4).
- Request and helper schemas: `DeviceCodeRequestSchema {machine_label?}`, `DeviceTokenRequestSchema {device_code}`, `ApprovalBodySchema {decision, label?}`. `isUserCode` accepts raw (`AB2CD3E4`) and formatted (`AB2C-D3E4`); `normalizeUserCode` accepts case, spaces and hyphens variants (ASCII only) and returns the raw code or null; `formatUserCode` throws on an invalid raw code.

## Names and namespaces

Bus name (`BusNameSchema`): 1..64 chars, letters, digits, space, `.`, `_`, `-`; starts with a letter or digit; ends with a letter, digit, `_` or `-`; no IPv4-shaped names (domain-shaped names are fine). `suffixName(base, n)` appends `-N` (n >= 2) within the cap. `candidateName(proposed)` strips C0/C1 controls, collapses runs of spaces, trims, caps at 64, strips trailing spaces and dots; an unusable result becomes `FALLBACK_BUS_NAME` (`agent`).
Reserved: `RESERVED_BUS_NAMES = ["openbus", "open-bus"]` are for system notices. `isReservedBusName` folds case, strips trailing separator-and-digit suffixes (`openbus-2`) and removes `[ ._-]`; `BusNameSchema` rejects matches, and `candidateName` maps them to the fallback (the session still registers, enforced by the hub, B5). `openbus2` (digits glued on, no separator) is deliberately not reserved.

Namespace derivation (`namespaceFrom`): normalized git remote (`host/owner/repo`: lowercased, no scheme, user, port, `.git` or `www.`) -> git root directory name -> cwd basename -> `default`. Directory names are slugged (`[a-z0-9._~/-]`, diacritics folded) and truncated to 128 without a hash; they get a `-<fnv8>` suffix (hash of the NFC name) only when non-ASCII letters were dropped. Remote-derived namespaces longer than 128 are truncated plus `-<fnv8 of the full string>`. Slugs are canonical and idempotent: parsing a result again is a no-op. Never empty, never `default` unless nothing else exists.
`NamespaceSchema` applies the same normalization to config values (`My Team` becomes `my-team`); its output always passes `WireNamespaceSchema`.

`.openbus.json` (`CONFIG_FILE`): strict `{namespace?, global?}`, read from the session's start directory and its parents. `mergeConfigs(configs)` takes configs nearest-first; per key, the nearest file that sets it wins. `global` is never implied.

## Web subpath

`@ob/shared/web` (source `src/web.ts`) is the REST and dashboard-feed contract only, for browser bundles: `R`, `AUTH`, `CSRF_*`, `EVENTS_DO_PATH`, `SESSION_EXP_HEADER`, `SESSION_GEN_HEADER`, `ERROR_CODES`, `STATUS_FOR`, the API/Me/Machine/Agent/BusEvent schemas and types, and the id, name, namespace and limit helpers they use. It never imports `protocol.ts` or `receipts.ts`. The name is `web`, not `rest`, on purpose: the dashboard maps `@ob/shared/*` to `src/*`, so `@ob/shared/rest` would resolve to `src/rest.ts`. The package is `sideEffects: false`.

## Mocks

`@ob/shared/mocks` (source `packages/shared/src/mocks/`; never imported from the main barrel, so production bundles stay msw-free; `msw` is an optional peer) exports:
- `handlers`: `[...restHandlers, eventsWsHandler]`.
- `restHandlers`: msw handlers for `/api/v1/me`, `machines`, `DELETE machines/:id` (CSRF-checked; 204 then 404; revoke drops that machine's agents) and `agents` (`?namespace=` filters to that namespace plus global agents).
- `eventsWsHandler`: the feed on msw's `ws.link` WebSocket API, `createWsHandler(mockStateProviders, eventsLink)`.
- `eventsLink`: `ws.link("*/api/v1/events")`.
- `createWsHandler(providers = mockStateProviders, link = eventsLink)`: `providers` is `{ machines: () => Machine[], agents: () => Agent[] }`, called on every connection (never cached). On connection the handler sends `hello`, then `machines`, then `agents` from the providers, answers `"ping"` with `"pong"` and ignores anything else. `mockStateProviders` reads the same rows the REST mocks serve, so REST and WS agree; `eventsHandler(link?)` is `createWsHandler(mockStateProviders, link)`.
- msw runs every matching `ws.link` handler, and `server.use` prepends rather than replaces, so a custom `createWsHandler` on the default link next to `handlers` greets twice and pongs twice. Either give it its own link (`ws.link(...)`, and pass that link to `broadcast`/`closeAll`), or replace `handlers`: `setupServer(...restHandlers, createWsHandler(myProviders))`.
- `broadcast(event, link?)` sends one frame to every connected client; `closeAll(code, link?, reason?)` closes them (for example 4401 or 4403).
- The greeting is sent synchronously on connection: attach the client's `message` listener before awaiting `open` (`new WebSocket(url)`, then `addEventListener("message", ...)`, then await open), or the three greeting frames are lost.
- fixtures `me`, `machines` (includes a revoked one), `agents`.
- `resetMocks()`: restores fixtures; call it in `afterEach`.
