// Adapted from assistant-ui (MIT, see LICENSE): packages/ui/src/components/react/assistant-ui/elements/thread.aui.tsx
// at tag @assistant-ui/react@0.15.31. Nest keeps only the viewport, viewport footer and scroll-to-bottom markup
// (ThreadRoot's Viewport and ThreadScrollToBottom); primitives come through ../aui.
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { ArrowDownIcon } from "lucide-react";

import { ThreadPrimitive } from "../aui";
import { TooltipIconButton } from "./tooltip-icon-button";
import { cn } from "./lib/utils";

export const ThreadViewport = forwardRef<
  ElementRef<typeof ThreadPrimitive.Viewport>,
  ComponentPropsWithoutRef<typeof ThreadPrimitive.Viewport>
>(({ className, ...props }, ref) => (
  <ThreadPrimitive.Viewport
    ref={ref}
    turnAnchor="top"
    data-slot="aui_thread-viewport"
    className={cn("relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth", className)}
    {...props}
  />
));
ThreadViewport.displayName = "ThreadViewport";

export const ThreadViewportFooter = forwardRef<
  ElementRef<typeof ThreadPrimitive.ViewportFooter>,
  ComponentPropsWithoutRef<typeof ThreadPrimitive.ViewportFooter>
>(({ className, ...props }, ref) => (
  <ThreadPrimitive.ViewportFooter
    ref={ref}
    className={cn("aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-4 md:pb-6 sticky bottom-0 mt-auto", className)}
    {...props}
  />
));
ThreadViewportFooter.displayName = "ThreadViewportFooter";

export function ThreadScrollToBottom() {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
}
