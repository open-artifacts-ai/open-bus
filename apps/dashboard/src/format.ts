/** "10:42 AM": when a paused list was last current. */
export const clock = (d: Date) =>
  new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(
    d,
  );

const DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "Oct 21, 2026"; never "Invalid Date". */
export const day = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "Unknown" : DAY.format(t);
};

/**
 * "2 min ago", "3 h ago", "4 d ago", then the date; never "Invalid Date".
 * Each unit is rounded first and rolls over, so it never reads "60 min" or "24 h".
 */
export const ago = (iso: string, now = Date.now()) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Unknown";
  const secs = (now - t) / 1000;
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(secs / 3600);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(secs / 86400);
  if (days < 7) return `${days} d ago`;
  return day(iso);
};

/** An error's message for a toast or an inline alert. */
export const messageOf = (e: unknown) =>
  e instanceof Error && e.message ? e.message : "Something went wrong.";
