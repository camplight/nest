import { PoweredByNest, InstanceBrand } from "../../../../nest-brand/Brand";
import { Icon } from "../ui/Icon";
import type { Screen } from "../../types";

type SidebarProps = {
  activeScreen: Screen;
  onScreenChange: (screen: Screen) => void;
  onScreenFocus?: (screen: Screen) => void;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
};

const NAV_ITEMS: { screen: Screen; label: string }[] = [
  { screen: "dashboard", label: "Dashboard" },
  { screen: "agents", label: "Agents" },
  { screen: "runners", label: "Runners" },
  { screen: "teams", label: "Teams" },
  { screen: "channels", label: "Channels" },
  { screen: "chat", label: "Chat" },
  { screen: "events", label: "Events Explorer" },
  { screen: "processes", label: "Processes" },
  { screen: "skills", label: "Skills" },
  { screen: "secrets", label: "Secrets" },
  { screen: "api-keys", label: "API keys" },
  { screen: "agent-invites", label: "Agent invites" },
  { screen: "humans", label: "Humans" },
  { screen: "branding", label: "Branding" },
  { screen: "profile", label: "Profile" }
];

export function Sidebar({
  activeScreen,
  onScreenChange,
  onScreenFocus,
  mobileOpen = false,
  onCloseMobile
}: SidebarProps) {
  const handleClick = (screen: Screen) => {
    onScreenChange(screen);
    onScreenFocus?.(screen);
    onCloseMobile?.();
  };

  return (
    <aside
      className={`nest-sidebar fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] md:max-w-none transform border-r border-slate-800 bg-slate-950 p-3 md:p-4 space-y-3 transition-transform duration-200 md:static md:min-h-dvh md:w-56 md:translate-x-0 ${
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <InstanceBrand subtitle="Administration" />
        <button
          type="button"
          className="rounded bg-slate-800 hover:bg-slate-700 text-slate-200 px-2 py-1 text-xs md:hidden"
          onClick={onCloseMobile}
        >
          Close
        </button>
      </div>
      <nav aria-label="Administration" className="flex flex-col gap-2 overflow-y-auto max-h-[calc(100dvh-5rem)]">
        {NAV_ITEMS.map(({ screen, label }) => (
          <button
            key={screen}
            type="button"
            className={activeScreen === screen ? "nest-nav-item is-active" : "nest-nav-item"}
            aria-current={activeScreen === screen ? "page" : undefined}
            onClick={() => handleClick(screen)}
          >
            <Icon name={screen} />{label}
          </button>
        ))}
      </nav>
      <div className="instance-sidebar-footer"><PoweredByNest /></div>
    </aside>
  );
}
