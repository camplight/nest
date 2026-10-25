// Nest-written: the .nest-chat-portal container every chat portal (dialog, tooltip) renders into (spec 8.6).
import { createContext, useContext, useState, type ReactNode } from "react";

const PortalContext = createContext<HTMLElement | null>(null);

/** Renders its children and, after them, the `div.nest-chat-portal` that chat portals target. */
export function ChatPortalProvider({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <PortalContext.Provider value={container}>
      {children}
      <div className="nest-chat-portal" ref={setContainer} />
    </PortalContext.Provider>
  );
}

/** The portal container, or null before it mounts or outside a ChatPortalProvider; portals render nothing then. */
export const useChatPortal = () => useContext(PortalContext);
