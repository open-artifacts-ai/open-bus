import type { Env } from "./env.js";
import { ApiError, toErrorResponse } from "./http/errors.js";
import { withSecurityHeaders } from "./http/middleware.js";

type Fetchable = {
  fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Response | Promise<Response>;
};

/**
 * Hono hands only `instanceof Error` throws to onError; anything else would
 * escape as a Worker 1101. Catch it here and answer the standard 500 envelope,
 * never the thrown value.
 */
export async function handle(
  app: Fetchable,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    return await app.fetch(req, env, ctx);
  } catch {
    return withSecurityHeaders(
      toErrorResponse(new ApiError("internal", "Internal error")),
      env,
    );
  }
}
