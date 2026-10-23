import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@ob/ui/shadcn";

export type RevokeTarget = { id: string; label: string };

/**
 * Revoking is irreversible from the dashboard: the machine must run
 * `npx open-bus` and be approved again. So the dialog names the machine, says
 * so, and needs a second, explicitly worded click. Focus starts on Cancel
 * (Radix's AlertDialog default), never on the destructive button.
 *
 * Feedback: while `busy`, the confirm reads "Revoking…" and both buttons are
 * disabled; Escape still closes it (the request carries on). A failure shows
 * inline here while the dialog is open; the page toasts it otherwise.
 */
export function RevokeDialog({
  open,
  target,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  /** Kept after closing, so the content doesn't vanish mid-animation. */
  target: RevokeTarget | null;
  busy: boolean;
  error: string | null;
  onConfirm(): void;
  onClose(): void;
}) {
  return (
    <AlertDialog
      open={open && target !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={(e) => {
          // No AlertDialogTrigger here, so return focus ourselves: to the
          // row's button if it is still there, else to the page.
          e.preventDefault();
          const id = target?.id;
          const button = id
            ? document.querySelector<HTMLElement>(
                `[data-machine-id="${CSS.escape(id)}"]`,
              )
            : null;
          (button ?? document.getElementById("ob-main"))?.focus();
        }}
      >
        {target && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke {target.label}?</AlertDialogTitle>
              <AlertDialogDescription>
                Its agents leave the roster, its connection closes, and mail to
                them is refused. It can join again only by running{" "}
                <code className="font-mono">npx open-bus</code> and being
                approved. This can't be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error && (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                Couldn't revoke {target.label}. {error}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={busy}
                onClick={(e) => {
                  // Stay open until the result is known.
                  e.preventDefault();
                  onConfirm();
                }}
              >
                {busy ? "Revoking…" : "Revoke machine"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
