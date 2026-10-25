// Adapted from assistant-ui (MIT, see LICENSE): packages/ui/src/components/react/ui/radix/dialog.tsx at tag @assistant-ui/react@0.15.31.
// Nest changes: forwardRef for React 18.3; relative imports; the portal renders into .nest-chat-portal (portal.tsx);
// the overlay uses bg-foreground/10 (dark: bg-background/70) instead of bg-black/10 (no colour literals in the chat).
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "./lib/utils";
import { Button } from "./button";
import { useChatPortal } from "./portal";

function Dialog({
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

const DialogTrigger = forwardRef<
  ElementRef<typeof DialogPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>
>((props, ref) => <DialogPrimitive.Trigger ref={ref} data-slot="dialog-trigger" {...props} />);
DialogTrigger.displayName = "DialogTrigger";

function DialogPortal({
  ...props
}: Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Portal>, "container">) {
  const container = useChatPortal();
  if (!container) return null;
  return <DialogPrimitive.Portal data-slot="dialog-portal" container={container} {...props} />;
}

const DialogClose = forwardRef<
  ElementRef<typeof DialogPrimitive.Close>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>((props, ref) => <DialogPrimitive.Close ref={ref} data-slot="dialog-close" {...props} />);
DialogClose.displayName = "DialogClose";

const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-slot="dialog-overlay"
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=open]:animate-in fixed inset-0 isolate z-50 bg-foreground/10 dark:bg-background/70 duration-100 supports-backdrop-filter:backdrop-blur-xs",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = "DialogOverlay";

const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean;
  }
>(({ className, children, showCloseButton = true, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      data-slot="dialog-content"
      className={cn(
        "data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 bg-popover text-popover-foreground ring-foreground/10 data-[state=closed]:animate-out data-[state=open]:animate-in fixed start-[50%] top-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl p-5 text-sm ring-1 duration-100 outline-none sm:max-w-sm rtl:-translate-x-[-50%]",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close
          data-slot="dialog-close"
          className="focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute end-4 top-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:outline-hidden focus-visible:ring-1 disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = "DialogContent";

function DialogHeader({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-slot="dialog-title"
    className={cn(
      "cn-font-heading text-base leading-none font-medium",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = "DialogTitle";

const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-slot="dialog-description"
    className={cn("text-muted-foreground text-sm", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
