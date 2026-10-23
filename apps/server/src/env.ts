export interface Env {
  ASSETS?: Fetcher;
  /** Public host, no scheme. A var in wrangler.jsonc; deploy-staging overrides it with --var. */
  APP_HOST: string;
  /** Set by deploy (--var); /healthz reports it. "dev" when unset. */
  VERSION?: string;
  /** The hub Durable Object: one per owner (hub/stub.ts). */
  HUB: DurableObjectNamespace<import("./hub/do.js").Hub>;
}
