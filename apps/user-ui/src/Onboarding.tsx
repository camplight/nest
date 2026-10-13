import { useEffect, useState } from "react";
import type {
  AgentCharacter,
  OnboardingState,
  PersonalAgentSetup,
} from "@nest/schemas";
import { apiJson, getApiHeaders } from "./api";
import { AgentAvatar } from "./components/AgentAvatar";
import "./onboarding.css";
const characters: {
  id: AgentCharacter;
  name: string;
  role: string;
  description: string;
}[] = [
  {
    id: "puff",
    name: "Puff",
    role: "Strategy",
    description: "Shape direction, positioning and priorities.",
  },
  {
    id: "moss",
    name: "Moss",
    role: "Research",
    description: "Understand people, competitors and markets.",
  },
  {
    id: "muff",
    name: "Muff",
    role: "Product",
    description: "Turn ideas into clear product direction.",
  },
  {
    id: "pom",
    name: "Pom",
    role: "Design",
    description: "Explore experiences and visual direction.",
  },
  {
    id: "pip",
    name: "Pip",
    role: "Engineering",
    description: "Plan, build and improve technical solutions.",
  },
];
const json = (path: string, body?: unknown, method = "POST") =>
  apiJson<any>(path, {
    method,
    headers: getApiHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
function message(e: unknown) {
  const text =
    e instanceof Error ? e.message : "Something went wrong. Please retry.";
  try {
    return JSON.parse(text).error ?? text;
  } catch {
    return text;
  }
}
type Connection = { id: string; toolkit: string; status: string };
export function AgentSetupForm({onCreated}:{onCreated:(name:string)=>void}) {
  const [state,setState] = useState<OnboardingState|null>(null);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const [attempt,setAttempt] = useState(0);
  const [name,setName] = useState("");
  const [character,setCharacter] = useState<AgentCharacter>("puff");
  const [brief,setBrief] = useState("");
  useEffect(()=>{
    const abort = new AbortController();
    setError("");
    apiJson<OnboardingState>("/api/onboarding",{signal:abort.signal}).then(s=>{
      setState(s);setName(s.setup?.name ?? s.suggestedName);setCharacter(s.setup?.character ?? "puff");setBrief(s.setup?.brief ?? "");
      if(s.setup?.channelId && !s.problem)onCreated(s.setup.name);
    }).catch(e=>{if(!abort.signal.aborted)setError(message(e));});
    return ()=>abort.abort();
  },[attempt]);
  async function create() {
    if(busy)return;
    setBusy(true);setError("");
    try {
      const setup:PersonalAgentSetup=await json("/api/onboarding/agent",{name,character,brief});
      setState(s=>s?{...s,setup}:s);
      await json("/api/onboarding/complete",{});
      onCreated(setup.name);
    }catch(e){setError(message(e));}finally{setBusy(false);}
  }
  return <section className="onboarding agent-create" aria-label="Create a personal agent">
    <div className="onboarding-heading"><h2>Add your agent to the team</h2><p>Choose a character, name your collaborator, and describe what you need. You can configure their model and connected apps in agent settings.</p></div>
    {error && <div role="alert" className="onboarding-notice">{error} <button onClick={()=>setAttempt(n=>n+1)}>Refresh setup</button></div>}
    {state?.problem && <p role="alert">{state.problem}</p>}
    {!state && !error && <p role="status">Loading agent setup…</p>}
    {state && (            <div className="onboarding-meet">
              <div
                className="onboarding-character-list"
                role="group"
                aria-label="Choose your agent character"
              >
                {characters.map((c) => (
                  <button
                    key={c.id}
                    aria-pressed={character === c.id}
                    disabled={!!state.setup || busy}
                    onClick={() => {
                      setCharacter(c.id);
                      setName(
                        (n) =>
                          c.name + n.replace(/^(Puff|Moss|Muff|Pom|Pip)/, ""),
                      );
                    }}
                  >
                    <AgentAvatar name={c.name} size={76} />
                    <span>
                      <strong>{c.name}</strong>
                      <span>{c.role} companion</span>
                      <small>{c.description}</small>
                    </span>
                  </button>
                ))}
              </div>
              <form
                className="onboarding-agent-form dashboard-card"
                onSubmit={(e) => {
                  e.preventDefault();
                  void create();
                }}
              >
                <AgentAvatar name={character} size={120} />
                <h2>Your new collaborator</h2>
                <label>
                  Agent name
                  <input
                    required
                    minLength={3}
                    maxLength={48}
                    pattern="[A-Za-z][A-Za-z0-9_\-]{2,47}"
                    value={name}
                    disabled={!!state.setup || busy}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <small>
                  For example, PuffVitaliy or PuffNaska. This is how you’ll find
                  your agent in Nest.
                </small>
                <label>
                  What would you like help with?
                  <textarea
                    maxLength={2000}
                    rows={4}
                    value={brief}
                    disabled={!!state.setup || busy}
                    onChange={(e) => setBrief(e.target.value)}
                    placeholder="Planning my week, preparing for meetings, and keeping track of project decisions…"
                  />
                </label>
                <p className="onboarding-privacy">
                  Your agent and first conversation are private. Connecting an
                  app is a separate choice.
                </p>
                {!state.provisioningAvailable && (
                  <p role="status" className="onboarding-notice">
                    Your administrator needs to finish model and runner setup.
                    Your account is ready; agent creation will be available once
                    that is configured.
                  </p>
                )}
                <button
                  className="onboarding-primary"
                  disabled={
                    busy || (!state.provisioningAvailable && !state.setup)
                  }
                >
                  {busy
                    ? "Preparing your agent…"
                    : state.setup
                      ? "Resume setup"
                      : "Create agent →"}
                </button>
              </form>
            </div>)}
  </section>;
}
export function Connections({ agentName, onPermissionsChanged }: { agentName: string; onPermissionsChanged?: () => void }) {
  const [connections, setConnections] = useState<Connection[]>([]),
    [kits, setKits] = useState<
      {
        slug: string;
        name: string;
        description: string;
        connectable: boolean;
      }[]
    >([]);
  const [query, setQuery] = useState(""),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [loaded, setLoaded] = useState(false);
  async function refresh() {
    try {
      const all: Connection[] = [];
      let next: string | null = null;
      do {
        const result: { items: Connection[]; nextCursor: string | null } =
          await apiJson(
            "/api/integrations/connections" +
              (next ? `?cursor=${encodeURIComponent(next)}` : ""),
          );
        all.push(...result.items);
        next = result.nextCursor;
      } while (next);
      setConnections(all);
      onPermissionsChanged?.();
      setLoaded(true);
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    void refresh();
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    const timeout = setTimeout(() => {
      apiJson<any>(
        `/api/integrations/toolkits?search=${encodeURIComponent(query)}`,
        { signal: abort.signal },
      )
        .then((r) => {
          setKits(r.items);
          setCursor(r.nextCursor);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(message(e));
        });
    }, 250);
    return () => {
      clearTimeout(timeout);
      abort.abort();
    };
  }, [query]);
  async function connect(slug: string) {
    setBusy(slug);
    setError("");
    try {
      const result = await json("/api/integrations/connections/link", {
        toolkit: slug,
      });
      const url = new URL(result.redirectUrl);
      if (
        url.protocol !== "https:" ||
        Boolean(url.username || url.password)
      )
        throw Error("Invalid connection URL");
      window.location.assign(url.toString());
    } catch (e) {
      setError(message(e));
      setBusy("");
    }
  }
  async function revoke(id: string) {
    if (
      !window.confirm(
        "Disconnect this account and remove its agent tool grants?",
      )
    )
      return;
    setBusy(id);
    setError("");
    try {
      await json(
        `/api/integrations/connections/${encodeURIComponent(id)}/revoke`,
        {},
      );
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="onboarding-connections">
      {error && <p role="alert">{error}</p>}
      <div className="dashboard-section-title">
        <h2>Your connections</h2>
        <button onClick={() => void refresh()}>Refresh status</button>
      </div>
      {!loaded ? (
        <p role="status">Checking your accounts…</p>
      ) : !connections.length ? (
        <p>
          No apps connected yet. Choose one below, or continue without
          connecting.
        </p>
      ) : (
        connections.map((c) => (
          <article className="dashboard-card onboarding-connection" key={c.id}>
            <header>
              <div>
                <h3>{c.toolkit}</h3>
                <small>{c.status === "ACTIVE" ? "Connected" : c.status}</small>
              </div>
              <button
                className="dashboard-action"
                disabled={!!busy}
                onClick={() => void revoke(c.id)}
              >
                Disconnect
              </button>
            </header>
            {c.status === "ACTIVE" ? (
              <ToolGrants
                key={c.id + c.status}
                agentName={agentName}
                connection={c}
                onSaved={onPermissionsChanged}
              />
            ) : (
              <p>Finish authentication or reconnect before granting tools.</p>
            )}
          </article>
        ))
      )}
      <label className="onboarding-search">
        Find an app
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Trello, Slack, Google Drive, Miro, Fathom…"
        />
      </label>
      <div className="onboarding-apps">
        {kits.map((kit) => (
          <article className="dashboard-card" key={kit.slug}>
            <h3>{kit.name}</h3>
            <p>{kit.description}</p>
            <button
              className="dashboard-action"
              disabled={!!busy || !kit.connectable}
              onClick={() => void connect(kit.slug)}
            >
              {busy === kit.slug
                ? "Opening…"
                : kit.connectable
                  ? "Connect account"
                  : "Admin setup needed"}
            </button>
          </article>
        ))}
      </div>
      {!kits.length && <p>No matching apps found.</p>}
      {cursor && (
        <button
          className="dashboard-action"
          onClick={async () => {
            try {
              const r = await apiJson<any>(
                `/api/integrations/toolkits?search=${encodeURIComponent(query)}&cursor=${encodeURIComponent(cursor)}`,
              );
              setKits((k) => [
                ...k,
                ...r.items.filter(
                  (i: any) => !k.some((old) => old.slug === i.slug),
                ),
              ]);
              setCursor(r.nextCursor);
            } catch (e) {
              setError(message(e));
            }
          }}
        >
          More apps
        </button>
      )}
    </div>
  );
}
function ToolGrants({
  agentName,
  connection,
  onSaved,
}: {
  agentName: string;
  connection: Connection;
  onSaved?: () => void;
}) {
  const [tools, setTools] = useState<
      { slug: string; name: string; description: string }[]
    >([]),
    [selected, setSelected] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [cursor, setCursor] = useState<string | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const path = `/api/integrations/agents/${encodeURIComponent(agentName)}/grants`;
  useEffect(() => {
    let cancelled = false;
    apiJson<{ connectionId: string; tools: string[] }[]>(path)
      .then((all) => {
        if (!cancelled) {
          setSelected(
            all.find((g) => g.connectionId === connection.id)?.tools ?? [],
          );
          setReady(true);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(message(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path, connection.id]);
  useEffect(() => {
    const abort = new AbortController();
    const timeout = setTimeout(() => {
      apiJson<any>(
        `/api/integrations/connections/${encodeURIComponent(connection.id)}/tools?search=${encodeURIComponent(query)}`,
        { signal: abort.signal },
      )
        .then((r) => {
          setTools(r.items);
          setCursor(r.nextCursor);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(message(e));
        });
    }, 250);
    return () => {
      clearTimeout(timeout);
      abort.abort();
    };
  }, [query, connection.id]);
  return (
    <details>
      <summary>
        Choose tools for {agentName} · {selected.length} selected
      </summary>
      <p>
        Connecting this account does not give {agentName} access. Select tools
        and click Save tool access, then enable the skill above. Some tools can send messages, change or
        delete data. Read each description before granting access.
      </p>
      {error && <p role="alert">{error}</p>}
      <label>
        Search tools
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="onboarding-tools">
        {tools.map((tool) => (
          <label key={tool.slug}>
            <input
              type="checkbox"
              disabled={!ready || busy}
              checked={selected.includes(tool.slug)}
              onChange={(e) => {
                setSaved(false);
                setSelected((s) =>
                  e.target.checked
                    ? [...s, tool.slug]
                    : s.filter((t) => t !== tool.slug),
                );
              }}
            />
            <span>
              <strong>{tool.name || tool.slug}</strong>
              <small>{tool.description}</small>
            </span>
          </label>
        ))}
      </div>
      {cursor && (
        <button
          onClick={async () => {
            try {
              const r = await apiJson<any>(
                `/api/integrations/connections/${encodeURIComponent(connection.id)}/tools?search=${encodeURIComponent(query)}&cursor=${encodeURIComponent(cursor)}`,
              );
              setTools((t) => [
                ...t,
                ...r.items.filter(
                  (i: any) => !t.some((old) => old.slug === i.slug),
                ),
              ]);
              setCursor(r.nextCursor);
            } catch (e) {
              setError(message(e));
            }
          }}
        >
          More tools
        </button>
      )}
      <div className="onboarding-footer">
        <button
          className="dashboard-action"
          disabled={!ready || busy}
          onClick={() => {
            setSelected([]);
            setSaved(false);
          }}
        >
          Clear selection
        </button>
        <button
          className="dashboard-action"
          disabled={!ready || busy || selected.length > 100}
          onClick={async () => {
            setBusy(true);
            setError("");
            setSaved(false);
            try {
              await json(
                `${path}/${encodeURIComponent(connection.id)}`,
                { tools: selected },
                "PUT",
              );
              setSaved(true);
              onSaved?.();
            } catch (e) {
              setError(message(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Save tool access"}
        </button>
        {saved && <span role="status">Tool access saved</span>}
      </div>
    </details>
  );
}
