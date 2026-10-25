# omp live probe (C23b), 2026-10-25

The real oh-my-pi (`omp` 18.12.6, bun) loading the OpenBus omp extension,
against a real daemon (`runDaemon`, real attest, version 0.45.0) and the
in-process fake hub (`e2e/staging/fake-hub.ts`). macOS arm64.

## Isolation

- Temp `HOME`, `OPENBUS_HOME` and `PI_CODING_AGENT_DIR`; the agent dir held only
  `extensions/openbus.ts` (the omp copy: `ompExtension(stampPi(asset, "0.45.0"))`)
  and a `models.yml`.
- No credentials, no network: `models.yml` named one provider, `stub`
  (`api: openai-completions`, `auth: none`), served by a scripted
  OpenAI-compatible stub on 127.0.0.1 in the driver process.
- One run: `omp -p --model stub/stub-1 --no-session --no-title --no-lsp
  --auto-approve "start"`, spawned by the driver, exit 0, then the daemon, hub
  and stub stopped. No process left behind; the real `~/.omp`, `~/.openbus` and
  the user's daemon untouched.

## The stub's script

Every session (root or subagent): call `self`; then `task` with one item; then
`wait`; then answer text. omp adds a required `i` ("intent") string to every
tool's parameters; the stub sends it, and our tools ignore it.

## Results

1. **Plain JSON-Schema `parameters` load.** The first model request listed
   `list_agents`, `send_message`, `fetch` and `self` as top-level tools
   (`loadMode: "essential"`; omp's default would have left them discoverable),
   each with our schema plus omp's `i`. Example, as sent to the model:

   ```json
   "send_message": {"type": "object", "properties": {"i": {"type": "string",
     "description": "concise intent"}, "to": {"type": "string"}, "text":
     {"type": "string"}, "to_namespace": {"type": "string", "description":
     "The recipient's namespace, when a global agent's target name exists in
     several."}}, "required": ["to", "text", "i"], "additionalProperties": false}
   ```

2. **`session_start` fires.** The root session said hello as `omp` and was
   attested by `ps -o lstart=` on the bun process. The root's `self` returned:

   ```json
   {"name": "omp", "namespace": "omp-probe", "kind": "omp", "live": true, "global": false}
   ```

   The hub registered one agent, `kind: "omp"`, name `omp` (no session name).

3. **The subagent guard holds.** `task` spawned a subagent in the same process
   (`AlternativeBobcat`), which spawned its own (`AlternativeBobcat.DeterminedWombat`).
   Both had our tools (omp rebinds extensions per subagent), and each one's
   `self` call returned, verbatim:

   ```
   openbus: a subagent is not on the bus; only the main omp session can use OpenBus
   ```

   Sampled every 100 ms while omp ran, the hub never held more than the one
   root agent, and at the end the daemon's table held one record (the root's
   ref). Both subagents completed; when omp exited the daemon closed the root
   agent (`live: false`).

The marker used is `ctx.agent.kind === "sub"`
(`src/extensibility/extensions/types.ts:520-537`, set at `src/sdk.ts:3499`
from `isSubagentSession`, `src/sdk.ts:2198`).
