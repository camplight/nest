import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { BrandingSchema, DEFAULT_BRANDING, type Branding } from "../../packages/schemas/src/branding";

const Context = createContext({ branding: DEFAULT_BRANDING, setBranding: (_: Branding) => {} });
export const useBranding = () => useContext(Context);
export function BrandingProvider({ children, endpoint, title }: { children: ReactNode; endpoint: string; title: string }) {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(endpoint, { credentials: "include" });
        if (!response.ok) return;
        const parsed = BrandingSchema.safeParse(await response.json());
        if (active && parsed.success) setBranding(current => JSON.stringify(current) === JSON.stringify(parsed.data) ? current : parsed.data);
      } catch { /* Keep the last working brand during an outage. */ }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [endpoint]);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--instance-primary", branding.primaryColor);
    root.style.setProperty("--instance-accent", branding.accentColor);
    root.style.setProperty("--instance-background", branding.backgroundColor);
    // Pick a readable foreground even when an owner chooses a light sidebar.
    const rgb = branding.primaryColor.slice(1).match(/../g)!.map(v => parseInt(v, 16));
    root.style.setProperty("--instance-on-primary", (rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114) > 150 ? "#201829" : "#ffffff");
    document.title = `${branding.displayName} | ${title}`;
  }, [branding, title]);
  return <Context.Provider value={{ branding, setBranding }}>{children}</Context.Provider>;
}
