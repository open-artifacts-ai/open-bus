import type { ReactNode } from "react";

/** A number or name in the summaries: mono, full-strength text. */
export const Mono = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-foreground">{children}</span>
);
