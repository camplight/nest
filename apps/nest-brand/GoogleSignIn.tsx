import { useEffect, useState } from "react";
import "./google-sign-in.css";
const messages: Record<string, string> = {
  google_state:
    "Your sign-in expired or was opened in another browser. Please try again.",
  google_cancelled: "Google sign-in was cancelled. You can try again.",
  google_domain: "Use your organization’s Google Workspace account to join.",
  google_account_conflict:
    "An account with this email already exists. Sign in with your existing credentials and contact the instance owner.",
  google_failed: "Google sign-in could not be verified. Please try again.",
};
export function GoogleSignIn({
  apiUrl,
  returnTo = "/",
  onStart,
}: {
  apiUrl: (path: string) => string;
  returnTo?: string;
  onStart?: () => void;
}) {
  const [config, setConfig] = useState<{
    enabled: boolean;
    allowedDomain: string;
  } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error] = useState(
    () =>
      messages[
        new URLSearchParams(window.location.search).get("authError") ?? ""
      ] ?? "",
  );
  useEffect(() => {
    const controller = new AbortController();
    setUnavailable(false);
    void fetch(apiUrl("/api/auth/google/config"), {
      credentials: "include",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    })
      .then((r) => {
        if (!r.ok) throw new Error("Sign-in availability check failed");
        return r.json();
      })
      .then((value) => {
        if (typeof value?.enabled !== "boolean" ||
            (value.enabled && typeof value.allowedDomain !== "string")) {
          throw new Error("Invalid sign-in configuration");
        }
        if (!controller.signal.aborted) setConfig(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUnavailable(true);
      });
    return () => controller.abort();
  }, [apiUrl, attempt]);
  return (
    <>
      {error && (
        <p className="google-sign-in-error" role="alert">
          {error}
        </p>
      )}
      {unavailable && (
        <div className="google-sign-in" role="status">
          <p>Google sign-in is temporarily unavailable.</p>
          <button type="button" className="google-sign-in-button" onClick={() => setAttempt(value => value + 1)}>
            Retry Google sign-in
          </button>
        </div>
      )}
      {!unavailable && config?.enabled && (
        <div className="google-sign-in">
          <a
            className="google-sign-in-button"
            onClick={onStart}
            href={apiUrl(
              `/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`,
            )}
          >
            Continue with Google
          </a>
          <p>
            Use your @{config.allowedDomain} account. Your workspace account is
            created when you first sign in.
          </p>
          <div className="google-sign-in-divider">or use your password</div>
        </div>
      )}
    </>
  );
}
