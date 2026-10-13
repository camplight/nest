import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { apiJson, getApiHeaders } from "../api";

type Action = { slug: string; name: string; description: string };
type ActionPage = { items: Action[]; nextCursor: string | null };
const appNames: Record<string, string> = {
  gmail: "Gmail", trello: "Trello", slack: "Slack", miro: "Miro",
  googledrive: "Google Drive", googlecalendar: "Google Calendar",
  googlesheets: "Google Sheets", googledocs: "Google Docs",
  fathom: "Fathom", wordpress: "WordPress", github: "GitHub",
};
export function connectionAppName(slug: string) {
  return appNames[slug] ?? slug.replaceAll("_", " ").replace(/^./, char => char.toUpperCase());
}
function actionName(action: Action, toolkit: string) {
  const name = action.name?.trim() || action.slug;
  // Provider identifiers are presentation only. Grants always use the exact slug.
  const prefix = toolkit.replace(/[^a-z0-9]/gi, "");
  const words = name.replaceAll("_", " ").trim();
  const first = words.split(" ")[0];
  const title = first.replace(/[^a-z0-9]/gi, "").toLowerCase() === prefix.toLowerCase()
    ? words.slice(first.length).trim() : words;
  const friendly = title || words;
  return friendly === friendly.toUpperCase()
    ? friendly.toLowerCase().replace(/^./, char => char.toUpperCase()) : friendly;
}
function descriptionPreview(description: string) {
  // Keep the original wording and a full description underneath; never infer
  // read/write safety or summarize the meaning of a permission heuristically.
  const paragraph = description.trim().split(/\n\s*\n/)[0] ?? "";
  return paragraph.length > 180 ? paragraph.slice(0, 180).trimEnd() + "…" : paragraph;
}
function errorMessage(reason: unknown) {
  if (reason instanceof Error) {
    try { const value = JSON.parse(reason.message); if (typeof value.error === "string") return value.error; } catch { /* Use a friendly network fallback. */ }
  }
  return "We couldn’t load or save these choices. Please try again.";
}
const sameChoices = (left: string[], right: string[]) =>
  left.length === right.length && left.every(slug => right.includes(slug));

export function ConnectionActions({ agentName, connection, onSaved }: {
  agentName: string;
  connection: { id: string; toolkit: string };
  onSaved?: () => void;
}) {
  const [tools, setTools] = useState<Action[]>([]);
  const [known, setKnown] = useState<Record<string, Action>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [savedChoices, setSavedChoices] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [filter, setFilter] = useState<"all" | "selected">("all");
  const [expanded, setExpanded] = useState(false);
  const path = `/api/integrations/agents/${encodeURIComponent(agentName)}/grants`;
  const catalogPath = `/api/integrations/connections/${encodeURIComponent(connection.id)}/tools`;
  const dirty = !sameChoices(selected, savedChoices);
  function remember(items: Action[]) {
    setKnown(previous => ({ ...previous, ...Object.fromEntries(items.map(item => [item.slug, item])) }));
  }
  useEffect(() => {
    const abort = new AbortController();
    setError(""); setReady(false);
    void apiJson<{ connectionId: string; tools: string[] }[]>(path, { signal: abort.signal })
      .then(all => {
        if (abort.signal.aborted) return;
        const choices = all.find(grant => grant.connectionId === connection.id)?.tools ?? [];
        setSelected(choices); setSavedChoices(choices); setReady(true);
      })
      .catch(reason => { if (!abort.signal.aborted) setError(errorMessage(reason)); });
    return () => abort.abort();
  }, [path, connection.id, attempt]);
  useEffect(() => {
    if (!expanded || filter !== "all") return;
    const abort = new AbortController();
    setLoading(true); setCatalogError(""); setCursor(null);
    const timeout = setTimeout(() => {
      void apiJson<ActionPage>(`${catalogPath}?search=${encodeURIComponent(query)}`, { signal: abort.signal })
        .then(page => {
          if (abort.signal.aborted) return;
          setTools(page.items); remember(page.items); setCursor(page.nextCursor);
        })
        .catch(reason => { if (!abort.signal.aborted) setCatalogError(errorMessage(reason)); })
        .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timeout); abort.abort(); };
  }, [catalogPath, query, catalogAttempt, expanded, filter]);
  function choose(slug: string, checked: boolean) {
    setSaved(false);
    setSelected(current => checked ? [...new Set([...current, slug])] : current.filter(value => value !== slug));
  }
  async function save() {
    setBusy(true); setError(""); setSaved(false);
    try {
      await apiJson(path + "/" + encodeURIComponent(connection.id), {
        method: "PUT", headers: getApiHeaders(), body: JSON.stringify({ tools: selected }),
      });
      setSavedChoices(selected); setSaved(true); onSaved?.();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  async function more() {
    if (!cursor || moreBusy) return;
    setMoreBusy(true); setCatalogError("");
    try {
      const page = await apiJson<ActionPage>(`${catalogPath}?search=${encodeURIComponent(query)}&cursor=${encodeURIComponent(cursor)}`);
      setTools(current => [...current, ...page.items.filter(item => !current.some(old => old.slug === item.slug))]);
      remember(page.items); setCursor(page.nextCursor);
    } catch (reason) { setCatalogError(errorMessage(reason)); }
    finally { setMoreBusy(false); }
  }
  const choices = filter === "selected"
    ? selected.map(slug => known[slug] ?? {slug, name: slug, description: "A saved or selected action. Search for its name to load the full description."})
        .filter(action => `${actionName(action, connection.toolkit)} ${action.description} ${action.slug}`.toLowerCase().includes(query.trim().toLowerCase()))
    : tools;
  return <details className="connection-permissions" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>
      <span className="connection-permission-heading"><strong>Choose actions for {agentName}</strong>
        <small>{!ready ? "Checking saved access…" : dirty ? "Changes not saved" : savedChoices.length ? `${savedChoices.length} ${savedChoices.length === 1 ? "action is" : "actions are"} allowed` : "No actions allowed yet"}</small></span>
      <span className="connection-picker-label">{expanded ? "Hide choices" : "Choose access"}<span aria-hidden="true">{expanded ? "−" : "+"}</span></span>
    </summary>
    <div className="connection-picker">
      <div className="connection-picker-intro"><h4>What can {agentName} do in {connectionAppName(connection.toolkit)}?</h4>
        <p>Pick the actions you want your agent to use. Your choices only take effect when you save them.</p></div>
      {error && <p className="connection-picker-error" role="alert">{error}{!ready && <button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>}</p>}
      <div className="connection-picker-toolbar">
        <label className="connection-action-search">Find an action<input value={query} disabled={moreBusy} onChange={event => setQuery(event.target.value)} placeholder="Try emails, boards or messages…" /></label>
        <div className="connection-action-filters" role="group" aria-label="Actions shown">
          <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>Available actions</button>
          <button type="button" aria-pressed={filter === "selected"} onClick={() => setFilter("selected")}>Selected <span>{selected.length}</span></button>
        </div>
      </div>
      {catalogError && <p className="connection-picker-error" role="alert">{catalogError}<button type="button" onClick={() => setCatalogAttempt(value => value + 1)}>Reload actions</button></p>}
      {filter === "all" && loading ? <div className="connection-actions-loading" role="status">Finding available actions…</div> :
        <div className="connection-action-grid" role="group" tabIndex={0} aria-label="Available app actions">
          {choices.map(action => {
            const checked = selected.includes(action.slug);
            const title = actionName(action, connection.toolkit);
            return <article key={action.slug} className={`connection-action-card${checked ? " is-selected" : ""}`}>
              <label className="connection-action-choice">
                <input type="checkbox" aria-label={title} aria-describedby={`action-${connection.id}-${action.slug}`} checked={checked} disabled={!ready || busy || moreBusy || (!checked && selected.length >= 100)} onChange={event => choose(action.slug, event.target.checked)} />
                <span><strong>{title}</strong><span className="connection-action-description" id={`action-${connection.id}-${action.slug}`}>{action.description ? <ReactMarkdown components={{ img: () => null }}>{descriptionPreview(action.description)}</ReactMarkdown> : "Open the details to review this action before choosing it."}</span></span>
              </label>
              <details className="connection-action-details"><summary>About this action</summary>
                <div><ReactMarkdown components={{ img: () => null }}>{action.description || "No description was provided for this action."}</ReactMarkdown><small>Action reference: <code>{action.slug}</code></small></div>
              </details>
            </article>;
          })}
          {!choices.length && !(filter === "all" && catalogError) && <div className="connection-actions-empty"><strong>{filter === "selected" && !selected.length ? "No actions selected" : "No matching actions"}</strong><p>{query ? "Try another word or clear your search." : filter === "selected" ? "Choose an action from Available actions to add it here." : "Try searching for the task you want your agent to do."}</p></div>}
        </div>}
      {filter === "all" && cursor && !loading && <button type="button" className="connection-more-actions" disabled={moreBusy || busy} onClick={() => void more()}>{moreBusy ? "Loading more…" : "Show more actions"}</button>}
      {selected.length >= 100 && <p role="status">You can choose up to 100 actions per account. Remove a choice to add another.</p>}
      <div className="connection-picker-footer">
        <div className="connection-choice-status" role="status"><strong>{selected.length} {selected.length === 1 ? "action" : "actions"} selected</strong><span>{saved && !dirty ? "Access saved" : dirty ? "Changes not saved yet" : "Only saved actions are available to your agent."}</span></div>
        <div className="connection-picker-buttons">
          {selected.length > 0 && <button type="button" className="connection-discard" disabled={busy || !ready} onClick={() => {setSelected([]); setSaved(false);}}>Clear all choices</button>}
          {dirty && <button type="button" className="connection-discard" disabled={busy || !ready} onClick={() => {setSelected(savedChoices); setSaved(false);}}>Discard changes</button>}
          <button type="button" className="connection-save" disabled={!ready || busy || !dirty || selected.length > 100} onClick={() => void save()}>{busy ? "Saving…" : "Save access"}</button>
        </div>
      </div>
    </div>
  </details>;
}
