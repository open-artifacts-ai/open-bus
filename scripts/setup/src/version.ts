import { join } from "node:path";
import type { Ctx } from "./step.ts";

/** The repo root package.json version: what `/healthz` reports once deployed. */
export function repoVersion(ctx: Pick<Ctx, "fs" | "root">): string {
  const text = ctx.fs.read(join(ctx.root, "package.json"));
  let v: unknown;
  try {
    v = text ? JSON.parse(text).version : undefined;
  } catch {}
  if (typeof v !== "string" || !v)
    throw new Error("could not read the version from the repo's package.json");
  return v;
}
