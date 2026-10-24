# @ob/dashboard

The OpenBus dashboard: two routes, machines (with revoke) and the live agents/namespaces view.

- `pnpm dev`: Vite on :5173; `vite.config.ts` proxies `/api` and `/auth` to :8787 (`wrangler dev`).
- `VITE_MOCK=1 pnpm dev`: no server. MSW serves the `@ob/shared/mocks` fixtures; `window.__obMock` pushes roster frames (used by e2e). A production build refuses `VITE_MOCK=1`.
- `pnpm test`: vitest (node + jsdom).
- `pnpm test:e2e`: Playwright (chromium + webkit) against Vite with `VITE_MOCK=1`; set `E2E_PORT` to change the port.
- All UI comes from `@ob/ui` (shadcn superset). Style import order: `fonts.css`, `tokens.css`, `shadcn.css`.
- The real-server suite (FE9) is pending Backend routes.

The approval page is the Worker's (Backend); the landing page is `apps/landing` (Design).
