import type { Project } from "@nest/schemas";
import { useState } from "react";
import { AgentAvatar } from "./components/AgentAvatar";
import { ScrollableCardStack } from "./components/smooth-ui/ScrollableCardStack";
import type { Agent, Channel, Team } from "./types";
import "./dashboard.css";

export function DesignIcon({ name }: { name: string }) {
  return <img className="design-icon" src={`${import.meta.env.BASE_URL}design/${name}.svg`} alt="" aria-hidden="true" />;
}

type Props = {
  channels: Channel[];
  projects: Project[];
  onProject: (id: string | null) => void;
  agents: Agent[];
  teams: Team[];
  unreadCounts: Record<string, number>;
  loading: boolean;
  error: string | null;
  label: (channel: Channel) => string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onMenu: () => void;
  onRetry: () => void;
  onAgent: (name: string) => void;
};

export function Dashboard({ projects, onProject, channels, agents, teams, unreadCounts, loading, error, label, onSelect, onCreate, onMenu, onRetry, onAgent }: Props) {
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<"all" | "running">("all");
  const [conversationFilter, setConversationFilter] = useState<"active" | "archived">("active");
  const [showAll, setShowAll] = useState(false);
  const running = agents.filter(agent => agent.runtimeState === "RUNNING");
  const chats = channels.filter(channel => !projects.some(project => project.channelId === channel.id));
  const active = chats.filter(channel => !channel.archivedAt);
  const unread = channels.filter(channel => !channel.archivedAt && (unreadCounts[channel.id] ?? 0) > 0);
  const totalUnread = unread.reduce((total, channel) => total + unreadCounts[channel.id], 0);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(normalizedQuery);
  const filteredChannels = chats.filter(channel => Boolean(channel.archivedAt) === (conversationFilter === "archived") && matches(`${label(channel)} ${channel.description ?? ""}`));
  const filteredAgents = (agentFilter === "running" ? running : agents).filter(agent => matches(`${agent.name} ${agent.description ?? ""}`));

  function renderConversation(channel: Channel) {
    return <button className="dashboard-card dashboard-conversation" key={channel.id} onClick={() => onSelect(channel.id)}>
              <span className="dashboard-conversation-title"><strong>{label(channel)}</strong><span aria-hidden="true">→</span></span>
              <span className="dashboard-conversation-meta"><span className="dashboard-pill">{channel.archivedAt ? "Archived" : channel.visibility === "PRIVATE" ? "Private" : "Public"}</span><span>{(channel.participants ?? []).filter(p => p.subscriberType.toUpperCase() === "AGENT").length} agents</span><span>{unreadCounts[channel.id] ? `${unreadCounts[channel.id]} unread` : "Caught up"}</span></span>
            </button>;
  }

  function renderUnread(channel: Channel) {
    return <button className="dashboard-card dashboard-unread" key={channel.id} onClick={() => onSelect(channel.id)}><span className="dashboard-unread-dot" /><span><strong>{label(channel)}</strong><small>{unreadCounts[channel.id]} unread {unreadCounts[channel.id] === 1 ? "message" : "messages"}</small></span><span aria-hidden="true">→</span></button>;
  }

  function section(id: string) {
    document.getElementById(id)?.focus();
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  return <section className="dashboard" aria-label="Dashboard">
    <header className="dashboard-topbar">
      <button type="button" className="sidebar-mobile-toggle" onClick={onMenu}>Menu</button>
      <label className="dashboard-search">
        <DesignIcon name="search" />
        <input aria-label="Search dashboard" placeholder="Search…" value={query} onChange={event => { setQuery(event.target.value); setShowAll(true); }} />
      </label>
      <span className="dashboard-topbar-caption">Your workspace, at a glance</span>
    </header>
    <div className="dashboard-content" aria-busy={loading}>
      <div className="dashboard-title"><h1>Dashboard</h1><button className="dashboard-action" onClick={()=>onProject(null)}>Projects <span aria-hidden="true">+</span></button></div>
      {error && <div className="notice error" role="alert">{error} <button onClick={onRetry}>Try again</button></div>}
      {loading && <p className="dashboard-loading" role="status">Loading your workspace…</p>}
      <div className="dashboard-stats">
        <article className="dashboard-card dashboard-stat">
          <h2>Agents</h2>
          <div className="dashboard-segments" aria-label="Agent filter"><button aria-pressed={agentFilter === "all"} onClick={() => setAgentFilter("all")}>All agents</button><button aria-pressed={agentFilter === "running"} onClick={() => setAgentFilter("running")}>Running</button></div>
          <p className="dashboard-stat-note"><i className="dashboard-status-dot" />{running.length} running now</p>
          <button className="dashboard-stat-value" aria-label="View agents" onClick={() => section("dashboard-agents")}>{loading || error ? "—" : agentFilter === "all" ? agents.length : running.length}<span aria-hidden="true">↗</span></button>
        </article>
        <article className="dashboard-card dashboard-stat">
          <h2>Chats</h2>
          <div className="dashboard-segments" aria-label="Chat filter"><button aria-pressed={conversationFilter === "active"} onClick={() => setConversationFilter("active")}>Active</button><button aria-pressed={conversationFilter === "archived"} onClick={() => setConversationFilter("archived")}>Archived</button></div>
          <p className="dashboard-stat-note">Direct chats and conversations outside projects</p>
          <button className="dashboard-stat-value" aria-label="View chats" onClick={() => section("dashboard-chats")}>{loading || error ? "—" : conversationFilter === "active" ? active.length : chats.length - active.length}<span aria-hidden="true">↗</span></button>
        </article>
        <article className="dashboard-card dashboard-stat">
          <h2>Unread messages</h2>
          <p className="dashboard-stat-description">New messages since you opened Nest.</p>
          <p className="dashboard-stat-note">Across {unread.length} {unread.length === 1 ? "conversation" : "chats"}</p>
          <button className="dashboard-stat-value" aria-label="View unread chats" onClick={() => section("dashboard-up-next")}>{loading || error ? "—" : totalUnread}<span aria-hidden="true">↗</span></button>
        </article>
      </div>

      <section className="dashboard-projects" aria-label="Your projects"><div className="dashboard-section-title"><h2>Projects <span className="dashboard-count">{projects.length}</span></h2><button onClick={()=>onProject(null)}>All projects →</button></div><div className="project-grid">{projects.filter(project=>matches(`${project.name} ${project.description}`)).map(project=><button className="dashboard-card project-summary" key={project.id} onClick={()=>onProject(project.id)}><h3>{project.name}</h3><p>{project.description || 'Chat, tasks, files and members in one place.'}</p><span>{unreadCounts[project.channelId] ? `${unreadCounts[project.channelId]} unread · ` : ''}Open project →</span></button>)}</div>{!projects.length&&!loading&&<p>Create a project to keep your team’s work together. <button className="dashboard-action" onClick={()=>onProject(null)}>Create a project →</button></p>}</section>

      <div className="dashboard-columns">
        <section aria-labelledby="dashboard-chats">
          <div className="dashboard-section-title"><h2 id="dashboard-chats" tabIndex={-1}>{conversationFilter === "active" ? "Active chats" : "Archived chats"} <span className="dashboard-count">{filteredChannels.length}</span></h2><button onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>{showAll ? "Carousel" : "All"}</button></div>
          <div className="dashboard-list">
            {showAll ? filteredChannels.map(renderConversation) : <ScrollableCardStack
              items={filteredChannels} label="Chats" renderItem={renderConversation}
            />}
            {!loading && !error && !filteredChannels.length && <div className="dashboard-card dashboard-empty"><h3>{query ? "No chats found" : "Room for your next idea"}</h3><p>{query ? "Try a different name or description." : conversationFilter === "archived" ? "Archived chats will appear here." : "Start a conversation and bring your agents together."}</p>{!query && conversationFilter === "active" && <button onClick={onCreate}>Start a conversation →</button>}</div>}
          </div>
        </section>
        <section aria-labelledby="dashboard-up-next">
          <div className="dashboard-section-title"><h2 id="dashboard-up-next" tabIndex={-1}>Up next <span className="dashboard-count">{unread.length}</span></h2></div>
          <div className="dashboard-list">
            <ScrollableCardStack items={unread} label="Unread activity" renderItem={renderUnread} />
            {!loading && !error && !unread.length && <div className="dashboard-card dashboard-empty dashboard-caught-up"><span className="dashboard-check" aria-hidden="true">✓</span><h3>You’re all caught up</h3><p>New messages from your team will appear here.</p></div>}
          </div>
        </section>
      </div>

      <section aria-labelledby="dashboard-agents">
        <div className="dashboard-section-title"><h2 id="dashboard-agents" tabIndex={-1}>Your agents <span className="dashboard-count">{filteredAgents.length}</span></h2><span className="dashboard-section-caption">People and agents, working together</span></div>
        <div className="dashboard-agent-grid">
          {filteredAgents.map(agent => <article className="dashboard-card dashboard-agent" key={agent.name}><AgentAvatar name={agent.name} /><div><h3><button className="agent-name-link" onClick={() => onAgent(agent.name)}>{agent.name}</button></h3><p>{agent.description || "Ready for your next conversation."}</p><span className={`dashboard-agent-state ${agent.runtimeState === "RUNNING" ? "is-running" : ""}`}><i className="dashboard-status-dot" />{agent.runtimeState === "RUNNING" ? "Running" : agent.runtimeState ? agent.runtimeState.toLowerCase().replaceAll("_", " ") : "Status unavailable"}</span></div></article>)}
          {!loading && !error && !filteredAgents.length && <div className="dashboard-card dashboard-empty"><h3>{query ? "No matching agents" : agentFilter === "running" ? "No agents running" : "Your team starts here"}</h3><p>{query ? "Try a different search." : "Agents available to you will appear here."}</p></div>}
        </div>
      </section>
      {teams.length > 0 && <section aria-labelledby="dashboard-teams"><div className="dashboard-section-title"><h2 id="dashboard-teams">Your teams <span className="dashboard-count">{teams.length}</span></h2></div><div className="dashboard-team-list">{teams.map(team => <span className="dashboard-card" key={team.id}>{team.name}</span>)}</div></section>}
    </div>
  </section>;
}
