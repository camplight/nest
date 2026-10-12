import { AgentSetupForm, Connections } from "./Onboarding";
import type { OnboardingState } from "@nest/schemas";
import type { AgentModelCatalog } from "@nest/schemas";
import { useEffect, useState, type FormEvent } from "react";
import { apiJson, getApiHeaders } from "./api";
import { AgentAvatar } from "./components/AgentAvatar";
import { DesignIcon } from "./Dashboard";
import type { Agent } from "./types";
import "./agents.css";

type AgentSettings = Agent & { mode?: string; modelId?: string; workspacePath?: string; assignedRunnerId?: string; systemInstructions?: string; enabledSkills?: string[] };
type Props = { setup: OnboardingState | null; creating:boolean; onCreate:()=>void; onCreated:(name:string)=>void; onChat:(id:string)=>void; agents: Agent[]; name: string | null; userId: string | null; loading: boolean; error: string | null; onSelect: (name: string | null) => void; onMenu: () => void; onRetry: () => void; onSaved: (agent: Agent) => void };

function errorMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : "Unable to complete request";
  try { const parsed = JSON.parse(message); return typeof parsed.error === "string" ? parsed.error : message; }
  catch { return message; }
}

export function Agents({ setup, creating, onCreate, onCreated, onChat, agents, name, userId, loading, error, onSelect, onMenu, onRetry, onSaved }: Props) {
  const [query, setQuery] = useState("");
  return <section className="dashboard agents-page" aria-label="Agents">
    <header className="dashboard-topbar"><button className="sidebar-mobile-toggle" onClick={onMenu}>Menu</button>
      {name || creating ? <button className="dashboard-action" onClick={() => onSelect(null)}>← All agents</button> : <label className="dashboard-search"><DesignIcon name="search" /><input aria-label="Search agents" placeholder="Search agents…" value={query} onChange={e => setQuery(e.target.value)} /></label>}
    </header>
    <div className="dashboard-content">
      {creating ? <><div className="dashboard-title"><h1>Agents</h1></div><AgentSetupForm onCreated={onCreated}/></> : name ? <AgentDetails key={name} name={name} userId={userId} onSaved={onSaved} setup={setup} onChat={onChat} onRetry={onRetry} onResume={onCreate}/> : <>
        <div className="dashboard-title"><h1>Agents</h1>{!setup?.setup && <button className="dashboard-action" onClick={onCreate}>Add your agent</button>}{setup?.setup && !setup.setup.channelId && <button className="dashboard-action" onClick={onCreate}>Resume agent setup</button>}</div>
        {error && <div role="alert">{error} <button onClick={onRetry}>Try again</button></div>}
        {loading && <p role="status">Loading agents…</p>}
        <div className="dashboard-stats agents-stats">{[["Total agents", agents.length], ["Running", agents.filter(a => a.runtimeState === "RUNNING").length], ["Stopped", agents.filter(a => a.runtimeState === "STOPPED").length]].map(([label, count]) => <article className="dashboard-card dashboard-stat" key={label}><h2>{label}</h2><span className="dashboard-stat-value">{loading || error ? "—" : count}</span></article>)}</div>
        <section aria-label="Your team"><div className="dashboard-section-title"><h2>Your team</h2></div><div className="dashboard-list">
          {agents.filter(a => `${a.name} ${a.description ?? ""}`.toLowerCase().includes(query.toLowerCase())).map(agent => <article className="dashboard-card agent-directory-row" key={agent.name}>
            <AgentAvatar name={agent.name} /><div className="agent-directory-identity"><button className="agent-name-link" onClick={() => onSelect(agent.name)}>{agent.name}</button><p>{agent.description || "No description yet."}</p>{userId && agent.ownerHumanId === userId && <small className="agent-owner-label">{setup?.setup?.name === agent.name ? "Your personal agent" : "Owned by you"}</small>}</div>
            <span className="dashboard-pill">{agent.runtimeState?.toLowerCase().replaceAll("_", " ") || "Status unavailable"}</span><button className="dashboard-action" onClick={() => onSelect(agent.name)} aria-label={`Manage ${agent.name}`}>Manage →</button>
          </article>)}
          {!loading && !error && !agents.some(a => `${a.name} ${a.description ?? ""}`.toLowerCase().includes(query.toLowerCase())) && <div className="dashboard-card dashboard-empty"><h3>{agents.length ? "No matching agents" : "Your team starts here"}</h3><p>{agents.length ? "Try a different name or description." : "Agents available to you will appear here."}</p></div>}
        </div></section>
      </>}
    </div>
  </section>;
}

function AgentDetails({ name, userId, onSaved, setup, onChat, onRetry, onResume }: { name: string; userId: string | null; onSaved: (agent: Agent) => void; setup:OnboardingState|null; onChat:(id:string)=>void; onRetry:()=>void; onResume:()=>void }) {
  const [agent, setAgent] = useState<AgentSettings | null>(null);
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelAttempt, setModelAttempt] = useState(0);
  const [model, setModel] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setModelError(null); setCatalog(null);
    void apiJson<AgentModelCatalog>('/api/agent-models', {signal:controller.signal}).then(setCatalog)
      .catch(reason => {if (!controller.signal.aborted) setModelError(errorMessage(reason));});
    return () => controller.abort();
  }, [modelAttempt]);
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void apiJson<AgentSettings>(`/api/agents/${encodeURIComponent(name)}`, { signal: controller.signal }).then(value => {
      setAgent(value); setModel(value.modelId ?? ""); setDescription(value.description ?? ""); setInstructions(value.systemInstructions ?? "");
    }).catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [name, attempt]);
  const editable = Boolean(agent && (agent.visibility !== "PRIVATE" || Boolean(userId && agent.ownerHumanId === userId)));
  const wrapped = agent?.mode === "WRAPPED";
  const dirty = Boolean(agent && (description !== (agent.description ?? "") || (!wrapped && (instructions !== (agent.systemInstructions ?? "") || model !== (agent.modelId ?? "")))));
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!agent || !editable || busy) return;
    setBusy(true); setSaved(false); setError(null);
    try {
      const changes = { description, ...(!wrapped ? { systemInstructions: instructions, ...(model !== (agent.modelId ?? "") ? {modelId:model} : {}) } : {}) };
      await apiJson(`/api/agents/${encodeURIComponent(name)}`, { method: "PATCH", headers: getApiHeaders(), body: JSON.stringify(changes) });
      const next = { ...agent, ...changes }; setAgent(next); onSaved(next); setSaved(true);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  async function openConversation() {
    if(!setup?.setup?.channelId || busy)return;
    setBusy(true);setError(null);
    try {
      if(!setup.setup.completedAt) await apiJson('/api/onboarding/complete',{method:'POST',headers:getApiHeaders(),body:'{}'});
      onChat(setup.setup.channelId);
    }catch(reason){setError(errorMessage(reason));}finally{setBusy(false);}
  }
  return <>
    <div className="dashboard-title"><h1>Agent details</h1>{setup?.setup?.name === name && setup.setup.channelId && <button className="dashboard-action" disabled={busy || !!setup.problem} onClick={()=>void openConversation()}>Open private chat</button>}</div>
    {setup?.setup?.name === name && !setup.setup.channelId && <p role="status">Your agent was created, but its private chat still needs setup. <button className="dashboard-action" onClick={onResume}>Resume agent setup</button></p>}
    {error && <div className="notice error" role="alert">{error}{!agent && <button onClick={() => setAttempt(a => a + 1)}>Try again</button>}</div>}
    {!agent && !error && <p role="status">Loading agent settings…</p>}
    {agent && <form className="agent-settings" onSubmit={save}>
      <aside><h2>Avatar</h2><AgentAvatar name={name} size={144} /><p>Your agent’s character in the team.</p></aside>
      <div className="agent-settings-fields">
        <div className="agent-field"><label htmlFor="agent-name">Name</label><input id="agent-name" value={name} readOnly aria-describedby="agent-name-help" /><small id="agent-name-help">Agent names are permanent identifiers.</small></div>
        <div className="agent-field"><label htmlFor="agent-description">Description</label><textarea id="agent-description" rows={3} value={description} disabled={!editable || busy} onChange={e => { setDescription(e.target.value); setSaved(false); }} /></div>
        {!wrapped && <div className="agent-field">
          <label htmlFor="agent-model">Language model</label>
          <select id="agent-model" value={model} disabled={!editable || busy || !catalog} onChange={e => {setModel(e.target.value); setSaved(false);}} aria-describedby="agent-model-help">
            {!catalog?.models.some(m => m.reference === model) && <option value={model}>{model ? `${model} (current)` : 'Not configured'}</option>}
            {catalog?.models.map(m => <option key={m.id} value={m.reference}>{m.name} · {m.provider}{m.reference === catalog.defaultModel ? ' · Default for new agents' : ''}</option>)}
          </select>
          <small id="agent-model-help">Changes apply on the next agent turn. Models are enabled by your administrator.</small>
          {!catalog && !modelError && <small role="status">Loading models…</small>}
          {modelError && <small role="alert">Could not load models. <button type="button" onClick={() => setModelAttempt(n => n + 1)}>Retry models</button></small>}
          {catalog && catalog.models.length === 0 && <small>No enabled models. Your current setting is preserved.</small>}
        </div>}
        <section><h2>Agent resources</h2><dl className="agent-resources">
          <dt>Runtime</dt><dd>{agent.mode ?? "CLASSIC"} · {agent.runtimeState ?? "Unknown"}</dd>
          <dt>Model</dt><dd>{wrapped ? "Managed by external runtime" : agent.modelId || "Not configured"}</dd>
          <dt>Workspace</dt><dd>{agent.workspacePath || "Not configured"}</dd>
          <dt>Runner</dt><dd>{agent.assignedRunnerId || "Unassigned"}</dd>
          <dt>Skills</dt><dd>{wrapped ? "Managed by external runtime" : agent.enabledSkills?.join(", ") || "None enabled"}</dd>
        </dl></section>
        {wrapped ? <p className="dashboard-card agent-runtime-note">This wrapped agent manages its instructions, model and skills in its external runtime. Nest’s description is editable here; execution configuration remains in administration.</p> : <div className="agent-field"><label htmlFor="agent-instructions">Additional instructions</label><textarea id="agent-instructions" rows={10} value={instructions} disabled={!editable || busy} onChange={e => { setInstructions(e.target.value); setSaved(false); }} /></div>}
        {!editable && <p>These settings are read-only. Only this private agent’s owner can edit them.</p>}
        <div className="agent-save-row">{saved && <span role="status">Settings saved.</span>}{dirty && <span>Unsaved changes</span>}<button className="dashboard-action" type="submit" disabled={!editable || !dirty || busy}>{busy ? "Saving…" : "Save settings"}</button></div>
      </div>
    </form>}
    {agent && !wrapped && agent.visibility === "PRIVATE" && userId && agent.ownerHumanId === userId && <section className="onboarding agent-connections" aria-label="Connected apps">
      <h2>Connected apps</h2>
      <p>Connect your accounts and choose exactly which tools {name} can use in your private conversation. Google sign-in does not connect Drive or Gmail.</p>
      {setup?.problem && setup.setup?.name === name && <p role="alert">{setup.problem}</p>}
      {!setup ? <p role="status">Connection settings could not be loaded. <button className="dashboard-action" onClick={onRetry}>Retry connections</button></p> : setup.connectionsAvailable ? <Connections agentName={name}/> : <div className="dashboard-card onboarding-notice"><h3>App connections are being prepared</h3><p>Connections will appear here after your administrator finishes integration setup.</p></div>}
    </section>}
  </>;
}
