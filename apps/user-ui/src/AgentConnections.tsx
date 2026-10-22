import type {
  ConnectionCapability,
  ConnectionSkillStatus,
} from "@nest/schemas";
import { useEffect, useState } from "react";
import { apiJson } from "./api";
import { Connections } from "./Onboarding";

/** Optional Nest integration: its loading/errors never block the settings form. */
export function AgentConnections({ name }: { name: string }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [skillAvailable, setSkillAvailable] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [permissionsRevision, setPermissionsRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setAvailable(null);
    setFailed(false);
    void apiJson<ConnectionCapability>("/api/integrations/config", {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) {
          setAvailable(result.configured);
          setSkillAvailable(result.skillAvailable);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [attempt]);
  return (
    <section
      className="onboarding agent-connections"
      aria-label="Connected apps"
    >
      <h2>Connected apps</h2>
      <p>
        Choose which accounts and tools {name} can use in
        conversations and projects with trusted teammates. Google sign-in does not connect Drive or Gmail.
      </p>
      {failed ? (
        <p role="alert">
          Could not load connection settings.{" "}
          <button
            className="dashboard-action"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry connections
          </button>
        </p>
      ) : available === null ? (
        <p role="status">Loading connection settings…</p>
      ) : available ? (
        <>
          <ConnectionSkill key={name} name={name} available={skillAvailable} revision={permissionsRevision} />

          <Connections agentName={name} onPermissionsChanged={() => setPermissionsRevision(value => value + 1)} />
        </>
      ) : (
        <div className="dashboard-card onboarding-notice">
          <h3>App connections are being prepared</h3>
          <p>
            Connections will appear here after your administrator finishes
            integration setup.
          </p>
        </div>
      )}
    </section>
  );
}

function ConnectionSkill({
  name,
  available,
  revision,
}: {
  name: string;
  available: boolean;
  revision: number;
}) {
  const [state, setState] = useState<ConnectionSkillStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const path = `/api/integrations/agents/${encodeURIComponent(name)}/skill`;
  useEffect(() => {
    const abort = new AbortController();
    setState(null);
    setError("");
    void apiJson<ConnectionSkillStatus>(path, { signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted) setState(result);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError("Could not load app access.");
      });
    return () => abort.abort();
  }, [path, revision]);
  async function change(enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await apiJson<any>(path, {
        method: enabled ? "POST" : "DELETE",
        headers: { "content-type": "application/json" },
        body: enabled ? "{}" : undefined,
      });
      setState(current => enabled ? result : current ? { ...current, enabled: false, expiresAt: null } : null);
    } catch (failure) {
      let message = "Could not update app access. Please retry.";
      if (failure instanceof Error) {
        try {
          const result = JSON.parse(failure.message);
          if (typeof result.error === "string") message = result.error;
        } catch {
          /* Network failures use the fallback above. */
        }
      }
      setError(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="dashboard-card connection-access-control">
      <div className="connection-access-overview">
      <h3>App access</h3>
      <p>Allow apps below, then enable them for {name}.</p>
      </div>
      <div className="connection-skill-actions">
        <button
          className="dashboard-action"
          disabled={busy || !state || !available || state.grantedToolCount === 0}
          onClick={() => void change(true)}
        >
          {busy
            ? "Updating…"
            : state?.enabled
              ? "Renew app access"
              : "Enable app access"}
        </button>
        {state?.enabled && (
          <button
            className="dashboard-action"
            disabled={busy}
            onClick={() => void change(false)}
          >
            Turn off app access
          </button>
        )}
      </div>
      <div className="connection-access-footer">
        <div className="connection-access-meta">
          {state && (state.grantedToolCount === 0 ? <span role="status">No actions are allowed yet.</span> : <span>{state.grantedToolCount} {state.grantedToolCount === 1 ? "action" : "actions"} allowed</span>)}
          {state?.enabled && <><span>Expires {new Date(state.expiresAt!).toLocaleDateString()}</span><span role="status">{state.preloadConfigured ? "Ready for your next message." : "Renew access before your next message."}</span></>}
        </div>
        <details className="connection-access-help"><summary>How access works</summary><p>Teammates are trusted by default. They can talk to your agent and use its granted tools, including write actions, without your presence or a separate approval. You control linked accounts and tool grants. Turn off app access or remove grants to revoke future tool use. Conversation permissions still control who can read and post; public channels may have other readers. The agent can carry information between chats.</p></details>
      </div>
      {error && <p className="connection-access-notice" role="alert">{error}</p>}
      {!available && <p className="connection-access-notice">Ask your administrator to enable app connections.</p>}
    </article>
  );
}
