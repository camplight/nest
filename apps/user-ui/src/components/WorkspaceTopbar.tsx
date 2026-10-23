import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { ThemeToggle } from "../../../nest-brand/Brand";
import { apiJson } from "../api";
import { MentionInbox } from "./MentionInbox";
import "./workspace-topbar.css";

type WorkspaceActions = {
  onTour?: () => void;
  tourNew?: boolean;
  username: string;
  onAgents: () => void;
  onSignOut: () => void;
  onMention: (channelId: string, eventId: string) => void;
  channelLabel?: (channelId: string, fallback: string) => string;
};
const WorkspaceContext = createContext<WorkspaceActions | null>(null);
export function WorkspaceHeaderProvider({
  children,
  ...actions
}: WorkspaceActions & { children: ReactNode }) {
  return (
    <WorkspaceContext.Provider value={actions}>
      {children}
    </WorkspaceContext.Provider>
  );
}
const asset = (name: string) =>
  `${import.meta.env.BASE_URL}design/dashboard/${name}.svg`;
function Icon({ name }: { name: string }) {
  return <img src={asset(name)} alt="" aria-hidden="true" />;
}

export function WorkspaceTopbar({
  onMenu,
  search,
  leading,
}: {
  onMenu: () => void;
  search?: ReactNode;
  leading?: ReactNode;
}) {
  return (
    <header className="dashboard-topbar workspace-topbar">
      <div className="workspace-topbar-leading">
        <button className="sidebar-mobile-toggle" onClick={onMenu}>
          Menu
        </button>
        {leading}
      </div>
      <div className="workspace-topbar-search">{search}</div>
      <WorkspaceControls />
    </header>
  );
}
function WorkspaceControls() {
  const actions = useContext(WorkspaceContext);
  const [accountOpen, setAccountOpen] = useState(false),
    [settingsOpen, setSettingsOpen] = useState(false);
  const account = useRef<HTMLDivElement>(null),
    accountTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!accountOpen) return;
    account.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!account.current?.contains(event.target as Node))
        setAccountOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [accountOpen]);
  if (!actions) return null;
  function menuKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setAccountOpen(false);
      accountTrigger.current?.focus();
      return;
    }
    const items = [
      ...account.current!.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % items.length
        : event.key === "ArrowUp"
          ? (index - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      items[next]?.focus();
    }
  }
  function settings() {
    setAccountOpen(false);
    setSettingsOpen(true);
  }
  return (
    <div
      className="workspace-controls"
      role="group"
      aria-label="Workspace controls"
    >
      {actions.onTour&&<button className="quick-tour-trigger" onClick={actions.onTour} aria-label="Quick tour">{actions.tourNew?"Start here · 3 steps":"Quick tour"}</button>}
      <ThemeToggle iconSrc={asset("theme")} className="workspace-control" />
      <MentionInbox
        icon={<Icon name="notifications" />}
        onOpen={actions.onMention}
        channelLabel={actions.channelLabel}
      />
      <button
        className="workspace-control"
        aria-label="Workspace settings"
        title="Workspace settings"
        onClick={settings}
      >
        <Icon name="settings" />
      </button>
      <div
        className="workspace-account"
        ref={account}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setAccountOpen(false);
        }}
      >
        <button
          className="workspace-control"
          ref={accountTrigger}
          aria-label="Account"
          title={`Account: ${actions.username}`}
          aria-haspopup="menu"
          aria-expanded={accountOpen}
          onClick={() => setAccountOpen(!accountOpen)}
        >
          <Icon name="account" />
        </button>
        {accountOpen && (
          <div
            className="workspace-account-menu"
            role="menu"
            aria-label="Account menu"
            onKeyDown={menuKey}
          >
            <p role="presentation">
              Signed in as<strong>{actions.username}</strong>
            </p>
            <button
              role="menuitem"
              onClick={() => {
                setAccountOpen(false);
                actions.onAgents();
              }}
            >
              Your agents
            </button>
            <button role="menuitem" onClick={settings}>
              Workspace settings
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setAccountOpen(false);
                actions.onSignOut();
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </div>
      {settingsOpen && (
        <WorkspaceSettings
          onClose={() => setSettingsOpen(false)}
          onAgents={() => {
            setSettingsOpen(false);
            actions.onAgents();
          }}
        />
      )}
    </div>
  );
}
function WorkspaceSettings({
  onClose,
  onAgents,
}: {
  onClose: () => void;
  onAgents: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [access, setAccess] = useState<boolean | null>(null),
    [error, setError] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  function close() {
    dialog.current?.close();
    onClose();
  }
  useEffect(() => {
    const controller = new AbortController();
    setAccess(null);
    setError(false);
    void apiJson<{ canManage: boolean }>("/api/branding/access", {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setAccess(result.canManage === true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [attempt]);
  return (
    <dialog
      className="workspace-settings"
      ref={dialog}
      aria-label="Workspace settings"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={onClose}
    >
      <header>
        <h2>Workspace settings</h2>
        <button aria-label="Close workspace settings" onClick={close}>
          ×
        </button>
      </header>
      <div className="workspace-settings-body">
        <section>
          <h3>Appearance</h3>
          <p>Choose a theme for this browser.</p>
          <ThemeToggle />
        </section>
        <section>
          <h3>Agents and connections</h3>
          <p>Configure your agents, models, skills and connected apps.</p>
          <button
            className="dashboard-action"
            onClick={() => {
              dialog.current?.close();
              onAgents();
            }}
          >
            Manage your agents →
          </button>
        </section>
        <section>
          <h3>Administration</h3>
          {error ? (
            <p role="alert">
              Could not check administrator access.{" "}
              <button onClick={() => setAttempt((value) => value + 1)}>
                Retry access check
              </button>
            </p>
          ) : access === null ? (
            <p role="status">Checking administrator access…</p>
          ) : access ? (
            <>
              <p>Manage instance branding, sign-in and runtime settings.</p>
              <a className="dashboard-action" href="/admin/">
                Open administration →
              </a>
            </>
          ) : (
            <p>Instance settings are managed by your administrator.</p>
          )}
        </section>
      </div>
    </dialog>
  );
}
