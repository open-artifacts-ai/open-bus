import { useEffect } from "react";

/** `<page> · OpenBus`, and back to the previous title on unmount. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const before = document.title;
    document.title = `${title} · OpenBus`;
    return () => {
      document.title = before;
    };
  }, [title]);
}
