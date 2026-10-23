import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

/** The shell header's slot for the current page's title and actions. */
export const HeaderSlotContext = createContext<HTMLElement | null>(null);

/**
 * Renders a page's title and actions in the shell header, as in Design's
 * handoff (`<nav aria-label="Breadcrumb"><h1>` then the actions at the end).
 * Nothing renders until the shell has mounted its header.
 */
export function PageHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  const slot = useContext(HeaderSlotContext);
  if (!slot) return null;
  return createPortal(
    <>
      <nav aria-label="Breadcrumb" className="min-w-0">
        <h1 className="truncate text-sm font-medium">{title}</h1>
      </nav>
      {children}
    </>,
    slot,
  );
}
