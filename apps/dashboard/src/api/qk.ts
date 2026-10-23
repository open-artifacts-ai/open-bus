/** Every cache key the dashboard uses. The SSE hook writes these directly. */
export const qk = {
  me: ["me"] as const,
  machines: ["machines"] as const,
  agents: ["agents"] as const,
};
