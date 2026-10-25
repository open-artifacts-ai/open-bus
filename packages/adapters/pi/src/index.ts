import { fileURLToPath } from "node:url";

/**
 * The Pi extension `open-bus install` copies into Pi's extensions directory.
 * It is standalone: Pi loads it with nothing but node built-ins.
 */
export const PI_EXTENSION = fileURLToPath(
  new URL("../assets/openbus.ts", import.meta.url),
);

const KIND_MARKER = 'const KIND = "pi" as "pi" | "omp";';

/**
 * The same extension for oh-my-pi (a Pi fork): one switch flips its kind to
 * `omp`, which names it on the bus and turns on omp's tool and subagent handling.
 */
export function ompExtension(source: string): string {
  if (!source.includes(KIND_MARKER))
    throw new Error("the Pi extension has no KIND to switch");
  return source.replace(KIND_MARKER, 'const KIND = "omp" as "pi" | "omp";');
}
