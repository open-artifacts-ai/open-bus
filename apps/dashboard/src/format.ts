/** "10:42 AM": when a paused list was last current. */
export const clock = (d: Date) =>
  new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(
    d,
  );
