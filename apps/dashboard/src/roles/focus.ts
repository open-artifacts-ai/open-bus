import type { Role } from "../api/contract";

/** A role's key in the DOM: its namespace and name, which together are unique. */
export const roleKey = (r: Pick<Role, "namespace" | "role">) =>
  `${r.namespace} ${r.role}`;

/**
 * Dialogs here have no trigger, so they return focus themselves: to the
 * role's Re-point button if its row is still there, else to the page.
 */
export const focusRow = (r: Pick<Role, "namespace" | "role"> | null) => {
  const button = r
    ? document.querySelector<HTMLElement>(
        `[data-role-key="${CSS.escape(roleKey(r))}"]`,
      )
    : null;
  (button ?? document.getElementById("ob-main"))?.focus();
};
