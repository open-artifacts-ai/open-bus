import { Button, Card } from "@ob/ui/shadcn";
import { CopyIcon } from "../layout/icons";
import { copy } from "../layout/identity";
import { hubOrigin, installCommand, SETUP_COPY, setupPrompt } from "./setup";

/** How to add a machine: an agent prompt to paste, or the raw command. */
export function SetupCard() {
  const origin = hubOrigin();
  const prompt = setupPrompt(origin);
  const command = installCommand(origin);
  return (
    <Card
      role="note"
      className="gap-3 rounded-lg px-4 py-4 text-left shadow-none"
    >
      <h2 className="text-sm font-semibold">{SETUP_COPY.title}</h2>
      <p className="text-sm text-muted-foreground">{SETUP_COPY.body}</p>
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-secondary py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 break-all font-mono text-xs">
          {prompt}
        </code>
        <Button
          variant="outline"
          size="sm"
          aria-label={SETUP_COPY.copyPrompt}
          onClick={() => copy(prompt)}
        >
          <CopyIcon />
          {SETUP_COPY.copyPromptLabel}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{SETUP_COPY.orRun}</p>
      <div className="flex items-center gap-1 rounded-md border bg-secondary py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 break-all font-mono text-xs">
          {command}
        </code>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={SETUP_COPY.copyCommand}
          onClick={() => copy(command)}
        >
          <CopyIcon />
        </Button>
      </div>
    </Card>
  );
}
