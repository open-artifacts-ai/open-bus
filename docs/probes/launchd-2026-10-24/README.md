# launchd: one real bootstrap (2026-10-24)

The user approved one real `launchctl bootstrap` on a macOS dev machine (manager request; the user confirmed directly in the client lead's session). It ran exactly once.

**Method.** `svc.mjs` drives the CLI's own service step, `realCtx().service.ensure()` / `.remove()` (packages/cli/src/steps/service.ts), from the workspace sources, so nothing was done by hand. It used a temporary non-default `OPENBUS_HOME` (label `ai.open-bus.daemon.42310078`), so the real `~/.openbus` was never touched. `machine.json` held a fake, well-formed token and an unreachable hub (`http://127.0.0.1:9`). No harness was configured: `install` was not run, because it would also wire Claude, OpenCode and Pi and restart the OpenCode service.

**Result.**
- `before.txt`: no `open-bus` job loaded or installed.
- `ensure.json`, `loaded.txt`: the plist was written to `~/Library/LaunchAgents/ai.open-bus.daemon.42310078.plist` (`plutil -lint` OK) and bootstrapped into `gui/$UID`. launchd ran the stable bin copy under `<home>/bin` with node, and the daemon started and wrote `<home>/logs/daemon.log`.
- The daemon then exited 1: the temp home's socket path was 162 bytes, over macOS's 103-byte `sun_path` limit (`listen EINVAL`). The cause is the probe's long scratch path, but it exposed a real bug: that exit is non-zero, so `KeepAlive {SuccessfulExit=false}` restarts the daemon in a loop (2 restarts logged in about 10 s). Fixed in C15.
- `remove.json`, `after.txt`: the CLI's `remove()` booted the job out and deleted the plist. `launchctl print` no longer finds the label, no daemon process is left, and `~/Library/LaunchAgents` is identical to `before.txt`.

Local paths are redacted (`~`, `<tmp>`, `<uid>`). The token in the temp home was fake and is not included.
