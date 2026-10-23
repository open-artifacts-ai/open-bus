import { Badge, Button, TableCell, TableRow } from "@ob/ui/shadcn";
import type { Machine } from "../api/contract";

/** "3 minutes ago"; never "Invalid Date". */
export const ago = (iso: string, now = Date.now()) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "at an unknown time";
  const secs = Math.round((now - t) / 1000);
  if (secs < 60) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const [n, unit]: [number, Intl.RelativeTimeFormatUnit] =
    secs < 3600
      ? [Math.round(secs / 60), "minute"]
      : secs < 86400
        ? [Math.round(secs / 3600), "hour"]
        : [Math.round(secs / 86400), "day"];
  return rtf.format(-n, unit);
};

/** The activity line: when it was revoked, or when its token was last used. */
export const activity = (m: Machine) =>
  m.revokedAt
    ? `Revoked ${ago(m.revokedAt)}`
    : m.lastUsed
      ? `Used ${ago(m.lastUsed)}`
      : "Never used";

/**
 * One machine. Revoked machines stay listed (struck through, with a badge) and
 * have no revoke button. The button carries `data-machine-id` so the dialog
 * can hand focus back to it on close.
 */
export function MachineRow({
  machine,
  onRevoke,
}: {
  machine: Machine;
  onRevoke(m: Machine): void;
}) {
  const revoked = machine.revokedAt !== null;
  const when = activity(machine);
  return (
    <TableRow>
      <TableCell className="w-full max-w-0 py-3">
        <div
          className={
            revoked
              ? "truncate text-muted-foreground line-through"
              : "truncate font-medium"
          }
        >
          {machine.label}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          <code className="font-mono">{machine.id}</code>
          <span className="sm:hidden"> · {when}</span>
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground max-sm:hidden">
        {when}
      </TableCell>
      <TableCell className="text-right">
        {revoked ? (
          <Badge variant="secondary">Revoked</Badge>
        ) : (
          <Button
            variant="outline"
            size="sm"
            data-machine-id={machine.id}
            aria-label={`Revoke ${machine.label}`}
            onClick={() => onRevoke(machine)}
          >
            Revoke
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
