# Agent card: roles, status and a signed identity shared with Open Artifacts

Status: draft for review, 2026-10-29. Owner: openbus-e0. Open Artifacts half: Artifacts Manager.

## Intent

One description of "which agent is this" that both OpenBus and Open Artifacts (OA) show. OA's half already exists: #587, Settings › Connected agents, where the owner's label comes first and a "reported by the agent" tag marks anything the agent claimed. OpenBus adds the parts only it can vouch for, and signs them so OA can show them as attested, not merely claimed. **[user]**

Origin: Blue Banjo asks M2 (role addresses) and N2 (status), and the Oct 24 identity-card thread between the two managers. **[user]** approved "spec it, with the signing step", and picked approach 1 (the agent carries a signed card).

## Goals

1. **Role labels.** The owner points a role such as `lane-6` at a live agent in the dashboard. A send to `lane-6` resolves to its holder when it is sent. **[user]**
2. **Status.** A `set_status` tool: one of `working`, `idle`, `blocked` or `waiting_on_owner`, plus a one-line task label. It shows on the dashboard Agents page and in the REST roster, always tagged as self-reported. **[user]**
3. **Signed card.** OpenBus signs a short-lived card for one agent. The agent hands it to OA, and OA verifies it offline against OpenBus's published key. **[user]**

## Non-goals

- The 24-hour role mailbox (M2b). It would be the first durable mail, and it needs its own **[user]** decision. A role here holds no mail.
- Owner messages (M3): deferred. **[user]**
- Using the card for any permission, in either product. It is for display only. **[user]**, and OA's position.
- Sub-task identities, history and search (existing non-goals).

## Anti-goals

- An agent choosing or claiming a role. Only the owner assigns roles, which keeps the spec anti-goal "a sender choosing its own name".
- A role silently following a reopened session. A role points at one agent id, and when that agent closes, the role is vacant until the owner re-points it.
- A card for one agent accepted for another. See the nonce binding below.
- Status shown as fact. It is labelled "agent says" everywhere, including inside a signed card, because signing doesn't make it true.
- A card that leaks the owner's email or the namespace to OA.

## Approaches considered

1. **The agent carries a signed card (chosen, [user]).** OpenBus signs a JWS, and OA verifies it against OpenBus's JWKS. The two servers never connect, there is no shared secret, and it is the same pattern as OA's hosted auth broker.
2. **OA asks OpenBus server to server.** OA holds an owner credential for the bus. Rejected: a standing key in OA, and both servers must be up.
3. **Pass the card at OAuth time.** Rejected: MCP clients don't pass custom parameters through the authorization request (OA's finding).

## Design

### Role labels (OpenBus only)

- Hub table `roles(namespace, role, agent_id NULL, set_at)`. A role name follows `BusNameSchema` and lives in the agent-name space of its namespace.
- **Collisions:**
  - Creating a role that equals a live agent's name is refused.
  - An agent whose proposed name equals a role gets the usual `-2` suffix.
  - Global agents resolve roles only in namespaces they can already reach.
- **Send resolution:** `send(to: "lane-6")` resolves to the holder's agent id at send time.
  - If the role is vacant (no holder, or the holder is closed), the send is refused with `role_vacant`.
  - The resolved recipient's name appears in the receipt, so the sender learns who got it.
- **Owner-only REST**, behind the session cookie plus the existing CSRF and Origin checks:
  - `PUT /api/v1/roles/{namespace}/{role}` with `{agentId}` to point a role at an agent.
  - `DELETE` the same path to remove a role.
  - `GET /api/v1/roles` to list roles.
  - No machine token or adapter can write a role.
- **Read side:** a roster row gains `role?: string`, `list_agents` shows `lane-6 → code-96`, and `self` reports the agent's own role.
- **Version gate:** old daemons never see roles, and a send to a role name from an old daemon resolves like any other name.

### Status (OpenBus only)

- Tool `set_status({state, label?})` in every adapter. `state` is one of the four values, and `label` is at most `maxLabelChars` (64) characters, cleaned the same way as machine labels.
- **Wire:** a daemon `status` frame, attested by `from_ref` like every frame. The hub stores `status`, `statusLabel` and `statusAt` on the agent row and clears them on close.
- **Rate limit:** at most one update per agent per 5 s, counted in the existing frame budget. Excess updates are coalesced, keeping the last one.
- **Read side:**
  - REST `AgentSchema` and the dashboard feed gain optional `status`, `statusLabel` and `statusAt`.
  - The dashboard Agents page shows them in a column tagged "agent says".
  - `list_agents` shows the status after the name.
- **Version gate:** the new tool appears only when the daemon reports a version that supports it.

### Linking OA to a bus (one time, per OA user)

1. In OA Settings, under "Link OpenBus", the user enters their bus host. OA redirects to `https://<bus>/link?aud=<OA origin>&state=<OA nonce>&redirect_uri=<OA callback>`.
2. The bus asks the owner to sign in and shows a confirm page ("Let <OA origin> verify your agents' cards?"). On confirm, the bus records `aud` in a `linked_apps` table and redirects back with a short-lived signed **link assertion** `{iss, aud, owner, state, exp}`.
3. OA verifies the link assertion and pins two values to that OA user: the issuer (the bus origin) and `owner`.

`owner` is an opaque, stable, per-bus owner id: `base64url(HMAC-SHA256(CARD_OWNER_SALT, lowercase OWNER_EMAIL))`. It is neither the email nor an OIDC sub, because each Access app issues a different sub.

The owner can unlink an app in the dashboard. After that the bus refuses to sign cards for that `aud`.

### The card

**Issuing:**

1. The agent calls OA's `present_card()`, which returns a nonce bound to the agent's OAuth grant.
2. The agent calls the bus tool `card({audience, nonce})`. The daemon attests the caller as for every frame and sends `card_request {from_ref, aud, nonce}`.
3. The hub signs the card only when `aud` is in `linked_apps`.
4. The agent calls `present_card(jwt)`. OA checks the signature, `iss` and `owner` against its pins, `aud`, `exp`, the nonce for this grant, and that the `jti` hasn't been seen before. It then stores a snapshot plus "attested <time>" on the grant. Presenting a new card updates the snapshot.

**Format:** compact JWS, `alg: EdDSA` (Ed25519), with a `kid` header. Claims:

| Claim        | Meaning                                         | Trust                |
| ------------ | ----------------------------------------------- | -------------------- |
| `iss`        | bus origin                                      | attested             |
| `aud`        | OA origin, which must be linked                 | attested             |
| `sub`        | agent id (one per session)                      | attested             |
| `owner`      | opaque owner id (above)                         | attested             |
| `nonce`      | OA's grant-bound challenge                      | echoed               |
| `iat`, `exp` | `exp = iat + 300 s`                             | attested             |
| `jti`        | random 128-bit id                               | attested             |
| `name`       | bus name                                        | attested             |
| `role`       | owner-assigned role, if any                     | attested (owner-set) |
| `kind`       | `claude-code`, `opencode`, `pi`, `omp`, `codex` | attested             |
| `machine`    | machine label                                   | attested             |
| `agent_says` | `{status, label}` if set                        | **self-reported**    |

The card leaves out email, namespace and machine id.

**Keys:**

- `ob:setup` generates an Ed25519 key pair and stores it as the Worker secret `CARD_SIGNING_KEY` (a JWK). `CARD_OWNER_SALT` is generated the same way.
- `GET /.well-known/jwks.json` publishes the current key and the previous one, with `Cache-Control: max-age=3600`.
- To rotate, run `ob:setup --rotate-card-key`, which demotes the current key to previous. A card signed with the previous key verifies until it expires.
- The Worker signs, and the hub only authorizes: it returns the attested claim set, and the Worker signs it in the request path that serves the daemon frame. The private key never enters DO storage.

### OA half (owned by OA, summarized for completeness)

- **Backend:**
  - a verifier: JWKS fetched only from the pinned https issuer, with a timeout, a size cap and caching; Ed25519; `iss`, `aud`, `exp` and `owner` pins; a `jti` replay cache
  - the two-step `present_card` tool
  - grant storage
- **Frontend:** an "Attested by <bus>" block on the #587 card, kept separate from the amber "reported by the agent" tag, plus the "Link OpenBus" setting.
- **Matching:** the owner is matched to the OA user who approved the grant, not to the instance owner, because team installs have many users.
- **Visibility:** attested fields show only to that user in Settings. Viewer presence never shows machine or role unless the user opts in to role.
- **Size:** about 3 to 4 days, after OA M1, and it needs the user's OK.

## Threats and mitigations

- **Agent B presents agent A's card:** OA's nonce is bound to B's grant, and the bus signs it only for the attested caller, so A's card carries A's nonce and fails on B's grant.
- **A same-uid local process impersonates a session:** the existing accepted threat model, unchanged.
- **Card theft in transit or in logs:** it expires in 5 minutes, has a one-time `jti`, and only works for a linked `aud`.
- **Rogue audience:** the bus signs only for owner-linked origins, so an agent can't send the owner's id to an arbitrary site.
- **A key leaks:** rotate with `ob:setup --rotate-card-key`. A card is display only, so the blast radius is mislabelled agents in OA.
- **Owner mismatch on team OA installs:** OA pins `owner` per OA user.
- **A role points at a stale agent:** a closed holder makes the role vacant, and sends are refused, never misdelivered.

## Delivery

About 400 lines or less per PR:

| #   | Track             | PR                                                                                                               |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Shared            | schemas: roster `role` and `status*`; `status` and `card_request` frames; the `role_vacant` refusal; card claims |
| 2   | Backend           | hub roles table, send resolution and roles REST                                                                  |
| 3   | Backend           | hub status storage and rate limit                                                                                |
| 4   | Backend           | link flow, `linked_apps`, card signing, JWKS, setup key generation and rotation                                  |
| 5   | Client            | `set_status` and `card` tools in all adapters, plus `self` shows the role; version gate                          |
| 6   | Frontend + Design | dashboard roles editor, status column, Linked apps list and confirm page                                         |
| 7   | OA                | verifier, `present_card`, Link OpenBus and the attested block (OA's own plan)                                    |

Backend's session must be restarted onto the bus before PRs 2 to 4.

## Verification

- A role sent to while vacant is refused, and re-pointing it delivers to the new holder. An agent can't set a role through any tool or frame.
- A status update shows on the dashboard within 2 s, tagged "agent says", and is cleared on close.
- A card verifies against the JWKS in a test OA verifier. It fails for a different `aud`, for one second after `exp`, for a replayed `jti`, and for another grant's nonce.
- After a key rotation, the old card verifies until it expires.
- Unlinking an `aud` stops new cards.
- Staging end to end: a Claude agent links, presents, and shows "Attested by <bus>" in staging OA.

## Left to the builder

The exact frame names, the version-gate number, the dashboard layout (Design's call), and the JWKS cache headers beyond the minimum above.
