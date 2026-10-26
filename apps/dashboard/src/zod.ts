import { config } from "zod";

// Imported first by main.tsx, before any schema parses. Zod's JIT probes
// `new Function("")` on first use; the throw is caught, but the SPA's strict
// CSP (no 'unsafe-eval') still reports it as a violation. jitless skips the
// probe; the dashboard's payloads are small, so the interpreted path is fine.
config({ jitless: true });
