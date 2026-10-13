import { useEffect, useState } from "react";
import "./brand.css";
import { useBranding } from "./BrandingProvider";

export function InstanceBrand({ subtitle }: { subtitle?: string }) {
  const { branding } = useBranding();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [branding.logoUrl]);
  const logoUrl = branding.logoUrl.startsWith("/brand/")
    ? `${import.meta.env.BASE_URL}${branding.logoUrl.slice(1)}` : branding.logoUrl;
  return <div className="nest-brand instance-brand">
    {logoUrl && !failed ? <img className="instance-logo" src={logoUrl} alt={branding.displayName} onError={() => setFailed(true)} /> : <>
      {branding.displayName === "Nest" && <img src={`${import.meta.env.BASE_URL}brand/nest-mark.svg`} alt="" width="32" height="32" />}
      <span className="instance-wordmark">{branding.displayName === "Nest" ? "nest" : branding.displayName}</span>
    </>}
    {subtitle && <small>{subtitle}</small>}
  </div>;
}

export function PoweredByNest() {
  return <div className="powered-by-nest"><span>Powered by</span><img src={`${import.meta.env.BASE_URL}brand/nest-mark.svg`} width="23" height="23" alt="" /><span className="nest-wordmark">nest</span></div>;
}

export function ThemeToggle({iconSrc, className = ""}: {iconSrc?: string; className?: string} = {}) {
  const [dark, setDark] = useState(() => {
    try { const saved = localStorage.getItem("nest-theme"); return saved ? saved === "dark" : typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"; } catch { return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"; }
  });
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  useEffect(() => {
    const sync = () => setDark(document.documentElement.dataset.theme === "dark");
    const storage = (event: StorageEvent) => {
      if (event.key !== "nest-theme") return;
      document.documentElement.dataset.theme = event.newValue === "dark" ? "dark" : "light";
      sync();
    };
    window.addEventListener("nest-theme-change", sync);
    window.addEventListener("storage", storage);
    return () => { window.removeEventListener("nest-theme-change", sync); window.removeEventListener("storage", storage); };
  }, []);
  return <button className={`nest-theme-toggle ${className}`} type="button" title={`Switch to ${dark ? "light" : "dark"} theme`} aria-label={`Switch to ${dark ? "light" : "dark"} theme`} onClick={() => {
    const next = !dark;
    setDark(next);
    try { localStorage.setItem("nest-theme", next ? "dark" : "light"); } catch { /* Theme still works without storage. */ }
    document.documentElement.dataset.theme = next ? "dark" : "light";
    window.dispatchEvent(new Event("nest-theme-change"));
  }}>{iconSrc ? <img src={iconSrc} alt="" aria-hidden="true" /> : <><span aria-hidden="true">{dark ? "◐" : "◑"}</span><span>{dark ? "Light" : "Dark"}</span></>}</button>;
}
