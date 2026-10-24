/** Paths the Worker owns: never a post-sign-in destination. */
const WORKER = /^\/(auth|api)(\/|$)/i;

/** Control characters and backslashes: URL parsers strip or rewrite them. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const UNSAFE = /[\x00-\x1f\x7f\\]/;

/**
 * Where to send the owner after sign-in: a same-origin path, resolved the way
 * the browser will resolve it, outside /auth and /api. Anything else is `/`.
 */
export function safeNext(path: string, origin = location.origin): string {
  if (!path.startsWith("/") || UNSAFE.test(path)) return "/";
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return "/";
  }
  if (url.origin !== origin || WORKER.test(url.pathname)) return "/";
  const out = url.pathname + url.search + url.hash;
  // Dot segments can leave "//evil" (/.//evil, /a/..//evil): protocol-relative,
  // off-site once the browser follows it. The output must stay on this origin.
  if (out.startsWith("//") || new URL(out, origin).origin !== origin)
    return "/";
  return out;
}
