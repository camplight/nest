import { useEffect, useState } from "react";
import { apiJson } from "./api";
import { Connections } from "./Onboarding";

/** Optional engine capability: its loading/errors never block the settings form. */
export function AgentConnections({ name }: { name: string }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setAvailable(null);
    setFailed(false);
    void apiJson<{available:boolean}>("/api/onboarding/connections", {signal:controller.signal})
      .then(result => {if (!controller.signal.aborted) setAvailable(result.available);})
      .catch(() => {if (!controller.signal.aborted) setFailed(true);});
    return () => controller.abort();
  }, [attempt]);
  return <section className="onboarding agent-connections" aria-label="Connected apps">
    <h2>Connected apps</h2>
    <p>Choose which accounts and tools {name} can use in your private conversation. Google sign-in does not connect Drive or Gmail.</p>
    {failed ? <p role="alert">Could not load connection settings. <button className="dashboard-action" onClick={() => setAttempt(value => value + 1)}>Retry connections</button></p>
      : available === null ? <p role="status">Loading connection settings…</p>
      : available ? <Connections agentName={name}/>
      : <div className="dashboard-card onboarding-notice"><h3>App connections are being prepared</h3><p>Connections will appear here after your administrator finishes integration setup.</p></div>}
  </section>;
}
