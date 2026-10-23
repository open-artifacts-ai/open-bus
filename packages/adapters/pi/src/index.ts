import { fileURLToPath } from "node:url";

/**
 * The Pi extension `open-bus install` copies into Pi's extensions directory.
 * It is standalone: Pi loads it with nothing but node built-ins.
 */
export const PI_EXTENSION = fileURLToPath(
  new URL("../assets/openbus.ts", import.meta.url),
);
