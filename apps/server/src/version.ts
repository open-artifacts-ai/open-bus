import type { Env } from "./env.js";

export const version = (env: Pick<Env, "VERSION">): string =>
  env.VERSION?.trim() || "dev";
