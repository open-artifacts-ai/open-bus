export interface Env {
  ASSETS?: Fetcher;
  // vars
  /** Public host, no scheme. A var in wrangler.jsonc; deploy-staging overrides it with --var. */
  APP_HOST: string;
  /** The one owner allowed to sign in. deploy-staging passes it with --var. */
  OWNER_EMAIL: string;
  /** "dev" drops the __Host- cookie prefix and Secure; set only by the test config. */
  ENVIRONMENT: "dev" | "production";
  /** Access team domain, e.g. `team.cloudflareaccess.com`. deploy-staging passes it with --var. */
  ACCESS_TEAM_DOMAIN: string;
  /** Access for SaaS OIDC client id. deploy-staging passes it with --var. */
  ACCESS_CLIENT_ID: string;
  /** Set by deploy (--var); /healthz reports it. "dev" when unset. */
  VERSION?: string;
  // bindings
  /** The hub Durable Object: one per owner (hub/stub.ts). */
  HUB: DurableObjectNamespace<import("./hub/do.js").Hub>;
  /**
   * Device flow per client IP (B4): POST /device/code, POST /device/token and
   * the approval page. Optional: unbound in tests and dev (and until Platform
   * wires it), where http/rate-limit.ts lets the request through and the
   * hub's own caps bound the work (MAX_DEVICE_CODES, per-row slow_down).
   */
  RL_DEVICE?: RateLimit;
  /**
   * GET /auth/login per client IP (B11; wired by B1b). Optional: unbound in
   * tests and dev, where http/rate-limit.ts lets the request through.
   */
  RL_AUTH?: RateLimit;
  // secrets
  ACCESS_CLIENT_SECRET: string;
  /** HKDF input for every cookie key (auth/keys.ts); at least 32 characters. */
  SESSION_SECRET: string;
}
