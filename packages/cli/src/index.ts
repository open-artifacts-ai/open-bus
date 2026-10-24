import { parseArgs } from "node:util";

export type Harness = "claude" | "opencode" | "pi";
export type Command = (
  | {
      cmd: "install";
      hub?: string;
      yes: boolean;
      check: boolean;
      noOpen: boolean;
    }
  | { cmd: "login"; hub?: string; noOpen: boolean }
  | { cmd: "daemon"; hub?: string; home?: string }
  | { cmd: "mcp"; harness: Harness }
  | { cmd: "status" }
  | { cmd: "logs" }
  | { cmd: "doctor" }
  | { cmd: "uninstall"; purge: boolean }
  | { cmd: "version" }
) & { noColor: boolean };

const COMMANDS = new Set([
  "install",
  "login",
  "daemon",
  "mcp",
  "status",
  "logs",
  "doctor",
  "uninstall",
  "version",
]);
const HARNESSES = ["claude", "opencode", "pi"];

export { main } from "./main.ts";

export function parse(argv: string[]): Command {
  const [head, ...rest] = argv;
  const sub = head !== undefined && !head.startsWith("-");
  const cmd = sub ? head : "install";
  if (!COMMANDS.has(cmd)) throw new Error(`unknown command: ${cmd}`);
  const { values, positionals } = parseArgs({
    args: sub ? rest : argv,
    allowPositionals: true,
    options: {
      hub: { type: "string" },
      home: { type: "string" },
      "no-open": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      check: { type: "boolean", default: false },
      purge: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      "no-color": { type: "boolean", default: false },
    },
  });
  const noColor = values["no-color"];
  if (values.version) return { cmd: "version", noColor };
  const parsed = route(cmd, values, positionals);
  return { ...parsed, noColor } as Command;
}

type Values = {
  hub?: string;
  home?: string;
  "no-open": boolean;
  yes: boolean;
  check: boolean;
  purge: boolean;
};

function route(cmd: string, values: Values, positionals: string[]) {
  switch (cmd) {
    case "login":
      return { cmd, hub: values.hub, noOpen: values["no-open"] };
    case "daemon":
      return { cmd, hub: values.hub, home: values.home };
    case "mcp": {
      const harness = positionals[0] ?? "";
      if (!HARNESSES.includes(harness))
        throw new Error("usage: open-bus mcp <claude|opencode|pi>");
      return { cmd, harness: harness as Harness };
    }
    case "uninstall":
      return { cmd, purge: values.purge };
    case "install":
      return {
        cmd,
        hub: values.hub,
        yes: values.yes,
        check: values.check,
        noOpen: values["no-open"],
      };
    case "status":
    case "logs":
    case "doctor":
    case "version":
      return { cmd };
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}
