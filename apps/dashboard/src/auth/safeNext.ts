/** Paths the Worker owns: never a post-sign-in destination. */
const WORKER = /^\/(auth|api)(\/|$|\?|#)/i;

/**
 * Where to send the owner after sign-in: a same-origin path with a single
 * leading `/`, outside /auth and /api. Anything else becomes `/`.
 */
export function safeNext(path: string): string {
  if (!path.startsWith("/")) return "/";
  if (path.startsWith("//") || path.includes("\\")) return "/";
  if (WORKER.test(path)) return "/";
  return path;
}
