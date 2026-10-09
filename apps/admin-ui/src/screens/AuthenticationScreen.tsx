import { useEffect, useState, type FormEvent } from "react";
import { apiFetch, apiJson } from "../api";
import "./authentication.css";
type Settings = {
  enabled: boolean;
  allowedDomain: string;
  teamName: string;
  configured: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  redirectUri: string;
};
export function AuthenticationScreen() {
  const [settings, setSettings] = useState<Settings | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const load = () =>
    apiJson<Settings>("/api/auth/google/settings")
      .then(setSettings)
      .catch(() =>
        setError(
          "Only the instance owner can manage sign-in. If you are the owner, check the API connection and try again.",
        ),
      );
  useEffect(() => {
    void load();
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await apiFetch("/api/auth/google/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: settings.enabled,
          allowedDomain: settings.allowedDomain,
          teamName: settings.teamName,
        }),
      });
      setNotice(
        "Sign-in settings saved. Existing Google sessions must sign in again.",
      );
      await load();
    } catch {
      setError(
        "Could not save. Check the domain, team name and server credentials.",
      );
    } finally {
      setBusy(false);
    }
  }
  const callback =
    settings?.redirectUri ||
    `${window.location.origin}/api/auth/google/callback`;
  return (
    <section className="branding-settings">
      <div className="branding-intro">
        <p className="branding-kicker">Your team’s access</p>
        <h2>Google Workspace sign-in</h2>
        <p>
          Let colleagues join with their work account. Nest creates their
          account and adds them to your chosen team on first sign-in.
        </p>
      </div>
      {error && (
        <p role="alert" className="branding-error">
          {error}
        </p>
      )}
      {!settings && !error && <p role="status">Loading sign-in settings…</p>}
      {settings && (
        <div className="branding-columns">
          <form
            className="branding-form"
            onSubmit={(event) => void save(event)}
          >
            <fieldset disabled={busy}>
              <legend>Workspace access</legend>
              <label>
                Allowed Workspace domain
                <input
                  required
                  placeholder="camplight.net"
                  value={settings.allowedDomain}
                  onChange={(e) =>
                    setSettings({ ...settings, allowedDomain: e.target.value })
                  }
                />
              </label>
              <label>
                Default team
                <input
                  required
                  maxLength={100}
                  placeholder="Camplight"
                  value={settings.teamName}
                  onChange={(e) =>
                    setSettings({ ...settings, teamName: e.target.value })
                  }
                />
              </label>
              <label style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <input
                  style={{ width: "auto" }}
                  type="checkbox"
                  checked={settings.enabled}
                  disabled={!settings.configured && !settings.enabled}
                  onChange={(e) =>
                    setSettings({ ...settings, enabled: e.target.checked })
                  }
                />
                Enable Google sign-in
              </label>
              <p className="branding-hint">
                Only verified members of this Workspace domain can join.
                Existing accounts are not linked automatically. Password sign-in
                remains available for existing local accounts.
              </p>
              <button className="branding-save" type="submit">
                {busy ? "Saving…" : "Save sign-in settings"}
              </button>
            </fieldset>
            {notice && (
              <p role="status" className="branding-notice">
                {notice}
              </p>
            )}
          </form>
          <div className="branding-form authentication-help">
            <h3>
              {settings.configured
                ? "Google connection ready"
                : "Connect Google first"}
            </h3>
            <p>
              Create a web OAuth client in your organization’s Google Cloud
              project. Choose an internal audience and register this exact
              callback:
            </p>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {callback}
            </pre>
            <p>Store these settings in the server environment, then restart:</p>
            <ul>
              <li>
                NEST_GOOGLE_CLIENT_ID:{" "}
                {settings.clientIdConfigured ? "configured" : "missing"}
              </li>
              <li>
                NEST_GOOGLE_CLIENT_SECRET:{" "}
                {settings.clientSecretConfigured ? "configured" : "missing"}
              </li>
              <li>
                NEST_GOOGLE_REDIRECT_URI:{" "}
                {settings.redirectUri ? "configured" : "missing"}
              </li>
            </ul>
            <p>Secrets are never displayed or entered in this form.</p>
            <h3>Invite the team</h3>
            <p>
              Once enabled, share the workspace link through your company’s
              existing mailing list. Everyone signs in individually; no
              temporary passwords are needed.
            </p>
            <p>
              Google sessions last up to eight hours. Directory synchronization
              and automatic account suspension are not enabled.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
