/**
 * A summary's "· K live". While `muted` (the stream is paused) the count is
 * a past claim: it greys by colour like the badges, never by opacity.
 */
export function LiveCount({ n, muted }: { n: number; muted: boolean }) {
  return muted ? (
    <span data-muted="true">
      · <span className="font-mono">{n}</span> live
    </span>
  ) : (
    <span>
      · <span className="font-mono text-foreground">{n}</span> live
    </span>
  );
}
