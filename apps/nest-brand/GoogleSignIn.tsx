import { useEffect, useState } from "react";
import "./google-sign-in.css";

// Reuse the Google mark geometry from user-ui/public/model-logos/google.svg.
function GoogleMark() {
  return (
    <svg className="google-sign-in-mark" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#4285f4" d="M23 12.245c0-.905-.075-1.565-.236-2.25h-10.54v4.083h6.186c-.124 1.014-.797 2.542-2.294 3.569l-.021.136 3.332 2.53.23.022C21.779 18.417 23 15.593 23 12.245z" />
      <path fill="#34a853" d="M12.225 23c3.03 0 5.574-.978 7.433-2.665l-3.542-2.688c-.948.648-2.22 1.1-3.891 1.1a6.745 6.745 0 01-6.386-4.572l-.132.011-3.465 2.628-.045.124C4.043 20.531 7.835 23 12.225 23z" />
      <path fill="#fbbc05" d="M5.84 14.175A6.65 6.65 0 015.463 12c0-.758.138-1.491.361-2.175l-.006-.147-3.508-2.67-.115.054A10.831 10.831 0 001 12c0 1.772.436 3.447 1.197 4.938l3.642-2.763z" />
      <path fill="#ea4335" d="M12.225 5.253c2.108 0 3.529.892 4.34 1.638l3.167-3.031C17.787 2.088 15.255 1 12.225 1 7.834 1 4.043 3.469 2.197 7.062l3.63 2.763a6.77 6.77 0 016.398-4.572z" />
    </svg>
  );
}

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
            <GoogleMark />
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
            <GoogleMark />
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
