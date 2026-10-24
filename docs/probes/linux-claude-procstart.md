# Claude's `procStart` on Linux

Seen on a real Linux install (Claude Code 2.1.310, `open-bus` 0.43.3): the MCP server found no Claude session, because the daemon and the adapter compared Claude's `procStart` with `ps -o lstart=` and the two never matched.

**Format.** On Linux, Claude writes `procStart` in `~/.claude/sessions/<pid>.json` (and in each `<pid>.<hash>.key`) as field 22 of `/proc/<pid>/stat`, `starttime`: the process start time in clock ticks since boot, as a decimal string. Example: `"207774019"`. One tick is `1/sysconf(_SC_CLK_TCK)` s, 100 Hz on common kernels. On macOS it stays `TZ=UTC LC_ALL=C ps -o lstart=` (`"Sat Oct 24 23:39:56 2026"`).

**Parsing.** Field 2, `comm`, is in parentheses and may itself hold spaces and `)`. `statStartTicks` splits after the last `)`: the rest starts at field 3 (`state`), so field 22 is its 20th token. A missing or unreadable `/proc/<pid>/stat` gives `null`, which refuses the session.

**Why raw ticks.** The only question is whether a pid is still the process that wrote the file. Equal tick strings answer that exactly, the same way Claude does. Converting to wall-clock time needs the boot time and `CLK_TCK`, both inexact (`btime` is whole seconds, `/proc/uptime` drifts against the wall clock), so a conversion would add rounding, not safety.

**Scope.** Only Claude's checks use `claudeProcStartOf`: `findSession` (MCP server), Claude attestation and liveness. Pi writes its own `lstart` and OpenCode presence parses `lstart`; both keep `procStartOf`.
