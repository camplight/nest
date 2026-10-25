// Adapted from assistant-ui (MIT, see LICENSE): packages/ui/src/components/react/assistant-ui/elements/day-separator.tsx
// at tag @assistant-ui/react@0.15.31. Nest changes: takes one `label` (the thread places separators) instead of a message
// list; relative imports. The divider markup and classes are the registry's.
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./lib/utils";
import { mono } from "./surfaces";

export function DaySeparator({
  label,
  className,
  ...props
}: Omit<ComponentPropsWithoutRef<"div">, "children"> & {
  label: string;
}) {
  return (
    <div
      data-slot="day-separator"
      role="separator"
      aria-label={label}
      className={cn("flex items-center gap-2.5 py-1", className)}
      {...props}
    >
      <span className="bg-foreground/[0.08] h-px flex-1" />
      <span className={cn(mono, "text-muted-foreground")}>{label}</span>
      <span className="bg-foreground/[0.08] h-px flex-1" />
    </div>
  );
}
