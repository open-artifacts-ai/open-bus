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

/**
 * Confirms unlinking an app. Unlink is optimistic (useUnlinkApp), so the
 * confirm closes at once; the page toasts a failure and the row comes back.
 * The aud is shown verbatim, as text.
 */
export function UnlinkDialog({
  open,
  aud,
  onConfirm,
  onClose,
}: {
  open: boolean;
  /** Kept after closing, so the content doesn't vanish mid-animation. */
  aud: string | null;
  onConfirm(): void;
  onClose(): void;
}) {
  return (
    <AlertDialog
      open={open && aud !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AlertDialogContent className="border-0 shadow-(--ob-shadow-2)">
        {aud && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="[overflow-wrap:anywhere]">
                Unlink {aud}?
              </AlertDialogTitle>
              <AlertDialogDescription className="[overflow-wrap:anywhere]">
                {aud} can no longer verify your agents' cards. Cards it already
                has expire within 5 minutes.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={onConfirm}>
                Unlink
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
