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
}: {
  apiUrl: (path: string) => string;
  returnTo?: string;
}) {
  const [config, setConfig] = useState<{
    enabled: boolean;
    allowedDomain: string;
  } | null>(null);
  const [error] = useState(
    () =>
      messages[
        new URLSearchParams(window.location.search).get("authError") ?? ""
      ] ?? "",
  );
  useEffect(() => {
    const controller = new AbortController();
    void fetch(apiUrl("/api/auth/google/config"), {
      credentials: "include",
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((value) => {
        if (!controller.signal.aborted) setConfig(value);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [apiUrl]);
  return (
    <>
      {error && (
        <p className="google-sign-in-error" role="alert">
          {error}
        </p>
      )}
      {config?.enabled && (
        <div className="google-sign-in">
          <a
            className="google-sign-in-button"
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
