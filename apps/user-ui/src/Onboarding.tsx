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
export function Onboarding({
  onMenu,
  onChat,
  onHome,
}: {
  onMenu: () => void;
  onChat: (id: string) => void;
  onHome: () => void;
}) {
  const [state, setState] = useState<OnboardingState | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [name, setName] = useState(""),
    [character, setCharacter] = useState<AgentCharacter>("puff"),
    [brief, setBrief] = useState("");
  const [step, setStep] = useState(0),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    apiJson<OnboardingState>("/api/onboarding", { signal: abort.signal })
      .then((s) => {
        setState(s);
        setName(s.setup?.name ?? s.suggestedName);
        setCharacter(s.setup?.character ?? "puff");
        setBrief(s.setup?.brief ?? "");
        setStep(s.setup?.channelId ? 1 : 0);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(message(e));
      });
    return () => abort.abort();
  }, [attempt]);
  async function create() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const setup: PersonalAgentSetup = await json("/api/onboarding/agent", {
        name,
        character,
        brief,
      });
      setState((s) => (s ? { ...s, setup } : s));
      setStep(1);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function finish() {
    setBusy(true);
    setError("");
    try {
      const setup: PersonalAgentSetup = await json(
        "/api/onboarding/complete",
        {},
      );
      if (setup.channelId) onChat(setup.channelId);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="dashboard onboarding" aria-label="Personal agent setup">
      <header className="dashboard-topbar">
        <button className="sidebar-mobile-toggle" onClick={onMenu}>
          Menu
        </button>
        <span>YOUR PERSONAL AGENT</span>
        <button className="dashboard-action" onClick={onHome}>
          Back to Nest
        </button>
      </header>
      <div className="onboarding-content">
        <ol className="onboarding-steps" aria-label="Setup progress">
          {["Meet your agent", "Connect your apps", "Start together"].map(
            (label, i) => (
              <li key={label} aria-current={step === i ? "step" : undefined}>
                <span>{i + 1}</span>
                {label}
              </li>
            ),
          )}
        </ol>
        {error && (
          <div role="alert" className="onboarding-notice">
            {error}{" "}
            <button onClick={() => setAttempt((a) => a + 1)}>
              Refresh setup
            </button>
          </div>
        )}
        {!state && !error && <p role="status">Loading your workspace…</p>}
        {state && step === 0 && (
          <>
            <div className="onboarding-heading">
              <p>A LITTLE HELP, MADE YOURS</p>
              <h1>Meet your personal agent.</h1>
              <p>
                Choose a character, give them a name, and tell them what matters
                to you. Start with one trusted collaborator.
              </p>
            </div>
            <div className="onboarding-meet">
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
                      : "Create my agent →"}
                </button>
              </form>
            </div>
          </>
        )}
        {state && step === 1 && (
          <>
            <div className="onboarding-heading">
              <AgentAvatar
                name={state.setup?.character ?? character}
                size={76}
              />
              <h1>Bring your tools along.</h1>
              <p>
                Connect the apps you use, then choose exactly what{" "}
                {state.setup?.name} can do. You can skip this and return
                whenever you’re ready.
              </p>
            </div>
            {state.connectionsAvailable && state.setup ? (
              <Connections agentName={state.setup.name} />
            ) : (
              <div className="dashboard-card onboarding-notice">
                <h2>App connections are being prepared</h2>
                <p>
                  You can continue to your personal workspace now. Connections
                  will appear here after your administrator finishes integration
                  setup.
                </p>
              </div>
            )}
            <div className="onboarding-footer">
              <p>Google sign-in does not connect your Drive or Gmail.</p>
              <button className="onboarding-primary" onClick={() => setStep(2)}>
                Continue →
              </button>
            </div>
          </>
        )}
        {state && step === 2 && (
          <div className="onboarding-ready dashboard-card">
            <AgentAvatar
              name={state.setup?.character ?? character}
              size={144}
            />
            <h1>A place to think together.</h1>
            <p>
              Your private workspace with <strong>{state.setup?.name}</strong>{" "}
              is ready. Try asking for help planning your week, or bring a
              project you want to move forward.
            </p>
            <p className="onboarding-privacy">
              Connected tools work only in your private conversation. Sharing
              account access with teammates will require a separate delegation
              feature.
            </p>
            {state.problem && <p role="alert">{state.problem}</p>}
            <button
              className="onboarding-primary"
              disabled={busy || !!state.problem}
              onClick={() => void finish()}
            >
              {busy ? "Opening…" : "Open my workspace →"}
            </button>
            <button className="dashboard-action" onClick={() => setStep(1)}>
              Back to connections
            </button>
            <small>
              Workspace created does not mean the agent is online. Replies
              depend on the configured runner and model.
            </small>
          </div>
        )}
      </div>
    </section>
  );
}
function Connections({ agentName }: { agentName: string }) {
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
            "/api/composio/connections" +
              (next ? `?cursor=${encodeURIComponent(next)}` : ""),
          );
        all.push(...result.items);
        next = result.nextCursor;
      } while (next);
      setConnections(all);
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
        `/api/composio/toolkits?search=${encodeURIComponent(query)}`,
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
      const result = await json("/api/composio/connections/link", {
        toolkit: slug,
      });
      const url = new URL(result.redirectUrl);
      if (
        url.protocol !== "https:" ||
        !(
          url.hostname === "composio.dev" ||
          url.hostname.endsWith(".composio.dev")
        )
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
        `/api/composio/connections/${encodeURIComponent(id)}/revoke`,
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
                `/api/composio/toolkits?search=${encodeURIComponent(query)}&cursor=${encodeURIComponent(cursor)}`,
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
}: {
  agentName: string;
  connection: Connection;
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
  const path = `/api/composio/agents/${encodeURIComponent(agentName)}/grants`;
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
        `/api/composio/connections/${encodeURIComponent(connection.id)}/tools?search=${encodeURIComponent(query)}`,
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
        Only selected tools are allowed. Some can send messages, change or
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
                `/api/composio/connections/${encodeURIComponent(connection.id)}/tools?search=${encodeURIComponent(query)}&cursor=${encodeURIComponent(cursor)}`,
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
