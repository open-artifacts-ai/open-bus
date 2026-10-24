/**
 * Lowercase hex SHA-256 of a UTF-8 string.
 *
 * Duplicates B1's `util/crypto.ts` helper so B3 does not depend on the held
 * auth PR; whichever of B1 and B3 lands second dedupes to one copy.
 */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  let out = "";
  for (const b of new Uint8Array(digest))
    out += b.toString(16).padStart(2, "0");
  return out;
}
