/** Up to two initials for an avatar: "leo-macbook-pro" → "LM", "Leo Urbina" → "LU". */
export const initials = (s: string) =>
  s
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => (w[0] ?? "").toUpperCase())
    .join("") || "?";

/** A stable avatar hue (0–359) for an id, so a machine keeps its color. */
export const hue = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + (c.codePointAt(0) ?? 0)) >>> 0;
  return h % 360;
};

/** Copies text; a denied or missing clipboard fails silently, as in the handoff. */
export const copy = (text: string) => {
  navigator.clipboard?.writeText(text).catch(() => {});
};
