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
  // secrets
  ACCESS_CLIENT_SECRET: string;
  /** HKDF input for every cookie key (auth/keys.ts); at least 32 characters. */
  SESSION_SECRET: string;
  /** The hub Durable Object: one per owner (hub/stub.ts). */
  HUB: DurableObjectNamespace<import("./hub/do.js").Hub>;
  /**
   * GET /auth/login per client IP (B11; wired by B1b). Optional: unbound in
   * tests and dev, where http/rate-limit.ts lets the request through.
   */
  RL_AUTH?: RateLimit;
}
