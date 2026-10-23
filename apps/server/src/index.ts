import { app } from "./app.js";
import type { Env } from "./env.js";
import { handle } from "./handle.js";

export type { Env } from "./env.js";
export { Hub } from "./hub/do.js";

export default {
  fetch: (req, env, ctx) => handle(app, req, env, ctx),
} satisfies ExportedHandler<Env>;
