import type {
  ConnectionCapability,
  ConnectionSkillStatus,
  ConnectionProjectReview,
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
        conversations and projects you approve below. Google sign-in does not connect Drive or Gmail.
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
          <ConnectionProjects key={`projects-${name}`} name={name} />
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
        <details className="connection-access-help"><summary>How access works</summary><p>Connected apps work in any number of your unshared private chats and explicitly approved projects. Access pauses across all chats when the agent joins a shared or foreign-owned chat or an unapproved project or a project's participants change. Existing app and tool permissions still apply.</p></details>
      </div>
      {error && <p className="connection-access-notice" role="alert">{error}</p>}
      {!available && <p className="connection-access-notice">Ask your administrator to enable app connections.</p>}
    </article>
  );
}

function ConnectionProjects({name}: {name:string}) {
  const [projects, setProjects] = useState<ConnectionProjectReview[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const path = `/api/integrations/agents/${encodeURIComponent(name)}/projects`;
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    void apiJson<{projects:ConnectionProjectReview[]}>(path, {signal:abort.signal})
      .then(result => {if (!abort.signal.aborted) setProjects(result.projects);})
      .catch(() => {if (!abort.signal.aborted) setError("Could not load project access. Reload to try again.");});
    return () => abort.abort();
  }, [path, revision]);
  async function change(project:ConnectionProjectReview) {
    setBusy(true); setError("");
    try {
      await apiJson(`${path}/${encodeURIComponent(project.projectId)}`, {
        method:project.approved ? "DELETE" : "PUT",
        headers:{"content-type":"application/json"},
        body:project.approved ? undefined : JSON.stringify({audienceHash:project.audienceHash, acknowledgeSharedAccess:true}),
      });
      setRevision(v => v + 1);
    } catch {setError("Project access was not confirmed. Reload and review the current participants before retrying.");}
    finally {setBusy(false);}
  }
  return <article className="dashboard-card connection-project-access">
    <h3>Project access</h3>
    <p>Approve only participants you trust with this agent's connected apps. All listed people and agents can ask it to use its allowed tools and may see results. This applies to all apps and tools you grant this agent, including later grants.</p>
    <p>The agent can carry information between its chats. Removing approval blocks future tool calls while it remains in that project; it cannot erase information already shared or remembered.</p>
    {!projects.length && !error && <p>Add {name} to a team project you own to review its access here.</p>}
    {projects.map(project => <section key={project.projectId}>
      <h4>{project.name}</h4>
      <p>{project.participants.map(p => `${p.subscriberId} (${p.subscriberType === "AGENT" ? "agent" : "person"})`).join(", ")}</p>
      <p>{project.approved ? "Approved for these participants." : project.audienceHash ? "App access is paused until you approve these participants." : "This project must be private and have no shared viewers before approval."}</p>
      <button className="dashboard-action" disabled={busy || (!project.approved && !project.audienceHash)} onClick={() => void change(project)}>{project.approved ? "Remove project approval" : "Trust these participants with my apps"}</button>
    </section>)}
    {error && <p role="alert">{error}</p>}
    <button className="dashboard-action" disabled={busy} onClick={() => setRevision(v => v + 1)}>Reload project access</button>
  </article>;
}
