import { z } from "zod";
import { LIMITS } from "./limits.js";

/** 32-bit FNV-1a over UTF-16 code units, as 8 lowercase hex chars. Pure JS. */
function fnv8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const SCHEME_RE = /^(?:https?|ssh|git|git\+ssh|ssh\+git):\/\//i;
const NORMALIZED_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?:\/[a-z0-9._~-]+)+$/;

/**
 * Normalized repo identity: `host/owner/repo`, lowercased, no scheme, no user,
 * no port, no `.git`, no trailing slash, dot segments resolved.
 * `github.com/Acme/Widgets.git` on one machine equals
 * `https://github.com/acme/widgets` on another.
 *
 * Intentional: the port is dropped and the path is lowercased. Clones of one
 * repo reach it through different ports/protocols and casings, and the spec
 * wants them to be one namespace; the cost is that two case-distinct repos on
 * one case-sensitive host merge.
 *
 * Single-label hosts, IPs, localhost, `git+ssh://` and `~user` paths are
 * accepted. Paths longer than the namespace cap are truncated and suffixed
 * with `-` plus an 8-hex FNV-1a hash of the full string, so they stay distinct.
 */
export function normalizeRemote(remote: string): string | null {
  const s = remote.trim();
  if (
    !s ||
    s.startsWith("/") ||
    s.startsWith(".") ||
    s.startsWith("~") ||
    s.startsWith("file:") ||
    s.includes("\\")
  )
    return null;
  let host: string;
  let path: string;
  if (SCHEME_RE.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    host = u.hostname;
    path = u.pathname;
  } else {
    // scp form `[user@]host:path`. Without a user the host must look like a
    // domain, so `foo:bar` and `C:/x` are not mistaken for remotes.
    const scp = /^(?:([^@/\s]+)@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(s);
    if (!scp) return null;
    const [, user, h, p] = scp;
    if (!user && !/\.[A-Za-z]{2,}$/.test(h as string)) return null;
    host = h as string;
    path = p as string;
  }
  const segs: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") segs.pop();
    else segs.push(seg);
  }
  let joined = segs
    .join("/")
    .toLowerCase()
    .replace(/\.git$/, "");
  joined = joined.replace(/\/+$/, "");
  const full = `${host.toLowerCase().replace(/^www\./, "")}/${joined}`;
  if (!NORMALIZED_RE.test(full)) return null;
  if (full.length <= LIMITS.maxNamespaceChars) return full;
  return `${full.slice(0, LIMITS.maxNamespaceChars - 9)}-${fnv8(full)}`;
}

/** A directory name as a namespace slug: diacritics folded, ASCII only. */
const sanitize = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-./]+|[-./]+$/g, "")
    .slice(0, LIMITS.maxNamespaceChars);

/** Slug of a directory name; a name with no ASCII slug becomes `dir-<hash>`. */
function dirNamespace(name: string): string {
  const raw = name.trim();
  if (!raw) return "";
  return sanitize(raw) || `dir-${fnv8(raw)}`;
}

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
  const root = input.gitRootName ? dirNamespace(input.gitRootName) : "";
  if (root) return root;
  const base =
    input.cwd
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? "";
  return dirNamespace(base) || "default";
}

// C0/C1 controls, zero-width, bidi controls, line/paragraph separators, BOM.
const BAD_NS_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/;

/**
 * A namespace. One that parses as a git remote (URL or scp form) is normalized
 * like the auto-derived one, so `.openbus.json` cannot silently split from it;
 * anything else is kept verbatim after validation.
 */
export const NamespaceSchema = z
  .string()
  .min(1)
  .max(LIMITS.maxNamespaceChars * 4)
  .refine((s) => s === s.trim() && !BAD_NS_CHARS.test(s), "invalid namespace")
  .transform((s) => normalizeRemote(s) ?? s)
  .refine((s) => s.length <= LIMITS.maxNamespaceChars, "invalid namespace");
