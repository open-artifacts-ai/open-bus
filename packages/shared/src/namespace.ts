import { z } from "zod";
import { LIMITS } from "./limits.js";

/**
 * Normalized repo identity: `host/owner/repo`, lowercased, no scheme, no user,
 * no port, no `.git`, no trailing slash. `github.com/Acme/Widgets.git` on one
 * machine equals `https://github.com/acme/widgets` on another.
 */
export function normalizeRemote(remote: string): string | null {
  let s = remote.trim();
  if (!s || s.startsWith("/") || s.startsWith(".") || s.startsWith("file:"))
    return null;
  const scp =
    /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}):(?!\/\/)(.+)$/.exec(s);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    if (!/^(?:https?|ssh|git):\/\//i.test(s)) return null;
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    s = `${u.hostname}${u.pathname}`;
  }
  s = s
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^www\./, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}\/[a-z0-9._/-]*[a-z0-9._-]$/.test(s))
    return null;
  return s.slice(0, LIMITS.maxNamespaceChars);
}

const sanitize = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-./]+|[-./]+$/g, "")
    .slice(0, LIMITS.maxNamespaceChars);

/**
 * The spec's fallback chain: normalized remote -> git root directory name ->
 * cwd basename -> "default". Pure: the caller supplies what it found on disk.
 */
export function namespaceFrom(input: {
  remoteUrl: string | null;
  gitRootName: string | null;
  cwd: string;
}): string {
  const remote = input.remoteUrl ? normalizeRemote(input.remoteUrl) : null;
  if (remote) return remote;
  const root = input.gitRootName ? sanitize(input.gitRootName) : "";
  if (root) return root;
  const base = input.cwd.split("/").filter(Boolean).pop() ?? "";
  return sanitize(base) || "default";
}

export const NamespaceSchema = z
  .string()
  .min(1)
  .max(LIMITS.maxNamespaceChars)
  .refine(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
    (s) => s === s.trim() && !/[\u0000-\u001f\u007f]/.test(s),
    "invalid namespace",
  );
