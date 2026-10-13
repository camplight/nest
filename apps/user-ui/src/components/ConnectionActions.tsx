import { useEffect, useRef, useState } from "react";
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
  const [bulkMode, setBulkMode] = useState<"select" | "grant" | null>(null);
  const allBusy = bulkMode !== null;
  const [allChoices, setAllChoices] = useState<string[] | null>(null);
  const [bulkError, setBulkError] = useState("");
  const bulkAbort = useRef<AbortController | null>(null);
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
  const allGiven = !!allChoices?.length && sameChoices(allChoices, savedChoices);
  function remember(items: Action[]) {
    setKnown(previous => ({ ...previous, ...Object.fromEntries(items.map(item => [item.slug, item])) }));
  }
  useEffect(() => {
    setBulkMode(null); setAllChoices(null); setBulkError("");
    return () => { bulkAbort.current?.abort(); };
  }, [catalogPath, path]);
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
    setBulkError("");
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
  async function persist(choices: string[], signal?: AbortSignal) {
    await apiJson(path + "/" + encodeURIComponent(connection.id), {
      method: "PUT", headers: getApiHeaders(), body: JSON.stringify({ tools: choices }), signal,
    });
    if (signal?.aborted) return;
    setSelected(choices); setSavedChoices(choices); setSaved(true); onSaved?.();
  }
  async function save() {
    setBusy(true); setError(""); setSaved(false);
    try {
      await persist(selected);
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
  async function selectAll(grant = false) {
    const abort = new AbortController();
    bulkAbort.current = abort;
    setBulkMode(grant ? "grant" : "select"); setBulkError(""); setError("");
    const actions = new Map<string, Action>();
    const search = grant ? "" : query;
    const combined = new Set(grant ? [] : selected);
    const visited = new Set<string>();
    let next: string | null = null;
    let saving = false;
    try {
      do {
        const page: ActionPage = await apiJson<ActionPage>(`${catalogPath}?search=${encodeURIComponent(search)}${next ? `&cursor=${encodeURIComponent(next)}` : ""}`, { signal: abort.signal });
        if (abort.signal.aborted) return;
        for (const action of page.items) { actions.set(action.slug, action); combined.add(action.slug); }
        if (combined.size > 100) {
          setBulkError("These actions exceed the 100-action limit. Choose specific actions to select a smaller set. Your choices were kept.");
          return;
        }
        next = page.nextCursor;
        if (next && visited.has(next)) throw new Error("Repeated action page");
        if (next) visited.add(next);
      } while (next);
      const items = [...actions.values()];
      if (grant && !items.length) { setBulkError("No actions are available for this account yet."); return; }
      if (grant) {
        saving = true;
        await persist([...combined], abort.signal);
        if (abort.signal.aborted) return;
        setExpanded(false); setQuery(""); setFilter("all");
      } else { setSelected([...combined]); setSaved(false); }
      remember(items);
      if (search === query) { setTools(items); setCursor(null); }
      if (!search) setAllChoices(items.map(action => action.slug));
    } catch (reason) {
      if (!abort.signal.aborted) setBulkError(saving ? errorMessage(reason) : "We couldn’t load all actions. Please try again. Your choices were kept.");
    } finally {
      if (!abort.signal.aborted) setBulkMode(null);
    }
  }
  const choices = filter === "selected"
    ? selected.map(slug => known[slug] ?? {slug, name: slug, description: "A saved or selected action. Search for its name to load the full description."})
        .filter(action => `${actionName(action, connection.toolkit)} ${action.description} ${action.slug}`.toLowerCase().includes(query.trim().toLowerCase()))
    : tools;
  return <div className="connection-permissions">
    <div className="connection-quick-access">
      <div><strong>Agent access</strong><span className="connection-access-status" role="status">{!ready ? "Checking access…" : savedChoices.length ? `${savedChoices.length} ${savedChoices.length === 1 ? "action" : "actions"} allowed` : "Not allowed yet"}</span>
        <p id={`give-all-scope-${connection.id}`}>Allow {agentName} to use every available {connectionAppName(connection.toolkit)} action.</p></div>
      <button type="button" className="connection-save" aria-describedby={`give-all-scope-${connection.id}`} disabled={!ready || busy || moreBusy || allBusy || allGiven} onClick={() => void selectAll(true)}>{bulkMode === "grant" ? "Giving access…" : allGiven ? "All access given" : "Give all access"}</button>
    </div>
    {error && <p className="connection-picker-error connection-access-error" role="alert">{error}{!ready && <button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>}</p>}
    {bulkError && <p className="connection-picker-error connection-access-error" role="alert">{bulkError}</p>}
    <details className="connection-advanced" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary><span>Choose specific actions</span><small>{dirty ? "Unsaved changes" : "Advanced"}</small><span aria-hidden="true">{expanded ? "−" : "+"}</span></summary>
    {expanded && <div className="connection-picker">
      <p className="connection-advanced-hint">Select the actions you want, then save access.</p>
      <div className="connection-picker-toolbar">
        <label className="connection-action-search">Find an action<input value={query} disabled={moreBusy || allBusy} onChange={event => setQuery(event.target.value)} placeholder="Try emails, boards or messages…" /></label>
        <div className="connection-action-filters" role="group" aria-label="Actions shown">
          <button type="button" disabled={allBusy || moreBusy} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>Available actions</button>
          <button type="button" disabled={allBusy || moreBusy} aria-pressed={filter === "selected"} onClick={() => setFilter("selected")}>Selected <span>{selected.length}</span></button>
        </div>
      </div>
      {filter === "all" && <div className="connection-bulk-actions">
        <button type="button" className="connection-discard" aria-describedby={`bulk-scope-${connection.id}`} disabled={!ready || busy || moreBusy || allBusy || loading || !!catalogError || !tools.length || (!cursor && tools.every(action => selected.includes(action.slug)))} onClick={() => void selectAll()}>{allBusy ? "Selecting…" : query.trim() ? "Select all results" : "Select all"}</button>
        <span id={`bulk-scope-${connection.id}`}>{query.trim() ? "All search results, across pages." : "All available actions, across pages."}</span>
      </div>}
      {allBusy && <p role="status">Finding all actions…</p>}
      {catalogError && <p className="connection-picker-error" role="alert">{catalogError}<button type="button" onClick={() => setCatalogAttempt(value => value + 1)}>Reload actions</button></p>}
      {filter === "all" && loading ? <div className="connection-actions-loading" role="status">Finding available actions…</div> :
        <div className="connection-action-grid" role="group" tabIndex={0} aria-label="Available app actions">
          {choices.map(action => {
            const checked = selected.includes(action.slug);
            const title = actionName(action, connection.toolkit);
            return <article key={action.slug} className={`connection-action-card${checked ? " is-selected" : ""}`}>
              <label className="connection-action-choice">
                <input type="checkbox" aria-label={title} aria-describedby={`action-${connection.id}-${action.slug}`} checked={checked} disabled={!ready || busy || moreBusy || allBusy || (!checked && selected.length >= 100)} onChange={event => choose(action.slug, event.target.checked)} />
                <strong>{title}</strong>
              </label>
              <details className="connection-action-details"><summary>About this action</summary>
                <div id={`action-${connection.id}-${action.slug}`}><ReactMarkdown components={{ img: () => null }}>{action.description || "No description was provided for this action."}</ReactMarkdown><small>Action reference: <code>{action.slug}</code></small></div>
              </details>
            </article>;
          })}
          {!choices.length && !(filter === "all" && catalogError) && <div className="connection-actions-empty"><strong>{filter === "selected" && !selected.length ? "No actions selected" : "No matching actions"}</strong><p>{query ? "Try another word or clear your search." : filter === "selected" ? "Choose an action from Available actions to add it here." : "Try searching for the task you want your agent to do."}</p></div>}
        </div>}
      {filter === "all" && cursor && !loading && <button type="button" className="connection-more-actions" disabled={moreBusy || busy || allBusy} onClick={() => void more()}>{moreBusy ? "Loading more…" : "Show more actions"}</button>}
      {selected.length >= 100 && <p role="status">You can choose up to 100 actions per account. Remove a choice to add another.</p>}
      <div className="connection-picker-footer">
        <div className="connection-choice-status" role="status"><strong>{selected.length} {selected.length === 1 ? "action" : "actions"} selected</strong><span>{saved && !dirty ? "Access saved" : dirty ? "Changes not saved yet" : "Only saved actions are available to your agent."}</span></div>
        <div className="connection-picker-buttons">
          {selected.length > 0 && <button type="button" className="connection-discard" disabled={busy || moreBusy || allBusy || !ready} onClick={() => {setSelected([]); setSaved(false);}}>Clear all choices</button>}
          {dirty && <button type="button" className="connection-discard" disabled={busy || moreBusy || allBusy || !ready} onClick={() => {setSelected(savedChoices); setSaved(false);}}>Discard changes</button>}
          <button type="button" className="connection-save" disabled={!ready || busy || allBusy || !dirty || selected.length > 100} onClick={() => void save()}>{busy ? "Saving…" : "Save access"}</button>
        </div>
      </div>
    </div>}
    </details>
  </div>;
}
