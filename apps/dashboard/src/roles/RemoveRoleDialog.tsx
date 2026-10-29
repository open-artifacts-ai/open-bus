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
import type { Role } from "../api/contract";
import { focusRow } from "./focus";

/**
 * Confirms removing a role. Removal is optimistic (useRemoveRole), so the
 * confirm closes at once; the page toasts a failure and the row comes back.
 * Focus starts on Cancel (Radix's AlertDialog default).
 */
export function RemoveRoleDialog({
  open,
  target,
  onConfirm,
  onClose,
}: {
  open: boolean;
  /** Kept after closing, so the content doesn't vanish mid-animation. */
  target: Role | null;
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
        className="border-0 shadow-(--ob-shadow-2)"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          focusRow(target);
        }}
      >
        {target && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="[overflow-wrap:anywhere]">
                Remove <bdi className="font-mono">{target.role}</bdi>?
              </AlertDialogTitle>
              <AlertDialogDescription>
                The role stops pointing at any agent. The agent keeps running
                under its own name.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                // Reads "Remove"; the name says what goes, for e2e and AT.
                aria-label="Remove role"
                onClick={onConfirm}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
