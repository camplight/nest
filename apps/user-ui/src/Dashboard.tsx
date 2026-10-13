import type {
  CommunityCatalog,
  CommunitySkill,
  DashboardTask,
  Project,
  ProjectDashboard,
  ProjectOverview,
} from "@nest/schemas";
import { useEffect, useState, type ReactNode } from "react";
import { apiJson } from "./api";
import { AgentAvatar } from "./components/AgentAvatar";
import { ScrollableCardStack } from "./components/smooth-ui/ScrollableCardStack";
import type { Channel } from "./types";
import { WorkspaceTopbar } from "./components/WorkspaceTopbar";
import "./dashboard.css";

export function DesignIcon({ name }: { name: string }) {
  return (
    <img
      className="design-icon"
      src={`${import.meta.env.BASE_URL}design/${name}.svg`}
      alt=""
      aria-hidden="true"
    />
  );
}

type Props = {
  channels: Channel[];
  projects: Project[];
  unreadCounts: Record<string, number>;
  loading: boolean;
  error: string | null;
  label: (channel: Channel) => string;
  onSelect: (id: string) => void;
  onProject: (id: string | null, task?: string | null, tab?: string) => void;
  onCommunity: (name: string | null) => void;
  onCreate: () => void;
  onMenu: () => void;
  onRetry: () => void;
};
function SectionTitle({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="dashboard-section-title">
      <h2>
        {title}
        {count !== undefined && (
          <span className="dashboard-count">{count}</span>
        )}
      </h2>
      {action}
    </div>
  );
}
function EmptyCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="dashboard-card dashboard-empty">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function UnavailableMetric({
  title,
  periods,
  reason,
}: {
  title: string;
  periods: string[];
  reason: string;
}) {
  return (
    <article className="dashboard-card dashboard-stat">
      <h2>{title}</h2>
      <div
        className="dashboard-segments"
        aria-label={`${title} filters unavailable`}
      >
        {periods.map((period, i) => (
          <button key={period} disabled data-selected={i === 0} title={reason}>
            {period}
          </button>
        ))}
      </div>
      <div className="dashboard-stat-bottom">
        <p className="dashboard-stat-note">Not available</p>
        <span
          className="dashboard-stat-value"
          aria-label={`${title} unavailable`}
        >
          —
        </span>
        <p className="dashboard-metric-caption">{reason}</p>
      </div>
    </article>
  );
}

export function Dashboard({
  projects,
  onProject,
  onCommunity,
  channels,
  unreadCounts,
  loading,
  error,
  label,
  onSelect,
  onCreate,
  onMenu,
  onRetry,
}: Props) {
  const [query, setQuery] = useState("");
  const [taskFilter, setTaskFilter] = useState<"finished" | "review">(
    "finished",
  );
  const [overview, setOverview] = useState<ProjectDashboard | null>(null);
  const [catalog, setCatalog] = useState<CommunityCatalog | null>(null);
  const [summaryError, setSummaryError] = useState(false);
  const [communityError, setCommunityError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [showAllNext, setShowAllNext] = useState(false);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setSummaryError(false);
    setCommunityError(false);
    void Promise.allSettled([
      apiJson<ProjectDashboard>("/api/projects/dashboard", {
        signal: controller.signal,
      })
        .then((value) => {
          if (!controller.signal.aborted) setOverview(value);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setOverview(null);
            setSummaryError(true);
          }
        }),
      apiJson<CommunityCatalog>("/api/community/skills?limit=8", {
        signal: controller.signal,
      })
        .then((value) => {
          if (!controller.signal.aborted) setCatalog(value);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setCatalog(null);
            setCommunityError(true);
          }
        }),
    ]).finally(() => {
      if (!controller.signal.aborted) setBusy(false);
    });
    return () => controller.abort();
  }, [refresh]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (value: string) =>
    value.toLocaleLowerCase().includes(normalizedQuery);
  const active = (overview?.projects ?? []).filter(
    (p) => p.totalTasks === 0 || p.finishedTasks < p.totalTasks,
  );
  const filteredProjects = active.filter((p) =>
    matches(`${p.project.name} ${p.project.description}`),
  );
  const projectName = (id: string) =>
    overview?.projects.find((p) => p.project.id === id)?.project.name ??
    "Project";
  const reviews = (overview?.reviews ?? []).filter((task) =>
    matches(`${task.title} ${task.agentName} ${projectName(task.projectId)}`),
  );
  const unread = channels.filter(
    (channel) =>
      !channel.archivedAt &&
      (unreadCounts[channel.id] ?? 0) > 0 &&
      matches(label(channel)),
  );
  const changes = (overview?.changes ?? []).filter((task) =>
    matches(`${task.title} ${task.agentName} ${projectName(task.projectId)}`),
  );
  const matchedSkills = (catalog?.skills ?? []).filter((skill) =>
    matches(`${skill.title} ${skill.description} ${skill.tags.join(" ")}`),
  );
  const skills = matchedSkills;
  const next = [
    ...reviews.map((task) => ({ id: `review:${task.id}`, task })),
    ...unread.map((channel) => ({ id: `chat:${channel.id}`, channel })),
  ];
  const pending = busy || loading;
  function reload() {
    setRefresh((value) => value + 1);
    onRetry();
  }
  function openTask(task: DashboardTask) {
    onProject(task.projectId, task.id, "tasks");
  }

  function renderProject(item: ProjectOverview & { id: string }) {
    const percent = item.totalTasks
      ? Math.round((item.finishedTasks / item.totalTasks) * 100)
      : null;
    const state = item.changesRequested
      ? "Needs changes"
      : item.needsReview
        ? "Needs review"
        : item.workingTasks
          ? "In progress"
          : "Ready to start";
    return (
      <button
        className="dashboard-card dashboard-project-card"
        onClick={() => onProject(item.project.id)}
      >
        <span className="dashboard-project-heading">
          <DesignIcon name="dashboard/progress" />
          <strong>#{item.project.name}</strong>
          <DesignIcon name="dashboard/arrow-right" />
        </span>
        <span className="dashboard-project-meta">
          <span
            className={`dashboard-pill ${item.changesRequested ? "dashboard-pill-warning" : ""}`}
          >
            {state}
          </span>
          <span>{percent === null ? "No tasks yet" : `${percent}% done`}</span>
          <span>
            {item.assignedAgents}{" "}
            {item.assignedAgents === 1 ? "agent" : "agents"}
          </span>
          <span>
            {item.finishedTasks}/{item.totalTasks} tasks
          </span>
        </span>
      </button>
    );
  }
  function renderNext(item: (typeof next)[number]) {
    if ("task" in item && item.task)
      return (
        <article className="dashboard-card dashboard-next-card">
          <div>
            <p>
              Review <strong>{item.task.agentName}’s</strong> deliverable for{" "}
              <strong>#{projectName(item.task.projectId)}</strong>
            </p>
            <small>{item.task.title}</small>
          </div>
          <footer>
            <span className="dashboard-pill">Needs review</span>
            <button onClick={() => openTask(item.task!)}>Review →</button>
          </footer>
        </article>
      );
    const channel = "channel" in item ? item.channel : undefined;
    if (!channel) return null;
    return (
      <article className="dashboard-card dashboard-next-card">
        <div>
          <p>
            Catch up in <strong>{label(channel)}</strong>
          </p>
          <small>
            {unreadCounts[channel.id]} unread{" "}
            {unreadCounts[channel.id] === 1 ? "message" : "messages"} since you
            opened Nest
          </small>
        </div>
        <footer>
          <span className="dashboard-pill">New messages</span>
          <button onClick={() => onSelect(channel.id)}>Open chat →</button>
        </footer>
      </article>
    );
  }
  function renderSkill(skill: CommunitySkill, i: number) {
    const cover =
      skill.category === "automation"
        ? "automation"
        : skill.category === "use-case"
          ? "use-case"
          : "skill";
    return (
      <button
        className={`dashboard-community-card ${i === 0 ? "is-featured" : ""}`}
        key={skill.name}
        onClick={() => onCommunity(skill.name)}
      >
        <span className={`dashboard-community-art is-${cover}`}>
          {cover === "skill" && (
            <img
              className="dashboard-community-background"
              src={`${import.meta.env.BASE_URL}design/dashboard/skill-background.png`}
              alt=""
              aria-hidden="true"
            />
          )}
          <img
            src={`${import.meta.env.BASE_URL}design/dashboard/${cover}.png`}
            alt=""
            aria-hidden="true"
          />
          <span>Skill</span>
          <small>v{skill.version}</small>
        </span>
        <span className="dashboard-community-info">
          <strong>{skill.title}</strong>
          <span>{skill.description}</span>
          <span className="dashboard-community-author">
            {skill.author.kind === "agent" ? (
              <AgentAvatar name={skill.author.name} size={36} />
            ) : (
              <span className="dashboard-author-initials" aria-hidden="true">
                {skill.author.name.slice(0, 2)}
              </span>
            )}
            <span>
              {skill.author.name}
              <small>{new Date(skill.updatedAt).toLocaleDateString()}</small>
            </span>
            <span className="dashboard-community-arrow" aria-hidden="true">
              →
            </span>
          </span>
        </span>
      </button>
    );
  }

  return (
    <section className="dashboard" aria-label="Dashboard">
      <WorkspaceTopbar
        onMenu={onMenu}
        search={
          <label className="dashboard-search">
            <DesignIcon name="search" />
            <input
              aria-label="Search dashboard"
              placeholder="Search…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        }
      />
      <div className="dashboard-content" aria-busy={pending}>
        <div className="dashboard-title">
          <h1>Dashboard</h1>
          <button
            className="dashboard-action"
            onClick={reload}
            disabled={pending}
          >
            ↻ Refresh
          </button>
        </div>
        {error && (
          <div className="notice error" role="alert">
            {error} <button onClick={reload}>Try again</button>
          </div>
        )}
        {summaryError && (
          <div className="notice error" role="alert">
            Project metrics are unavailable.{" "}
            <button onClick={reload}>Retry project metrics</button>
          </div>
        )}
        {pending && (
          <p className="dashboard-loading" role="status">
            Loading your workspace…
          </p>
        )}
        <div className="dashboard-stats">
          <UnavailableMetric
            title="Spend"
            periods={["Daily", "Weekly", "Monthly"]}
            reason="Provider costs are not tracked yet."
          />
          <article className="dashboard-card dashboard-stat">
            <h2>Tasks</h2>
            <div className="dashboard-segments" aria-label="Task filter">
              <button
                aria-pressed={taskFilter === "finished"}
                onClick={() => setTaskFilter("finished")}
              >
                Finished
              </button>
              <button
                aria-pressed={taskFilter === "review"}
                onClick={() => setTaskFilter("review")}
              >
                Need review
              </button>
            </div>
            <div className="dashboard-stat-bottom">
              <p className="dashboard-stat-note">
                {taskFilter === "finished"
                  ? "Approved by a person"
                  : "Waiting for your decision"}
              </p>
              <span
                className="dashboard-stat-value"
                aria-label={
                  taskFilter === "finished"
                    ? "Finished tasks"
                    : "Tasks needing review"
                }
              >
                {!overview || pending || error
                  ? "—"
                  : taskFilter === "finished"
                    ? overview.tasks.finished
                    : overview.tasks.needsReview}
              </span>
              <p className="dashboard-metric-caption">
                Across your accessible projects
              </p>
            </div>
          </article>
          <UnavailableMetric
            title="Issues"
            periods={["Finished", "Need review"]}
            reason="Operational issue tracking is not connected."
          />
        </div>
        <div className="dashboard-columns">
          <section aria-label="Active projects">
            <SectionTitle
              title="Active projects"
              count={overview ? filteredProjects.length : undefined}
              action={
                <button onClick={() => onProject(null)}>All projects</button>
              }
            />
            <ScrollableCardStack
              items={filteredProjects.map((p) => ({ ...p, id: p.project.id }))}
              label="Active projects"
              renderItem={renderProject}
            />
            {!pending && !summaryError && !filteredProjects.length && (
              <EmptyCard
                title={
                  query
                    ? "No matching projects"
                    : projects.length
                      ? "No active projects"
                      : "Your first project starts here"
                }
              >
                {query ? (
                  "Try a different search."
                ) : projects.length ? (
                  "Your completed projects are available in All projects."
                ) : (
                  <>
                    Keep chat, tasks and files together.{" "}
                    <button onClick={onCreate}>Create a project →</button>
                  </>
                )}
              </EmptyCard>
            )}
          </section>
          <section aria-label="Up next">
            <SectionTitle
              title="Up next"
              count={overview && !pending && !error ? next.length : undefined}
              action={
                next.length > 1 && (
                  <button
                    aria-expanded={showAllNext}
                    onClick={() => setShowAllNext(!showAllNext)}
                  >
                    {showAllNext ? "Show stack" : "All"}
                  </button>
                )
              }
            />
            {showAllNext ? (
              <div className="dashboard-list">
                {next.map((item) => (
                  <div key={item.id}>{renderNext(item)}</div>
                ))}
              </div>
            ) : (
              <ScrollableCardStack
                items={next}
                label="Up next"
                renderItem={renderNext}
              />
            )}
            {!pending && !error && !summaryError && !next.length && (
              <EmptyCard
                title={query ? "No matching activity" : "You’re all caught up"}
              >
                {query
                  ? "Try a different search."
                  : "Deliverables awaiting your review and new chat messages appear here."}
              </EmptyCard>
            )}
          </section>
          <section aria-label="Urgent issues">
            <SectionTitle title="Urgent issues" />
            <EmptyCard title="Issue tracking is not connected">
              Operational alerts will appear here when Nest has an issue source.
            </EmptyCard>
          </section>
          {changes.length > 0 && (
            <section aria-label="Changes requested">
              <SectionTitle title="Changes requested" count={changes.length} />
              <ScrollableCardStack
                items={changes}
                label="Changes requested"
                renderItem={(task) => (
                  <article className="dashboard-card dashboard-next-card">
                    <div>
                      <p>
                        <strong>{task.title}</strong>
                      </p>
                      <small>
                        #{projectName(task.projectId)} · {task.agentName}
                      </small>
                    </div>
                    <footer>
                      <span className="dashboard-pill dashboard-pill-warning">
                        Needs changes
                      </span>
                      <button onClick={() => openTask(task)}>
                        Open task →
                      </button>
                    </footer>
                  </article>
                )}
              />
            </section>
          )}
        </div>
        <section className="dashboard-community" aria-label="Community">
          <SectionTitle
            title="Community"
            count={catalog?.total}
            action={
              <button onClick={() => onCommunity(null)}>Browse all</button>
            }
          />
          {communityError ? (
            <EmptyCard title="Community is unavailable">
              <button onClick={reload}>Retry community</button>
            </EmptyCard>
          ) : (
            <div className="dashboard-community-strip">
              {skills.map(renderSkill)}
              {!pending && !skills.length && (
                <div className="dashboard-community-card is-featured dashboard-community-welcome">
                  <span className="dashboard-community-art is-automation">
                    <img
                      src={`${import.meta.env.BASE_URL}design/dashboard/automation.png`}
                      alt=""
                      aria-hidden="true"
                    />
                    <span>Community</span>
                    <small>Your tenant’s private library</small>
                  </span>
                  <div className="dashboard-community-info">
                    <h3>{query ? "No matching skills" : "Share what works"}</h3>
                    <span>
                      {query
                        ? "Search matches the latest eight packages. Browse all for the complete catalog."
                        : "Turn your team’s know-how into skills people and agents can reuse."}
                    </span>
                    <button onClick={() => onCommunity(null)}>
                      Explore community →
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {catalog && catalog.total > catalog.skills.length && (
            <p className="dashboard-metric-caption">
              Latest {catalog.skills.length} packages · Browse all to search the
              full catalog
            </p>
          )}
        </section>
      </div>
    </section>
  );
}
