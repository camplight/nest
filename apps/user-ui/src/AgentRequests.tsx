import { useEffect, useState, type FormEvent } from "react";
import type {
  AssistantOffer,
  AgentRequest,
  AgentRequestList,
  AgentRequestResponse,
} from "@nest/schemas";
import { apiJson, getApiHeaders } from "./api";
import { AgentAvatar } from "./components/AgentAvatar";
import "./agent-requests.css";

export type AgentRequestLocation = {
  active: boolean;
  requestId: string | null;
  assistant: string | null;
};
export function readAgentRequestLocation(): AgentRequestLocation {
  const url = new URL(window.location.href);
  return {
    active:
      url.searchParams.get("view") === "agents" &&
      url.searchParams.get("tab") === "requests",
    requestId: url.searchParams.get("request"),
    assistant: url.searchParams.get("assistant"),
  };
}
export function prepareAssistantRequest(
  userId: string,
  name: string,
  brief: string,
) {
  const key = `nest:assistant-request:${userId}:${name}`;
  try {
    const existing = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (existing?.submitted) return;
    sessionStorage.setItem(
      key,
      JSON.stringify({
        id: existing?.id ?? crypto.randomUUID(),
        title: existing?.title ?? "",
        brief: brief || existing?.brief || "",
        submitted: false,
      }),
    );
  } catch {
    /* The request form remains usable if tab storage is unavailable. */
  }
}
function message(error: unknown) {
  if (error instanceof Error) {
    try {
      const value = JSON.parse(error.message);
      if (typeof value.error === "string") return value.error;
    } catch {
      /* Use a safe network fallback. */
    }
  }
  return "Could not load assistant requests. Please retry.";
}
const labels: Record<AgentRequest["status"], string> = {
  pending: "Waiting for approval",
  dispatching: "Sending privately",
  working: "Awaiting approved reply",
  completed: "Reply shared",
  declined: "Declined",
  cancelled: "Cancelled",
};

export function SharedAssistants({
  query,
  onAsk,
}: {
  query: string;
  onAsk: (name: string) => void;
}) {
  const [offers, setOffers] = useState<AssistantOffer[] | null>(null),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void apiJson<{ items: AssistantOffer[] }>("/api/assistants", {
      signal: abort.signal,
    })
      .then((value) => {
        if (!abort.signal.aborted) {
          setOffers(value.items);
          setError("");
        }
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(message(reason));
      });
    return () => abort.abort();
  }, [attempt]);
  const matching =
    offers?.filter(
      (offer) =>
        !offer.yours &&
        `${offer.agentName} ${offer.ownerName} ${offer.description}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    ) ?? [];
  return (
    <section className="shared-assistants" aria-label="Personal assistants">
      <div className="dashboard-section-title">
        <h2>Personal assistants</h2>
      </div>
      <p>
        Ask a teammate’s assistant for help. Its owner approves the work and the
        reply.
      </p>
      {error ? (
        <p role="alert">
          {error}{" "}
          <button
            className="dashboard-action"
            onClick={() => setAttempt((v) => v + 1)}
          >
            Retry assistants
          </button>
        </p>
      ) : !offers ? (
        <p role="status">Loading assistants…</p>
      ) : matching.length === 0 ? (
        <p>
          {query
            ? "No matching shared assistants."
            : "Teammates’ assistants appear here when their owners accept requests."}
        </p>
      ) : (
        <div className="dashboard-list">
          {matching.map((offer) => (
            <article
              className="dashboard-card agent-directory-row"
              key={offer.agentName}
            >
              <AgentAvatar name={offer.agentName} />
              <div className="agent-directory-identity">
                <h3>{offer.agentName}</h3>
                <small>Assistant to {offer.ownerName}</small>
                <p>{offer.description}</p>
              </div>
              <span className="dashboard-pill">Owner approval</span>
              <button
                className="dashboard-action"
                onClick={() => onAsk(offer.agentName)}
              >
                Ask {offer.agentName}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function AssistantSharing({ name }: { name: string }) {
  const [state, setState] = useState<{
      enabled: boolean;
      description: string;
      available: boolean;
    } | null>(null),
    [enabled, setEnabled] = useState(false),
    [description, setDescription] = useState(""),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void apiJson<{ enabled: boolean; description: string; available: boolean }>(
      `/api/assistants/${encodeURIComponent(name)}/offer`,
      { signal: abort.signal },
    )
      .then((value) => {
        if (!abort.signal.aborted) {
          setState(value);
          setEnabled(value.enabled);
          setDescription(value.description);
          setError("");
        }
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(message(reason));
      });
    return () => abort.abort();
  }, [name, attempt]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      setState(
        await apiJson(`/api/assistants/${encodeURIComponent(name)}/offer`, {
          method: "PUT",
          headers: getApiHeaders(),
          body: JSON.stringify({ enabled, description }),
        }),
      );
      setSaved(true);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="assistant-sharing" aria-label="Teammate requests">
      <h2>Teammate requests</h2>
      <p>
        Let teammates ask {name} for help. You approve each request before your
        agent works, then choose the reply to share. Your private conversation
        and connected accounts stay private.
      </p>
      {error && (
        <p role="alert">
          {error}{" "}
          {!state && (
            <button
              className="dashboard-action"
              onClick={() => setAttempt((v) => v + 1)}
            >
              Retry request settings
            </button>
          )}
        </p>
      )}
      {!state && !error && <p role="status">Loading request settings…</p>}
      {state && (
        <form className="request-form" onSubmit={save}>
          <label className="request-checkbox">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy || !state.available}
              onChange={(e) => {
                setEnabled(e.target.checked);
                setSaved(false);
              }}
            />
            Let teammates request work from {name}
          </label>
          <label>
            What can teammates ask for?
            <textarea
              rows={3}
              maxLength={1200}
              aria-label="What can teammates ask for?"
              value={description}
              disabled={busy}
              onChange={(e) => {
                setDescription(e.target.value);
                setSaved(false);
              }}
              placeholder="For example: launch-board updates and preparing Trello cards."
              required={enabled}
            />
          </label>
          <small>
            This description and your agent’s name appear to signed-in
            teammates. Turning requests off stops new requests; existing ones
            stay in your inbox.
          </small>
          {!state.available && (
            <p>
              Your administrator needs to finish assistant setup before you can
              accept requests.
            </p>
          )}
          <div className="request-actions">
            {saved && <span role="status">Request settings saved.</span>}
            <button
              className="dashboard-action"
              disabled={
                busy ||
                (enabled === state.enabled && description === state.description)
              }
            >
              {busy ? "Saving…" : "Save request settings"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function mergeRequests(old: AgentRequest[], fresh: AgentRequest[]) {
  const map = new Map(old.map((row) => [row.id, row]));
  fresh.forEach((row) => map.set(row.id, row));
  return [...map.values()].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id),
  );
}

export function AgentRequests({
  location,
  userId,
  onSelect,
}: {
  location: AgentRequestLocation;
  userId: string | null;
  onSelect: (id?: string, assistant?: string) => void;
}) {
  const [items, setItems] = useState<AgentRequest[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [hasMore, setHasMore] = useState(false),
    [attempt, setAttempt] = useState(0),
    [loadingMore, setLoadingMore] = useState(false),
    [filter, setFilter] = useState<"incoming" | "outgoing">("incoming");
  useEffect(() => {
    if (location.requestId || location.assistant) return;
    setLoading(true);
    setItems([]);
    setError("");
    let first = true;
    const abort = new AbortController();
    async function load() {
      try {
        const value = await apiJson<AgentRequestList>(
          `/api/agent-requests?direction=${filter}`,
          {
            signal: abort.signal,
          },
        );
        if (!abort.signal.aborted) {
          const replace = first;
          first = false;
          setItems((old) =>
            replace ? value.items : mergeRequests(old, value.items),
          );
          if (replace) setHasMore(value.hasMore);
          setError("");
        }
      } catch (reason) {
        if (!abort.signal.aborted) setError(message(reason));
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [attempt, filter, location.requestId, location.assistant]);
  async function more() {
    setLoadingMore(true);
    try {
      const value = await apiJson<AgentRequestList>(
        `/api/agent-requests?direction=${filter}&offset=${items.length}`,
      );
      setItems((old) => mergeRequests(old, value.items));
      setHasMore(value.hasMore);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoadingMore(false);
    }
  }
  if (location.requestId)
    return (
      <AgentRequestDetails
        key={location.requestId}
        id={location.requestId}
        onBack={() => onSelect()}
      />
    );
  if (location.assistant && userId)
    return (
      <NewAgentRequest
        key={location.assistant}
        name={location.assistant}
        userId={userId}
        onBack={() => onSelect()}
        onCreated={(id) => onSelect(id)}
      />
    );
  const visible = items.filter((row) =>
    filter === "incoming" ? row.isOwner : !row.isOwner,
  );
  return (
    <section className="assistant-requests" aria-label="Assistant requests">
      <p>
        Your assistant works privately. Requests and approved replies are
        visible only to the requester and the owner.
      </p>
      <div className="request-tabs" aria-label="Request inbox">
        <button
          className="dashboard-action"
          aria-pressed={filter === "incoming"}
          onClick={() => setFilter("incoming")}
        >
          Incoming
        </button>
        <button
          className="dashboard-action"
          aria-pressed={filter === "outgoing"}
          onClick={() => setFilter("outgoing")}
        >
          Outgoing
        </button>
        <button
          className="dashboard-action"
          onClick={() => setAttempt((v) => v + 1)}
        >
          Refresh requests
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading requests…</p>}
      {!loading && !error && visible.length === 0 && (
        <div className="dashboard-empty">
          <h2>
            {filter === "incoming"
              ? "No incoming requests yet"
              : "No outgoing requests yet"}
          </h2>
          <p>
            {filter === "incoming"
              ? "Accept teammate requests in your agent’s settings to get started."
              : "Choose a personal assistant in All agents to request help."}
          </p>
        </div>
      )}
      <div className="dashboard-list">
        {visible.map((row) => (
          <article className="dashboard-card agent-directory-row" key={row.id}>
            <AgentAvatar name={row.agentName} />
            <div className="agent-directory-identity">
              <button
                className="agent-name-link"
                onClick={() => onSelect(row.id)}
              >
                {row.title}
              </button>
              <p>
                {row.agentName} ·{" "}
                {row.isOwner
                  ? `Requested by ${row.requesterName}`
                  : `Assistant to ${row.ownerName}`}
              </p>
            </div>
            <span className="dashboard-pill">{labels[row.status]}</span>
            <button
              className="dashboard-action"
              onClick={() => onSelect(row.id)}
            >
              View request
            </button>
          </article>
        ))}
      </div>
      {hasMore && (
        <button
          className="dashboard-action"
          disabled={loadingMore}
          onClick={() => void more()}
        >
          {loadingMore ? "Loading…" : "Load older requests"}
        </button>
      )}
    </section>
  );
}

function NewAgentRequest({
  name,
  userId,
  onBack,
  onCreated,
}: {
  name: string;
  userId: string;
  onBack: () => void;
  onCreated: (id: string) => void;
}) {
  const key = `nest:assistant-request:${userId}:${name}`;
  const [draft, setDraft] = useState(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (
        value &&
        typeof value.id === "string" &&
        typeof value.title === "string" &&
        typeof value.brief === "string"
      )
        return value as {
          id: string;
          title: string;
          brief: string;
          submitted: boolean;
        };
    } catch {
      /* Start a new draft. */
    }
    return { id: crypto.randomUUID(), title: "", brief: "", submitted: false };
  });
  const [offer, setOffer] = useState<AssistantOffer | null>(null),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void apiJson<{ items: AssistantOffer[] }>("/api/assistants", {
      signal: abort.signal,
    })
      .then((value) => {
        if (!abort.signal.aborted) {
          setOffer(
            value.items.find((row) => row.agentName === name && !row.yours) ??
              null,
          );
          setLoaded(true);
        }
      })
      .catch((reason) => {
        if (!abort.signal.aborted) {
          setError(message(reason));
          setLoaded(true);
        }
      });
    return () => abort.abort();
  }, [name, attempt]);
  function change(value: typeof draft) {
    setDraft(value);
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* In-memory retry still preserves the request ID. */
    }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    change({ ...draft, submitted: true });
    try {
      const row = await apiJson<AgentRequest>("/api/agent-requests", {
        method: "POST",
        headers: getApiHeaders(),
        body: JSON.stringify({
          id: draft.id,
          agentName: name,
          title: draft.title,
          brief: draft.brief,
        }),
      });
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* No persistent tab storage. */
      }
      onCreated(row.id);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="assistant-requests">
      <button className="dashboard-action" onClick={onBack}>
        ← Requests
      </button>
      <div className="request-heading">
        <AgentAvatar name={name} size={80} />
        <div>
          <h2>Ask {name}</h2>
          {offer && <p>Assistant to {offer.ownerName}</p>}
        </div>
      </div>
      {offer && <p>{offer.description}</p>}
      {!loaded && <p role="status">Loading assistant…</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          {!draft.submitted && (
            <button
              className="dashboard-action"
              onClick={() => setAttempt((v) => v + 1)}
            >
              Retry assistant
            </button>
          )}
        </p>
      )}
      {loaded && !offer && !draft.submitted && !error && (
        <p>
          This assistant is no longer accepting requests. Choose another
          assistant in All agents.
        </p>
      )}
      {(offer || draft.submitted) && (
        <form className="request-form" onSubmit={send}>
          <p>
            The owner will review this brief before the agent receives it.
            You’ll get only the reply the owner chooses to share.
          </p>
          <label>
            Request title
            <input
              required
              maxLength={180}
              aria-label="Request title"
              value={draft.title}
              disabled={busy || draft.submitted}
              onChange={(e) => change({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            What would you like help with?
            <textarea
              required
              rows={6}
              maxLength={8000}
              aria-label="What would you like help with?"
              value={draft.brief}
              disabled={busy || draft.submitted}
              onChange={(e) => change({ ...draft, brief: e.target.value })}
            />
          </label>
          {draft.submitted && !busy && (
            <p>Retry this unchanged request to recover its status safely.</p>
          )}
          <div className="request-actions">
            <button
              className="dashboard-action"
              disabled={busy || !draft.title.trim() || !draft.brief.trim()}
            >
              {busy
                ? "Sending…"
                : draft.submitted
                  ? "Retry request"
                  : "Send request"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function AgentRequestDetails({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const [row, setRow] = useState<AgentRequest | null>(null),
    [responses, setResponses] = useState<AgentRequestResponse[]>([]),
    [responseId, setResponseId] = useState(""),
    [reply, setReply] = useState(""),
    [feedback, setFeedback] = useState(""),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [busy, setBusy] = useState(false),
    [attempt, setAttempt] = useState(0),
    [responseError, setResponseError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      try {
        const value = await apiJson<AgentRequest>(`/api/agent-requests/${id}`, {
          signal: abort.signal,
        });
        if (!abort.signal.aborted) {
          setRow(value);
          setLoadError("");
        }
      } catch (reason) {
        if (!abort.signal.aborted) setLoadError(message(reason));
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [id, attempt]);
  useEffect(() => {
    if (!row?.isOwner || row.status !== "working") return;
    const abort = new AbortController();
    void apiJson<AgentRequestResponse[]>(
      `/api/agent-requests/${id}/responses`,
      { signal: abort.signal },
    )
      .then((value) => {
        if (!abort.signal.aborted) {
          setResponses(value);
          setResponseError("");
        }
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setResponseError(message(reason));
      });
    return () => abort.abort();
  }, [id, row?.isOwner, row?.status, attempt]);
  async function act(action: string, extra: Record<string, unknown> = {}) {
    if (!row) return;
    setBusy(true);
    setError("");
    try {
      setRow(
        await apiJson<AgentRequest>(`/api/agent-requests/${id}/${action}`, {
          method: "POST",
          headers: getApiHeaders(),
          body: JSON.stringify({ version: row.version, ...extra }),
        }),
      );
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="assistant-requests">
      <button className="dashboard-action" onClick={onBack}>
        ← Requests
      </button>
      {(error || loadError) && (
        <p role="alert">
          {error || loadError}{" "}
          <button
            className="dashboard-action"
            onClick={() => {
              setError("");
              setAttempt((v) => v + 1);
            }}
          >
            Refresh request
          </button>
        </p>
      )}
      {!row && !error && !loadError && <p role="status">Loading request…</p>}
      {row && (
        <>
          <div className="request-heading">
            <AgentAvatar name={row.agentName} size={80} />
            <div>
              <h2>{row.title}</h2>
              <p>
                {row.agentName} · Assistant to {row.ownerName}
              </p>
            </div>
            <span className="dashboard-pill">{labels[row.status]}</span>
          </div>
          <div className="request-context">
            <small>
              Requested by {row.requesterName} ·{" "}
              {new Date(row.createdAt).toLocaleString()}
            </small>
            <h3>Request brief</h3>
            <p className="request-text">{row.brief}</p>
          </div>
          {row.isOwner && row.status === "pending" && (
            <div className="request-review">
              <h3>Approve the work</h3>
              <p>
                Review the brief before giving it to your agent. It will work in
                your private conversation using its existing permissions. You’ll
                review its reply before the requester sees anything.
              </p>
              <div className="request-actions">
                <button
                  className="dashboard-action"
                  disabled={busy}
                  onClick={() => void act("approve")}
                >
                  {busy ? "Updating…" : `Approve and ask ${row.agentName}`}
                </button>
              </div>
              <label>
                Reason for declining (optional)
                <textarea
                  rows={2}
                  maxLength={2000}
                  aria-label="Reason for declining (optional)"
                  value={feedback}
                  disabled={busy}
                  onChange={(e) => setFeedback(e.target.value)}
                />
              </label>
              <button
                className="dashboard-action"
                disabled={busy}
                onClick={() => void act("decline", { feedback })}
              >
                Decline request
              </button>
            </div>
          )}
          {row.isOwner && row.status === "dispatching" && (
            <div className="request-review">
              <p>
                The private delivery has not been confirmed. Retry to recover
                this same request.
              </p>
              <button
                className="dashboard-action"
                disabled={busy}
                onClick={() => void act("approve")}
              >
                Retry approved work
              </button>
            </div>
          )}
          {!row.isOwner && row.status === "pending" && (
            <div className="request-review">
              <p>
                {row.ownerName} will review your request before the agent
                starts.
              </p>
              <button
                className="dashboard-action"
                disabled={busy}
                onClick={() => void act("cancel")}
              >
                Cancel request
              </button>
            </div>
          )}
          {!row.isOwner && ["working", "dispatching"].includes(row.status) && (
            <p role="status">
              The owner approved your request. Your reply will appear here after
              the owner reviews it.
            </p>
          )}
          {row.isOwner && row.status === "working" && (
            <div className="request-review">
              <h3>Review and share a reply</h3>
              <p>
                These responses are private to you. Choose the one that answers
                this request, then edit what the requester will receive. Only
                the approved text is shared.
              </p>
              <button
                className="dashboard-action"
                disabled={busy}
                onClick={() => setAttempt((v) => v + 1)}
              >
                Refresh agent responses
              </button>
              {responseError && <p role="alert">{responseError}</p>}
              {responses.length === 0 && !responseError && (
                <p>No agent response yet. Refresh after your agent replies.</p>
              )}
              {responses.length > 0 && (
                <form
                  className="request-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act("reply", { eventId: responseId, reply });
                  }}
                >
                  <label>
                    Private agent response
                    <select
                      aria-label="Private agent response"
                      required
                      disabled={busy}
                      value={responseId}
                      onChange={(e) => {
                        setResponseId(e.target.value);
                        setReply(
                          responses.find((item) => item.id === e.target.value)
                            ?.text ?? "",
                        );
                      }}
                    >
                      <option value="">Choose a response…</option>
                      {responses.map((item) => (
                        <option key={item.id} value={item.id}>
                          {new Date(item.createdAt).toLocaleTimeString()} ·{" "}
                          {item.text.slice(0, 90)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Reply to share
                    <textarea
                      required
                      rows={8}
                      maxLength={24000}
                      aria-label="Reply to share"
                      value={reply}
                      disabled={busy || !responseId}
                      onChange={(e) => setReply(e.target.value)}
                    />
                  </label>
                  <small>
                    Check for private details before sharing. The requester will
                    see this exact text.
                  </small>
                  <div className="request-actions">
                    <button
                      className="dashboard-action"
                      disabled={busy || !responseId || !reply.trim()}
                    >
                      {busy ? "Sharing…" : "Share approved reply"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
          {row.status === "completed" && (
            <div className="request-approved">
              <h3>Approved reply</h3>
              <p className="request-text">{row.reply}</p>
              <small>Reviewed and shared by {row.ownerName}.</small>
            </div>
          )}
          {row.status === "declined" && (
            <div className="request-review">
              <h3>Request declined</h3>
              <p className="request-text">
                {row.feedback || "The owner declined this request."}
              </p>
            </div>
          )}
          {row.status === "cancelled" && (
            <p>This request was cancelled before approval.</p>
          )}
        </>
      )}
    </section>
  );
}
