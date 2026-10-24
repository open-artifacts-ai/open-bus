# @ob/dashboard

The OpenBus dashboard: two routes, machines (with revoke) and the live agents/namespaces view.
- `pnpm dev`: Vite on :5173; `vite.config.ts` proxies `/api` and `/auth` to :8787 (`wrangler dev`).
- `VITE_MOCK=1 pnpm dev`: no server. MSW serves the `@ob/shared/mocks` fixtures; `window.__obMock` pushes roster frames (used by e2e). A production build refuses `VITE_MOCK=1`.
- `pnpm test`: vitest (node + jsdom).
- `pnpm test:e2e`: Playwright (chromium + webkit) against Vite with `VITE_MOCK=1`; set `E2E_PORT` to change the port.
- All UI comes from `@ob/ui` (shadcn superset). Style import order: `fonts.css`, `tokens.css`, `shadcn.css`.

The approval page is the Worker's (Backend); the landing page is `apps/landing` (Design).

## Real-server smoke

`pnpm test:real` runs `e2e/real` (chromium and webkit) against a server you start; nothing is mocked and there is no webServer. `OB_E2E_BASE` sets the target (default `http://localhost:8787`). The mocked `pnpm test:e2e` never picks these up.
- Local: serve the built dashboard from a Worker with `ENVIRONMENT=dev` on loopback (`/auth/dev-login` signs in), then `pnpm test:real`.
- Staging: set `E2E_STORAGE_STATE` to a storageState file from one real Access login (`~/.openbus/e2e-staging-state.json`, shared with I7; never commit or print it). Optional: `E2E_OWNER_EMAIL`, `E2E_ACCESS_TEAM_DOMAIN`.
- `smoke.spec.ts` is read-only and safe on staging.
- `not-you.spec.ts` is destructive: logout signs out everywhere (#154), so it kills the shared storage state for every browser and for I7. It is skipped unless `E2E_NOT_YOU=1`. Run one project at a time (`--project chromium`, then `--project webkit`), each needing a fresh login. It leaves its device code unapproved.
