import { useEffect, useState, type FormEvent, type CSSProperties } from "react";
import { apiFetch, apiJson } from "../api";
import { useBranding } from "../../../nest-brand/BrandingProvider";
import { PoweredByNest } from "../../../nest-brand/Brand";
import { BrandingSchema, DEFAULT_BRANDING, type Branding } from "../../../../packages/schemas/src/branding";

export function BrandingScreen() {
  const { branding, setBranding } = useBranding();
  const [draft, setDraft] = useState<Branding>(branding);
  const [access, setAccess] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => { setDraft(branding); }, [branding]);
  useEffect(() => { setLogoFailed(false); }, [draft.logoUrl]);
  useEffect(() => {
    void apiJson<{ canManage: boolean }>("/api/branding/access").then(r => setAccess(r.canManage))
      .catch(() => setError("Could not load branding permissions. Refresh to try again."));
  }, []);
  function update(key: keyof Branding, value: string) {
    setDraft(d => ({ ...d, [key]: value })); setNotice(""); setError("");
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setError(""); setNotice("");
    const parsed = BrandingSchema.safeParse(draft);
    if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
    setSaving(true);
    try {
      const response = await apiFetch("/api/branding", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.data) });
      const saved = await response.json(); setBranding(saved); setDraft(saved);
      setNotice("Branding saved. Both apps and sign-in pages now use these settings.");
    } catch { setError("Could not save branding. Check your connection and owner permissions, then try again."); }
    finally { setSaving(false); }
  }
  async function upload(file?: File) {
    if (!file) return;
    if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 250 * 1024) {
      setError("Choose a PNG, JPEG or WebP image up to 250 KB."); return;
    }
    const reader = new FileReader();
    reader.onload = () => update("logoUrl", String(reader.result));
    reader.onerror = () => setError("Could not read that image. Please try another file.");
    reader.readAsDataURL(file);
  }
  const previewLogo = draft.logoUrl.startsWith('/brand/') ? `${import.meta.env.BASE_URL}${draft.logoUrl.slice(1)}` : draft.logoUrl;
  const dirty = JSON.stringify(draft) !== JSON.stringify(branding);
  return <section className="branding-settings">
    <div className="branding-intro"><p className="branding-kicker">Make this space yours</p><h2>Your brand. Your workspace.</h2><p>Set the identity people see across this instance. Nest stays in the footer, quietly powering your team.</p></div>
    {error && <p role="alert" className="branding-error">{error}</p>}
    {access === null && !error && <p role="status">Loading branding settings…</p>}
    {access === false && <p className="branding-notice">Only the instance owner can change branding. You can view the current settings below.</p>}
    <div className="branding-columns">
      <form onSubmit={save} className="branding-form">
        <fieldset disabled={access !== true || saving}>
          <legend>Workspace identity</legend>
          <label>Organization name<input value={draft.displayName} onChange={e => update("displayName", e.target.value)} maxLength={60} required /></label>
          <label>Logo URL<input value={draft.logoUrl.startsWith('data:') ? '' : draft.logoUrl} placeholder={draft.logoUrl.startsWith('data:') ? 'Uploaded image selected' : 'https://example.com/logo.svg'} onChange={e => update("logoUrl", e.target.value)} /></label>
          <p className="branding-hint">Use a horizontal logo that reads well on your sidebar color. Leave blank to show your organization name.</p>
          <label className="branding-upload">Or upload a logo<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => void upload(e.target.files?.[0])} /></label>
          {draft.logoUrl && <button type="button" className="branding-text-button" onClick={() => update("logoUrl", "")}>Remove logo</button>}
          <h3 className="branding-colors-title">Workspace colors</h3>
          {([['primaryColor','Sidebar & buttons'],['accentColor','Accent'],['backgroundColor','Workspace background']] as const).map(([key, label]) => <label key={key} className="branding-color"><span>{label}</span><div><input aria-label={`${label} color picker`} type="color" value={/^#[0-9a-f]{6}$/i.test(draft[key]) ? draft[key] : '#000000'} onChange={e => update(key,e.target.value)} /><input aria-label={`${label} hex value`} value={draft[key]} onChange={e => update(key,e.target.value)} pattern="#[0-9a-fA-F]{6}" maxLength={7} required /></div></label>)}
          <div className="branding-actions"><button type="submit" disabled={!dirty || saving} className="branding-save">{saving ? 'Saving…' : 'Save branding'}</button><button type="button" onClick={() => { setDraft(DEFAULT_BRANDING); setNotice(''); }}>Restore Nest defaults</button></div>
        </fieldset>
        {notice && <p role="status" className="branding-notice">{notice}</p>}
      </form>
      <div className="branding-preview-wrap"><div className="branding-preview-heading"><h3>Live preview</h3><span>Changes apply after saving</span></div>
        <div className="branding-preview" style={{ '--preview-primary': draft.primaryColor, '--preview-bg': draft.backgroundColor, '--preview-accent': draft.accentColor } as CSSProperties}>
          <aside><div className="branding-preview-logo">{previewLogo && !logoFailed ? <img src={previewLogo} alt={draft.displayName} onError={() => setLogoFailed(true)} /> : <strong>{draft.displayName || 'Your organization'}</strong>}</div><span className="preview-selected">Dashboard</span><span>Agents</span><span>Channels</span><span>Skills</span><PoweredByNest /></aside>
          <div className="branding-preview-main"><span>YOUR WORKSPACE</span><h3>Room for great work.</h3><p>Your people and agents, together.</p><div className="preview-sample-card"><span className="preview-status-dot" />Ready when you are</div><div className="preview-lines"><i /><i /><i /></div></div>
        </div>
        {logoFailed && <p className="branding-error">The logo could not load. Your organization name will be shown instead.</p>}
        <p className="branding-hint">The sidebar, sign-in screens, page titles and workspace colors follow these settings. Light and dark themes remain available.</p>
      </div>
    </div>
  </section>;
}
