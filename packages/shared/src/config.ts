import { z } from "zod";
import { NamespaceSchema } from "./namespace.js";

export const CONFIG_FILE = ".openbus.json";

/**
 * Read from the directory where the session starts, or any parent. Both keys
 * are optional; `global` is never implied.
 */
export const OpenBusConfigSchema = z.strictObject({
  namespace: NamespaceSchema.optional(),
  global: z.boolean().optional(),
});
export type OpenBusConfig = z.infer<typeof OpenBusConfigSchema>;

/**
 * Merges configs ordered nearest-first (the session directory, then its
 * parents). Per key, the nearest file that sets it wins.
 */
export function mergeConfigs(configs: OpenBusConfig[]): OpenBusConfig {
  const out: OpenBusConfig = {};
  for (const c of configs) {
    if (out.namespace === undefined && c.namespace !== undefined)
      out.namespace = c.namespace;
    if (out.global === undefined && c.global !== undefined)
      out.global = c.global;
  }
  return out;
}
