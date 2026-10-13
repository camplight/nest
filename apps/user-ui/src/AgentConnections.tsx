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
        Choose which accounts and tools {name} can use in your private
        conversation. Google sign-in does not connect Drive or Gmail.
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
        if (!abort.signal.aborted) setError("Could not load skill access.");
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
      let message = "Could not update skill access. Please retry.";
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
    <article className="dashboard-card onboarding-notice">
      <h3>Agent skill access</h3>
      <p>
        Connect an account, choose and save tools below, then enable access for {name}.
        Connected tools pause if the agent’s private chat is shared or it joins another conversation.
      </p>
      {state && <p>Saved tool permissions: <strong>{state.grantedToolCount}</strong></p>}
      {state && state.grantedToolCount === 0 && <p role="status">
        No tools are allowed yet. Choose tools below and click Save tool access.
      </p>}
      {state?.enabled && <>
        <p>Access enabled until {new Date(state.expiresAt!).toLocaleDateString()}.</p>
        {state.preloadConfigured ? <p>The connection guide will load for the next request.</p> :
          <p role="status">Renew skill access to load the connection guide for the next request.</p>}
      </>}
      {error && <p role="alert">{error}</p>}
      {!available && (
        <p>Ask your administrator to configure connection skill access.</p>
      )}
      <div className="connection-skill-actions">
        <button
          className="dashboard-action"
          disabled={busy || !state || !available || state.grantedToolCount === 0}
          onClick={() => void change(true)}
        >
          {busy
            ? "Updating…"
            : state?.enabled
              ? "Renew skill access"
              : "Enable skill access"}
        </button>
        {state?.enabled && (
          <button
            className="dashboard-action"
            disabled={busy}
            onClick={() => void change(false)}
          >
            Revoke skill access
          </button>
        )}
      </div>
    </article>
  );
}
