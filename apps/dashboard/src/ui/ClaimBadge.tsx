import { type Status, StatusBadge } from "@ob/ui/composites";

/** Muted by token colour, never opacity: a faded Live badge fails AA. */
const MUTED = "bg-secondary text-muted-foreground";

/**
 * A StatusBadge that is a claim about now. `muted` is the clock time the
 * claim was last current while live updates are paused (see usePaused): the
 * badge greys and its label says "as of". The word never changes.
 */
export function ClaimBadge({
  status,
  subject,
  muted,
}: {
  status: Status;
  /** Who the claim is about: "claude-1 on studio-mbp", "studio-mbp". */
  subject: string;
  muted: string | null;
}) {
  return (
    <StatusBadge
      status={status}
      role="img"
      aria-label={
        muted
          ? `${subject}, ${status} as of ${muted}`
          : `${subject} is ${status}`
      }
      data-muted={muted ? "true" : undefined}
      className={muted ? MUTED : undefined}
    />
  );
}
