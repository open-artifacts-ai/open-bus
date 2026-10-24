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
- Local: build the dashboard (`pnpm --filter @ob/dashboard build`), then run the Worker from a copy of `apps/server/wrangler.jsonc` without `routes` (a route makes `wrangler dev` see the custom-domain host, and `/auth/dev-login` 404s), with a gitignored `apps/server/.dev.vars` (`ENVIRONMENT=dev`, `APP_HOST=127.0.0.1:8791`, `OWNER_EMAIL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `SESSION_SECRET`: placeholders). Serve it `--local --local-protocol https --ip 127.0.0.1 --port 8791`: the Worker's origin checks and "Not you?" form want `https://APP_HOST`; the config trusts the self-signed cert on loopback. Then `OB_E2E_BASE=https://127.0.0.1:8791 pnpm test:real`. Each not-you run leaves one pending device code (cap `MAX_DEVICE_CODES`, 10 min); reset `.wrangler/state` if it 429s.
- Staging: set `E2E_STORAGE_STATE` to a storageState file from one real Access login (`~/.openbus/e2e-staging-state.json`, shared with I7; never commit or print it). Optional: `E2E_OWNER_EMAIL`, `E2E_ACCESS_TEAM_DOMAIN`.
- `smoke.spec.ts` is read-only and safe on staging.
- `not-you.spec.ts` is destructive: logout signs out everywhere (#154), so it kills the shared storage state for every browser and for I7. It is skipped unless `E2E_NOT_YOU=1`. Chromium only (it applies form-action to redirects; each run consumes the owner's login): run `--project chromium`; webkit skips it. It leaves its device code unapproved.
