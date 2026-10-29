/** Everything the add-a-machine UI says or copies, in one place. */
export const SETUP_COPY = {
  title: "Set up with an agent",
  body: "Paste this into Claude Code, OpenCode or Pi on the new machine. It reads the setup guide and runs the install for you.",
  copyPrompt: "Copy setup prompt",
  copyPromptLabel: "Copy prompt",
  orRun: "Or run it yourself:",
  copyCommand: "Copy command",
  copyInstall: "Copy install command",
} as const;

/** The hub's own origin: the Worker serves this dashboard. */
export const hubOrigin = () => window.location.origin;

export const setupPrompt = (origin: string) =>
  `Add this machine to my OpenBus: follow ${origin}/llms.txt`;

export const installCommand = (origin: string) =>
  `npx @open-bus/cli --hub ${origin}`;
