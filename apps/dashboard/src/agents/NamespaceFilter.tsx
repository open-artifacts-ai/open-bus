import { ToggleGroup, ToggleGroupItem } from "@ob/ui/shadcn";

const ALL = "\u0000all";

/** Single-choice namespace chips; `null` means every namespace. */
export function NamespaceFilter({
  namespaces,
  value,
  onChange,
}: {
  namespaces: string[];
  value: string | null;
  onChange(next: string | null): void;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={1}
      aria-label="Namespace"
      value={value ?? ALL}
      // Radix sends "" when the pressed chip is clicked again: keep the choice.
      onValueChange={(v) => {
        if (v) onChange(v === ALL ? null : v);
      }}
      className="w-full flex-wrap"
    >
      <ToggleGroupItem value={ALL}>All</ToggleGroupItem>
      {namespaces.map((n) => (
        <ToggleGroupItem
          key={n}
          value={n}
          className="max-w-full shrink truncate font-mono text-xs"
        >
          {n}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
