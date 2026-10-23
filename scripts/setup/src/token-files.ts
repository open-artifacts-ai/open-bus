import type { Fs } from "./cf.ts";
import { NeedInput } from "./step.ts";

/**
 * A token from a 0600 file you own, so it never enters a chat: undefined when
 * the file does not exist. Values are never echoed, stored or put in a message.
 */
export function readTokenFile(fs: Fs, path: string): string | undefined {
  const f = fs.readToken?.(path);
  if (f === null) return undefined;
  if (f === undefined || process.getuid === undefined)
    throw new NeedInput(
      `cannot check the permissions of ${path} on this platform (use WSL on Windows)`,
    );
  if (!f.isFile || f.uid !== process.getuid())
    throw new NeedInput(
      `${path} must be a regular file you own (symlinks are refused)`,
    );
  if (f.mode & 0o077)
    throw new NeedInput(`${path} is readable by others; run chmod 600 ${path}`);
  const token = f.text.trim();
  if (!token) throw new NeedInput(`${path} is empty; save the token again`);
  if (!/^[\x21-\x7e]+$/.test(token))
    throw new NeedInput(`${path}: the token must be one line`);
  return token;
}
