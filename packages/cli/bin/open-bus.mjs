#!/usr/bin/env node
// Runs the TypeScript sources through jiti until C10 ships a bundle.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { main } = await jiti.import("../src/main.ts");
const code = await main(process.argv.slice(2));
if (code !== undefined) process.exit(code);
