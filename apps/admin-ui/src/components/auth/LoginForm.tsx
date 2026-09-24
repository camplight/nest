import { useBranding } from "../../../../nest-brand/BrandingProvider";
import { useState, type FormEvent } from "react";
import { apiFetch } from "../../api";
import { Button, Input, Label } from "../ui";
import { PoweredByNest, InstanceBrand, ThemeToggle } from "../../../../nest-brand/Brand";

type LoginFormProps = { onSuccess: () => Promise<void> | void };

export function LoginForm({ onSuccess }: LoginFormProps) {
  const { branding } = useBranding();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);
    setPending(true);
    try {
      await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      await onSuccess();
    } catch {
      setStatus("Unable to sign in. Check your username and password and try again.");
    } finally { setPending(false); }
  };
  return (
    <main className="nest-admin-login">
      <section className="nest-login-story">
        <InstanceBrand />
        <div><p className="nest-eyebrow">{branding.displayName} administration</p><h1>A space for<br />great teamwork.</h1><p>Bring your people, agents, and operations together. Everything you need to keep your workspace running.</p></div>
        <PoweredByNest />
      </section>
      <form className="nest-login-form" onSubmit={handleLogin}>
        <div className="flex justify-end"><ThemeToggle /></div>
        <p className="text-sm text-slate-400">Welcome back</p>
        <h2>Sign in to {branding.displayName}</h2>
        <p className="text-sm text-slate-400">Manage your workspace with a clear view of what matters.</p>
        {status && <p role="alert" className="nest-login-error">{status}</p>}
        <div className="space-y-2"><Label htmlFor="nest-username">Username</Label><Input id="nest-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required /></div>
        <div className="space-y-2"><Label htmlFor="nest-password">Password</Label><Input id="nest-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></div>
        <Button type="submit" className="w-full" disabled={pending || !username.trim() || !password}>{pending ? "Signing in…" : "Sign in"}</Button>
      </form>
    </main>
  );
}
