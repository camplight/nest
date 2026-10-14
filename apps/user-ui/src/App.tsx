import {loadChatDraft,saveChatDraft,clearSentDraft,clearOwnerDrafts,rememberProject,recentProject,type ChatDraft} from './drafts';
import { prepareAssistantRequest, readAgentRequestLocation } from "./AgentRequests";
import {WorkspaceHeaderProvider, WorkspaceTopbar} from './components/WorkspaceTopbar';
import type {SelectedMention} from '@nest/schemas';
import { useMentionPicker } from "./components/useMentionPicker";
import { mentionCandidates, reconcileMentions } from "./mentions";
import type { OnboardingSummary } from "@nest/schemas";
import {apiUrl} from './config';
import {GoogleSignIn} from '../../nest-brand/GoogleSignIn';
import { Community } from "./Community";
import type { Project } from "@nest/schemas";
import { Projects } from "./Projects";
import { ProjectNavigation } from "./components/ProjectNavigation";
import { Agents } from "./Agents";
import { AgentAvatar, AgentAvatarChoices } from "./components/AgentAvatar";
import { Dashboard, DesignIcon } from "./Dashboard";
import { useBranding } from "../../nest-brand/BrandingProvider";
import { PoweredByNest, InstanceBrand, ThemeToggle } from "../../nest-brand/Brand";
import {
  FormEvent,
  type ChangeEvent,
  type ClipboardEvent,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState
} from "react";
import { apiFetch, apiJson, getApiHeaders } from "./api";
import { wsUrl } from "./config";
import type { Agent, AuthMe, Channel, ChannelParticipant, ChannelShare, EventRow, Team } from "./types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const MARKDOWN_HINT_RE =
  /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)|`{1,3}[^`]|(\*\*|__)[^*_]+(\*\*|__)|(\*|_)[^*_]+(\*|_)|\[[^\]]+\]\([^)]+\)|!\[[^\]]*\]\([^)]+\)|(^|\n)\|.+\|/m;
const URL_RE = /(https?:\/\/[^\s<]+)/i;

function formatTime(value?: number) {
  if (!value) return "";
  const date = new Date(value);
  const today = new Date();
  const isToday =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return new Intl.DateTimeFormat(undefined, {
    ...(isToday
      ? {}
      : {
          day: "numeric",
          month: "short",
          ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" })
        }),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function messageText(event: EventRow) {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  if (event.type === "agent.turn.failed") {
    const error = (payload as { error?: unknown }).error;
    return typeof error === "string" ? `Agent error: ${error}` : "Agent failed to respond.";
  }
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function shouldRenderMarkdown(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return MARKDOWN_HINT_RE.test(trimmed) || URL_RE.test(trimmed);
}

function sourceLabel(source: string) {
  if (source.startsWith("human:")) return source.slice("human:".length) || "Human";
  if (source.startsWith("agent:")) return source.slice("agent:".length) || "Agent";
  return source || "System";
}

function messageRole(source: string) {
  if (source.startsWith("human:")) return "human";
  if (source.startsWith("agent:")) return "agent";
  return "system";
}

function messageDisplayTime(event: EventRow) {
  return event.deliverAt ?? event.createdAt;
}

const DIRECT_CHANNEL_KINDS = new Set(["HUMAN_AGENT_DM", "AGENT_AGENT_DM", "DIRECT_GROUP"]);
const CHANNEL_GROUPS = [
  { id: "direct", label: "Direct messages" },
  { id: "channels", label: "Channels" },
  { id: "shared", label: "Shared channels" }
] as const;

type ChannelGroupId = (typeof CHANNEL_GROUPS)[number]["id"];

type UploadedAttachment = {
  localId: string;
  fileId: string;
  name: string;
  mime: string;
  size: number;
  sha256?: string;
};

type PendingAttachment = {
  localId: string;
  name: string;
  mime: string;
  size: number;
  status: "uploading" | "ready" | "error";
  uploaded?: UploadedAttachment;
  error?: string;
};

type MessageAttachment = {
  fileId: string;
  name: string;
  mime?: string;
  size?: number;
};

type WsServerEventMessage = {
  type: "event";
  topic: string;
  data: EventRow;
};

function normalizedSubscriberType(participant: ChannelParticipant) {
  return participant.subscriberType.trim().toUpperCase();
}

function isDirectChannel(channel?: Channel | null) {
  return Boolean(channel?.kind && DIRECT_CHANNEL_KINDS.has(channel.kind.toUpperCase()));
}

function isHumanAgentDirectChannel(channel?: Channel | null) {
  return channel?.kind?.toUpperCase() === "HUMAN_AGENT_DM";
}

function channelHasHumanParticipant(channel: Channel, humanId: string) {
  return (channel.participants ?? []).some(
    (participant) =>
      normalizedSubscriberType(participant) === "HUMAN" && participant.subscriberId === humanId
  );
}

function isLifecycleChannel(channel: Channel) {
  return channel.name.toLowerCase().startsWith("agent.lifecycle.");
}

function lifecycleAgentName(channel: Channel) {
  return channel.name.slice("agent.lifecycle.".length) || channel.name;
}

function channelGroupId(channel: Channel): ChannelGroupId {
  if (isDirectChannel(channel)) return "direct";
  return "channels";
}

function isTraceEvent(event: EventRow) {
  return (
    event.type === "agent.turn.started" ||
    event.type === "agent.turn.phase" ||
    event.type === "agent.turn.completed" ||
    event.type === "agent.turn.failed" ||
    event.type === "wrapper.turn.started" ||
    event.type === "wrapper.turn.completed" ||
    event.type === "wrapper.turn.failed" ||
    event.type === "process.started" ||
    event.type === "process.output" ||
    event.type === "process.exited" ||
    event.type === "tool.started" ||
    event.type === "tool.executed" ||
    event.type === "tool.failed" ||
    event.type === "telemetry.context.window.updated"
  );
}

function shortJson(value: unknown) {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function traceTitle(event: EventRow) {
  const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
  if (event.type.startsWith("process.")) {
    if (event.type === "process.started") return "Wrapped process started";
    if (event.type === "process.exited") {
      const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
      return exitCode === null ? "Wrapped process exited" : `Wrapped process exited (${exitCode})`;
    }
    if (event.type === "process.output") {
      const stream = typeof payload.stream === "string" ? payload.stream : "STDOUT";
      const seq = typeof payload.seq === "number" ? payload.seq : null;
      return seq === null ? `Wrapped output (${stream})` : `Wrapped output #${seq} (${stream})`;
    }
  }
  if (event.type.startsWith("wrapper.turn.")) {
    if (event.type === "wrapper.turn.started") return "Wrapped turn started";
    if (event.type === "wrapper.turn.completed") return "Wrapped turn completed";
    if (event.type === "wrapper.turn.failed") return "Wrapped turn failed";
  }
  if (event.type.startsWith("tool.")) {
    const toolName = typeof payload.tool === "string" ? payload.tool : "tool";
    const action = event.type === "tool.started" ? "started" : event.type === "tool.executed" ? "completed" : "failed";
    return `${toolName} ${action}`;
  }
  if (event.type === "agent.turn.started") return "Agent is thinking";
  if (event.type === "agent.turn.completed") return "Agent finished turn";
  if (event.type === "agent.turn.failed") return "Agent turn failed";
  if (event.type === "agent.turn.phase") {
    const phase = typeof payload.phase === "string" ? payload.phase : "progress";
    return `Agent phase: ${phase}`;
  }
  if (event.type === "telemetry.context.window.updated") {
    const used = typeof payload.estimatedUsedTokens === "number" ? payload.estimatedUsedTokens : null;
    const total = typeof payload.contextWindowTokens === "number" ? payload.contextWindowTokens : null;
    return used !== null && total !== null ? `Context usage: ${used}/${total} tokens` : "Context usage updated";
  }
  return event.type.replaceAll(".", " ");
}

function traceDetail(event: EventRow) {
  const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
  if (event.type === "process.output") {
    const text = typeof payload.text === "string" ? payload.text : "";
    return text || shortJson(event.payload);
  }
  if (event.type === "process.exited") {
    const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
    return exitCode === null ? shortJson(event.payload) : `exitCode: ${exitCode}`;
  }
  if (event.type.startsWith("tool.")) {
    const args = shortJson(payload.args);
    const output = shortJson(payload.output);
    const error = typeof payload.error === "string" ? payload.error : "";
    return [args ? `args: ${args}` : "", output ? `output: ${output}` : "", error ? `error: ${error}` : ""]
      .filter(Boolean)
      .join("\n");
  }
  if (event.type === "agent.turn.failed") {
    const error = typeof payload.error === "string" ? payload.error : "";
    return error || "No failure details";
  }
  return shortJson(event.payload);
}

function traceChipCode(event: EventRow) {
  const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
  if (event.type === "agent.turn.started") return "T";
  if (event.type === "agent.turn.completed") return "D";
  if (event.type === "agent.turn.failed") return "F";
  if (event.type.startsWith("wrapper.turn.")) {
    if (event.type === "wrapper.turn.started") return "W";
    if (event.type === "wrapper.turn.completed") return "D";
    return "F";
  }
  if (event.type.startsWith("process.")) {
    if (event.type === "process.started") return "P";
    if (event.type === "process.output") {
      const stream = typeof payload.stream === "string" ? payload.stream : "";
      return stream === "STDERR" ? "!" : "O";
    }
    return "X";
  }
  if (event.type === "agent.turn.phase") {
    const phase = typeof payload.phase === "string" ? payload.phase : "phase";
    return phase.slice(0, 1).toUpperCase() || "P";
  }
  if (event.type === "telemetry.context.window.updated") return "C";
  if (event.type.startsWith("tool.")) {
    if (event.type === "tool.started") return "R";
    if (event.type === "tool.executed") return "E";
    return "F";
  }
  return "?";
}

function traceChipTone(event: EventRow) {
  if (
    event.type === "tool.failed" ||
    event.type === "agent.turn.failed" ||
    event.type === "wrapper.turn.failed"
  ) {
    return "danger";
  }
  if (event.type === "process.exited") {
    const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
    const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
    return exitCode === 0 ? "success" : "danger";
  }
  if (
    event.type === "tool.executed" ||
    event.type === "agent.turn.completed" ||
    event.type === "wrapper.turn.completed"
  ) {
    return "success";
  }
  if (event.type === "telemetry.context.window.updated") return "muted";
  return "neutral";
}

function participantDisplayName(participant: ChannelParticipant, currentUsername?: string) {
  if (
    normalizedSubscriberType(participant) === "HUMAN" &&
    currentUsername &&
    participant.subscriberId === currentUsername
  ) {
    return "you";
  }
  return participant.subscriberId || participant.subscriberType || "participant";
}

function channelDisplayName(channel?: Channel | null, currentUsername?: string) {
  if (!channel) return "Select a channel";
  if (isLifecycleChannel(channel)) return lifecycleAgentName(channel);
  if (!isDirectChannel(channel)) return channel.name;

  const participants = channel.participants ?? [];
  const visibleParticipants = participants.filter(
    (participant) =>
      normalizedSubscriberType(participant) !== "HUMAN" || participant.subscriberId !== currentUsername
  );
  const names = (visibleParticipants.length > 0 ? visibleParticipants : participants).map((participant) =>
    participantDisplayName(participant, currentUsername)
  );

  if (channel.kind?.toUpperCase() === "HUMAN_AGENT_DM" && names[0]) return names[0];
  if (names.length > 0) return `Direct: ${names.join(", ")}`;
  return channel.name;
}

function channelLabel(channel?: Channel | null, currentUsername?: string) {
  if (!channel) return "Select a channel";
  return isDirectChannel(channel) || isLifecycleChannel(channel)
    ? channelDisplayName(channel, currentUsername)
    : `# ${channel.name}`;
}

function participantName(participant: ChannelParticipant) {
  return participant.subscriberId || participant.subscriberType || "Participant";
}

function participantType(participant: ChannelParticipant) {
  const type = normalizedSubscriberType(participant);
  if (type === "HUMAN") return "Human";
  if (type === "AGENT") return "Agent";
  return participant.subscriberType || "Participant";
}

function shareTypeLabel(share: ChannelShare) {
  const type = share.viewerType.trim().toUpperCase();
  if (type === "HUMAN") return "Shared human viewer";
  if (type === "AGENT") return "Shared agent viewer";
  return "Shared viewer";
}

function channelHasHumanShare(channel: Channel, humanId: string) {
  return (channel.shares ?? []).some(
    (share) => share.viewerType.trim().toUpperCase() === "HUMAN" && share.viewerId === humanId
  );
}

function isSharedChannelForUser(channel: Channel, currentUsername: string) {
  return Boolean(currentUsername && channelHasHumanShare(channel, currentUsername));
}

function participantAgentStatus(participant: ChannelParticipant, agents: Agent[]) {
  if (normalizedSubscriberType(participant) !== "AGENT") return null;
  const agent = agents.find((candidate) => candidate.name === participant.subscriberId);
  return agent?.runtimeState === "RUNNING" ? "running" : "off";
}

function channelMatchesQuery(channel: Channel, query: string, currentUsername: string) {
  const displayName = channelDisplayName(channel, currentUsername).toLowerCase();
  return channel.name.toLowerCase().includes(query) || displayName.includes(query);
}

function canManageUserChannel(channel: Channel | null, userId: string | null) {
  if (!channel || isLifecycleChannel(channel)) return false;
  if (typeof channel.canManage === "boolean") return channel.canManage;
  if (channel.visibility === "PRIVATE") return Boolean(userId && channel.ownerHumanId === userId);
  return true;
}

function channelHasTeamParticipant(channel: Channel, teamIds: Set<string>) {
  return (channel.participants ?? []).some(
    (participant) =>
      normalizedSubscriberType(participant) === "TEAM" && teamIds.has(participant.subscriberId)
  );
}

function channelVisibleToUserUi(
  channel: Channel,
  userId: string | null,
  username: string,
  viewerTeamIds: Set<string>
) {
  const isSharedToHuman = channelHasHumanShare(channel, username);
  if (isLifecycleChannel(channel)) return false;
  if (isHumanAgentDirectChannel(channel)) {
    return channelHasHumanParticipant(channel, username) || isSharedToHuman;
  }
  if (isDirectChannel(channel)) {
    return channelHasHumanParticipant(channel, username) || isSharedToHuman;
  }
  if (channel.visibility !== "PRIVATE") return true;
  if (Boolean(userId && channel.ownerHumanId === userId)) return true;
  if (channelHasHumanParticipant(channel, username)) return true;
  if (channelHasTeamParticipant(channel, viewerTeamIds)) return true;
  return isSharedToHuman;
}

function agentVisibleToUserUi(
  agent: Agent,
  visibleChannelAgentNames: Set<string>,
  userId: string | null
) {
  if (agent.visibility !== "PRIVATE") return true;
  if (Boolean(userId && agent.ownerHumanId === userId)) return true;
  return visibleChannelAgentNames.has(agent.name);
}

function readLinkedChannelId() {
  return new URL(window.location.href).searchParams.get("channel");
}

function readProjectTab() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("project") && url.searchParams.get("create") === "project") return "new";
  const tab = url.searchParams.get("tab");
  if(tab==="members")return "chat";
  return tab && ["chat", "tasks", "files", "members"].includes(tab) ? tab : url.searchParams.has("task") ? "tasks" : "chat";
}

function readPendingShareToken() {
  const token = new URL(window.location.href).searchParams.get("share");
  return token?.trim() || null;
}

function updateChannelDeepLink(channelId: string | null, replace = false, dashboard = false) {
  const url = new URL(window.location.href);
  url.searchParams.delete("message");
  url.searchParams.delete("request");url.searchParams.delete("assistant");
  url.searchParams.delete("category");
  url.searchParams.delete("view");
  url.searchParams.delete("agent"); url.searchParams.delete("skill");
  url.searchParams.delete("project");
  url.searchParams.delete("task"); url.searchParams.delete("tab"); url.searchParams.delete("create");
  if (channelId) {
    url.searchParams.set("channel", channelId);
  } else {
    url.searchParams.delete("channel");
    if (dashboard) url.searchParams.set("view", "dashboard");
  }
  const method = replace ? "replaceState" : "pushState";
  window.history[method](null, "", url);
}

function consumeShareToken(channelId?: string | null) {
  const url = new URL(window.location.href);
  url.searchParams.delete("share");
  if (channelId) {
    url.searchParams.set("channel", channelId);
  }
  window.history.replaceState(null, "", url);
}

function adaptiveMessageBatchSize() {
  const connection = (
    navigator as Navigator & {
      connection?: { downlink?: number; effectiveType?: string; saveData?: boolean };
    }
  ).connection;
  if (connection?.saveData) return 12;
  const effectiveType = connection?.effectiveType ?? "";
  if (effectiveType.includes("2g")) return 10;
  if (effectiveType.includes("3g")) return 20;
  if (typeof connection?.downlink === "number") {
    if (connection.downlink >= 10) return 50;
    if (connection.downlink >= 5) return 40;
  }
  return 30;
}

function mergeEventsChronologically(current: EventRow[], incoming: EventRow[]) {
  const byId = new Map<string, EventRow>();
  for (const event of current) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => {
    const leftPrimary = left.deliverAt ?? left.createdAt ?? 0;
    const rightPrimary = right.deliverAt ?? right.createdAt ?? 0;
    if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary;
    const leftCreated = left.createdAt ?? 0;
    const rightCreated = right.createdAt ?? 0;
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    return left.id.localeCompare(right.id);
  });
}

function createLocalAttachmentId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseMessageAttachments(payload: unknown): MessageAttachment[] {
  if (!payload || typeof payload !== "object") return [];
  const payloadRecord = payload as { attachments?: unknown };
  if (!Array.isArray(payloadRecord.attachments)) return [];
  const attachments: MessageAttachment[] = [];
  for (const entry of payloadRecord.attachments) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const fileId = typeof record.fileId === "string" ? record.fileId.trim() : "";
    if (!fileId) continue;
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : fileId;
    const mime = typeof record.mime === "string" && record.mime.trim() ? record.mime.trim() : undefined;
    const size = typeof record.size === "number" && Number.isFinite(record.size) ? Math.max(0, record.size) : undefined;
    attachments.push({ fileId, name, mime, size });
  }
  return attachments;
}

function formatAttachmentSize(size?: number) {
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return null;
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

export default function App() {
  const { branding } = useBranding();
  const messagesPanelRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeChannelIdRef = useRef<string | null>(null);
  const lastSeenByChannelRef = useRef<Record<string, number>>({});
  const lastLoadedMessageAtByChannelRef = useRef<Record<string, number>>({});
  const lastLoadedTimelineAtByChannelRef = useRef<Record<string, number>>({});
  const channelsRef = useRef<Channel[]>([]);
  const usernameRef = useRef("");
  const userIdRef = useRef<string | null>(null);
  const viewerTeamIdsRef = useRef<Set<string>>(new Set());
  const seenWsEventIdsRef = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const wsSubscribedTopicsRef = useRef<Set<string>>(new Set());
  const wsReconnectTimerRef = useRef<number | null>(null);
  const wsShouldReconnectRef = useRef(true);
  const wsReconnectAttemptRef = useRef(0);
  const messageFetchSeqRef = useRef(0);
  const loadingChannelIdRef = useRef<string | null>(null);
  const forceScrollToBottomOnLoadRef = useRef(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [personalSetup, setPersonalSetup] = useState<OnboardingSummary | null>(null);
  const [creatingPersonalAgent, setCreatingPersonalAgent] = useState(() => new URL(window.location.href).searchParams.get("create") === "personal");
  const [humans, setHumans] = useState<Array<{ username: string }>>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [view, setView] = useState<"dashboard" | "workspace" | "agents" | "projects" | "community">(() => readLinkedChannelId() ? "workspace" : new URL(window.location.href).searchParams.get("view") === "onboarding" || window.location.pathname === "/onboarding" ? "agents" : new URL(window.location.href).searchParams.get("view") === "agents" ? "agents" : new URL(window.location.href).searchParams.get("view") === "projects" ? "projects" : new URL(window.location.href).searchParams.get("view") === "community" ? "community" : "dashboard");
  const [selectedCommunitySkill, setSelectedCommunitySkill] = useState<string|null>(()=>new URL(window.location.href).searchParams.get("skill"));
  const [projectIndex, setProjectIndex] = useState<Project[]>([]);
  const [projectTab, setProjectTab] = useState(readProjectTab);
  const chatVisibleRef = useRef(false);
  chatVisibleRef.current = view === "workspace" || (view === "projects" && projectTab === "chat");
  const onProjectLoaded = useCallback((project: Project) => {
    setProjectIndex(current => current.some(p => p.id === project.id && p.channelId === project.channelId && p.name === project.name && p.description === project.description) ? current : [...current.filter(p => p.id !== project.id), project]);
    void apiJson<Channel[]>("/api/channels?includeArchived=1").then(setChannels).catch(() => {});
  }, []);
  const [selectedProject, setSelectedProject] = useState<string | null>(() => new URL(window.location.href).searchParams.get("project"));
  const [selectedTask, setSelectedTask] = useState<string | null>(() => new URL(window.location.href).searchParams.get("task"));
  const [sharedAssistants,setSharedAssistants] = useState<import("@nest/schemas").AssistantOffer[]>([]);
  const [requestLocation,setRequestLocation] = useState(readAgentRequestLocation);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(() => new URL(window.location.href).searchParams.get("agent"));
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [collapsedChannelGroups, setCollapsedChannelGroups] = useState<Record<ChannelGroupId, boolean>>({
    channels: false,
    direct: false,
    shared: false
  });
  const [hasNewMessagesBelow, setHasNewMessagesBelow] = useState(false);
  const [channelQuery, setChannelQuery] = useState("");
  const [conversationName, setConversationName] = useState("");
  const [conversationDescription, setConversationDescription] = useState("");
  const [conversationVisibility, setConversationVisibility] = useState<"PUBLIC" | "PRIVATE">("PRIVATE");
  const [selectedConversationAgents, setSelectedConversationAgents] = useState<string[]>([]);
  const [agentSearchQuery, setAgentSearchQuery] = useState("");
  const [showArchivedChannels, setShowArchivedChannels] = useState(false);
  const [showConversationDialog, setShowConversationDialog] = useState(false);
  const [showParticipantsDialog, setShowParticipantsDialog] = useState(false);
  const [showChannelManageDialog, setShowChannelManageDialog] = useState(false);
  const [draftState,setDraftState]=useState<{text:string;mentions:SelectedMention[]}>({text:'',mentions:[]});
  const [draftScope,setDraftScope]=useState<{owner:string;channel:string}|null>(null);
  const [draftStored,setDraftStored]=useState(true);
  const draft=draftState.text;
  function setDraft(text:string){setDraftState(current=>({text,mentions:reconcileMentions(current.text,text,current.mentions)}));}
  function chooseMention(text:string,mention:SelectedMention){setDraftState(current=>({text,mentions:[...reconcileMentions(current.text,text,current.mentions),mention]}));}
  const draftRecipients=[...new Map(draftState.mentions.map(m=>[m.kind+':'+m.name,m])).values()];
  const multipleAgentTargets=draftRecipients.filter(m=>m.kind==='AGENT').length>1;
  const sendRequestRef=useRef<{fingerprint:string;id:string}|null>(null);
  const [focusedMessage,setFocusedMessage]=useState<string|null>(()=>new URL(window.location.href).searchParams.get('message'));
  const [username, setUsername] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [loginUsername, setLoginUsername] = useState("admin");
  const [loginPassword, setLoginPassword] = useState("");
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [participantKind, setParticipantKind] = useState<"HUMAN" | "AGENT">("AGENT");
  const [participantValue, setParticipantValue] = useState("");
  const [participantSubmitting, setParticipantSubmitting] = useState(false);
  const [participantRemovingKey, setParticipantRemovingKey] = useState<string | null>(null);
  const [shareKind, setShareKind] = useState<"HUMAN" | "AGENT">("HUMAN");
  const [shareValue, setShareValue] = useState("");
  const [shareSubmitting, setShareSubmitting] = useState(false);
  const [shareRemovingKey, setShareRemovingKey] = useState<string | null>(null);
  const [channelVisibilityDraft, setChannelVisibilityDraft] = useState<"PUBLIC" | "PRIVATE">("PRIVATE");
  const [updatingChannelVisibility, setUpdatingChannelVisibility] = useState(false);
  const [archiveDraft, setArchiveDraft] = useState(false);
  const [expandedTraceEventId, setExpandedTraceEventId] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const activeChannel = useMemo(
    () => channels.find((channel) => channel.id === activeChannelId) ?? null,
    [activeChannelId, channels]
  );

  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);

  useEffect(() => {
    usernameRef.current = username;
  }, [username]);

  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  const visibleTimelineEvents = useMemo(
    () => events.filter((event) => event.type === "message.created" || isTraceEvent(event)),
    [events]
  );

  const timelineItems = useMemo(() => {
    const items: Array<
      | { kind: "message"; id: string; event: EventRow }
      | { kind: "trace-group"; id: string; traceEvents: EventRow[]; tone: "agent" | "system" }
    > = [];
    let traceBuffer: EventRow[] = [];
    let groupCounter = 0;

    const flushTraceBuffer = () => {
      if (traceBuffer.length === 0) return;
      const tone: "agent" | "system" = traceBuffer.some(
        (entry) => entry.type === "agent.turn.failed" || entry.type === "tool.failed"
      )
        ? "system"
        : "agent";
      items.push({
        kind: "trace-group",
        id: `trace-group-${traceBuffer[0]?.id ?? groupCounter}`,
        traceEvents: traceBuffer,
        tone
      });
      traceBuffer = [];
      groupCounter += 1;
    };

    for (const event of visibleTimelineEvents) {
      if (event.type === "message.created") {
        flushTraceBuffer();
        items.push({ kind: "message", id: event.id, event });
      } else {
        traceBuffer.push(event);
      }
    }
    flushTraceBuffer();
    return items;
  }, [visibleTimelineEvents]);
  const isConversationEmpty = !messagesLoading && timelineItems.length === 0;

  const agentIsThinking = useMemo(() => {
    let activeTurns = 0;
    for (const event of events) {
      if (event.type === "agent.turn.started") activeTurns += 1;
      if (event.type === "agent.turn.completed" || event.type === "agent.turn.failed") {
        activeTurns = Math.max(0, activeTurns - 1);
      }
    }
    return activeTurns > 0;
  }, [events]);

  const viewerTeamIds = useMemo(() => new Set(teams.map((team) => team.id)), [teams]);
  useEffect(() => {
    viewerTeamIdsRef.current = viewerTeamIds;
  }, [viewerTeamIds]);
  const visibleChannels = useMemo(
    () =>
      channels.filter((channel) =>
        channelVisibleToUserUi(channel, userId, username, viewerTeamIds)
      ),
    [channels, userId, username, viewerTeamIds]
  );
  const standaloneChannels = useMemo(() => visibleChannels.filter(channel => !projectIndex.some(project => project.channelId === channel.id)), [visibleChannels, projectIndex]);
  useEffect(() => {
    if (view === "projects") setActiveChannelId(projectIndex.find(project => project.id === selectedProject)?.channelId ?? null);
  }, [view, selectedProject, projectIndex]);
  const activeChannels = useMemo(
    () => standaloneChannels.filter((channel) => !channel.archivedAt),
    [standaloneChannels]
  );
  const archivedChannels = useMemo(
    () => standaloneChannels.filter((channel) => Boolean(channel.archivedAt)),
    [standaloneChannels]
  );
  const visibleChannelAgentNames = useMemo(() => {
    const names = new Set<string>();
    for (const channel of visibleChannels) {
      for (const participant of channel.participants ?? []) {
        if (normalizedSubscriberType(participant) === "AGENT" && participant.subscriberId) {
          names.add(participant.subscriberId);
        }
      }
    }
    return names;
  }, [visibleChannels]);
  const visibleAgents = useMemo(
    () => agents.filter((agent) => agentVisibleToUserUi(agent, visibleChannelAgentNames, userId)),
    [agents, visibleChannelAgentNames, userId]
  );

  useEffect(()=>{
    if(!authenticated||!activeChannelId||!userId){setSharedAssistants([]);return;}
    const abort=new AbortController();
    void apiJson<{items:import("@nest/schemas").AssistantOffer[]}>("/api/assistants",{signal:abort.signal}).then(value=>{if(!abort.signal.aborted)setSharedAssistants(Array.isArray(value.items)?value.items:[]);}).catch(()=>{if(!abort.signal.aborted)setSharedAssistants([]);});
    return ()=>abort.abort();
  },[authenticated,activeChannelId,userId]);
  const mentionOptions = useMemo(() => {
    const candidates=mentionCandidates(visibleAgents, humans, activeChannel?.participants ?? []);
    for(const offer of sharedAssistants.filter(item=>!item.yours)){
      const existing=candidates.find(item=>item.kind==='Agent'&&item.name===offer.agentName);
      if(existing?.inConversation)continue;
      if(existing){existing.assistantOwner=offer.ownerName;existing.id='ASSISTANT:'+offer.agentName;}
      else candidates.push({id:'ASSISTANT:'+offer.agentName,name:offer.agentName,kind:'Agent',inConversation:false,assistantOwner:offer.ownerName});
    }
    return candidates;
  }, [visibleAgents, humans, activeChannel?.participants,sharedAssistants]);

  const filteredChannels = useMemo(() => {
    const query = channelQuery.trim().toLowerCase();
    if (!query) return activeChannels;
    return activeChannels.filter((channel) => channelMatchesQuery(channel, query, username));
  }, [activeChannels, channelQuery, username]);

  const filteredArchivedChannels = useMemo(() => {
    const query = channelQuery.trim().toLowerCase();
    if (!query) return archivedChannels;
    return archivedChannels.filter((channel) => channelMatchesQuery(channel, query, username));
  }, [archivedChannels, channelQuery, username]);

  const groupedChannels = useMemo(
    () =>
      CHANNEL_GROUPS.map((group) => ({
        ...group,
        channels: filteredChannels.filter((channel) => {
          const shared = isSharedChannelForUser(channel, username);
          if (group.id === "shared") return shared;
          if (group.id === "direct") {
            if (shared || !username) return false;
            return (
              channelGroupId(channel) === "direct" &&
              isHumanAgentDirectChannel(channel) &&
              channelHasHumanParticipant(channel, username)
            );
          }
          if (shared) return false;
          return channelGroupId(channel) === "channels";
        })
      })).filter((group) => group.channels.length > 0),
    [filteredChannels, username]
  );

  const isSearchingChannels = Boolean(channelQuery.trim());
  const uploadingAttachmentCount = pendingAttachments.filter((item) => item.status === "uploading").length;
  const readyAttachments = pendingAttachments
    .filter((item) => item.status === "ready" && item.uploaded)
    .map((item) => item.uploaded as UploadedAttachment);
  const hasAttachmentErrors = pendingAttachments.some((item) => item.status === "error");
  const activeChannelManageable = canManageUserChannel(activeChannel, userId);
  const activeChannelCanPost = activeChannel ? activeChannel.canPost !== false : false;
  const activeConversationName = activeChannel ? projectIndex.find(project => project.channelId === activeChannel.id)?.name ?? channelLabel(activeChannel, username) : "";
  const mentions = useMentionPicker({value:draft, onChange:setDraft, onChoose:chooseMention, onAskAssistant:(name,brief)=>{if(userId){prepareAssistantRequest(userId,name,brief);selectAgent(null,{requests:true,assistant:name});}}, targeted:true, textareaRef:composerTextareaRef, candidates:mentionOptions, channelId:activeChannelId, disabled:!activeChannel || Boolean(activeChannel.archivedAt) || !activeChannelCanPost || sending});
  const canStartConversation =
    Boolean(conversationName.trim()) || selectedConversationAgents.length === 1;
  const selectedConversationAgentRecords = useMemo(
    () =>
      selectedConversationAgents.map((agentName) => visibleAgents.find((agent) => agent.name === agentName) ?? { name: agentName }),
    [visibleAgents, selectedConversationAgents]
  );
  const agentSuggestions = useMemo(() => {
    const query = agentSearchQuery.trim().toLowerCase();
    return visibleAgents
      .filter((agent) => !selectedConversationAgents.includes(agent.name))
      .filter((agent) => !query || agent.name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [agentSearchQuery, visibleAgents, selectedConversationAgents]);

  useEffect(() => {
    if (!activeChannel) return;
    setChannelVisibilityDraft(activeChannel.visibility === "PUBLIC" ? "PUBLIC" : "PRIVATE");
    setArchiveDraft(Boolean(activeChannel.archivedAt));
  }, [activeChannel?.id, activeChannel?.visibility, activeChannel?.archivedAt]);

  function selectCommunity(name:string|null) {
    setFocusedMessage(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('message');
    for (const key of ['channel','agent','project','task','tab','create','request','assistant']) url.searchParams.delete(key);
    url.searchParams.set('view','community');
    url.searchParams.delete('category');
    if (name) url.searchParams.set('skill',name); else url.searchParams.delete('skill');
    window.history.pushState(null,'',url);
    setActiveChannelId(null); setView('community'); setSelectedCommunitySkill(name); setMobileSidebarOpen(false);
  }

  function selectProject(project: string | null, task: string | null = null, tab = task ? "tasks" : "chat", replace = false) {
    setFocusedMessage(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('message');
    url.searchParams.delete('request');url.searchParams.delete('assistant');
    url.searchParams.delete('category');
    url.searchParams.delete("channel"); url.searchParams.delete("agent"); url.searchParams.delete("skill");
    url.searchParams.set("view", "projects");
    if (project) url.searchParams.set("project", project); else url.searchParams.delete("project");
    if (task) url.searchParams.set("task", task); else url.searchParams.delete("task"); url.searchParams.delete("tab"); url.searchParams.delete("create");
    if (project) url.searchParams.set("tab", tab); else url.searchParams.delete("tab");
    if (!project && tab === "new") url.searchParams.set("create", "project"); else url.searchParams.delete("create");
    window.history[replace ? "replaceState" : "pushState"](null, "", url);
    setProjectTab(tab);
    setActiveChannelId(projectIndex.find(p => p.id === project)?.channelId ?? null); setView("projects"); setSelectedProject(project); setSelectedTask(task); setMobileSidebarOpen(false);
  }

  function selectAgent(name: string | null, options: {replace?:boolean; create?:boolean; requests?:boolean; request?:string; assistant?:string} = {}) {
    setFocusedMessage(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('message');
    url.searchParams.delete('category');
    url.searchParams.delete("channel");
    url.searchParams.delete("project"); url.searchParams.delete("task"); url.searchParams.delete("tab"); url.searchParams.delete("create");
    url.searchParams.delete("skill");
    url.pathname = "/";
    url.searchParams.set("view", "agents");
    url.searchParams.delete("request");url.searchParams.delete("assistant");
    if(options.requests){url.searchParams.set("tab","requests");if(options.request)url.searchParams.set("request",options.request);if(options.assistant)url.searchParams.set("assistant",options.assistant);}
    setRequestLocation({active:Boolean(options.requests),requestId:options.request??null,assistant:options.assistant??null});
    if(options.create) url.searchParams.set("create","personal");
    setCreatingPersonalAgent(Boolean(options.create));
    if (name) url.searchParams.set("agent", name); else url.searchParams.delete("agent"); url.searchParams.delete("skill");
    window.history[options.replace ? "replaceState" : "pushState"](null, "", url);
    setActiveChannelId(null); setView("agents"); setSelectedAgent(name); setMobileSidebarOpen(false);
  }

  function selectChannel(channelId: string | null, options?: { replace?: boolean }) {
    setFocusedMessage(null);
    const project = projectIndex.find(project => project.channelId === channelId);
    if (project) { selectProject(project.id, null, "chat", options?.replace); return; }
    setActiveChannelId(channelId);
    setView(channelId ? "workspace" : "dashboard");
    setMobileSidebarOpen(false);
    updateChannelDeepLink(channelId, options?.replace, channelId === null);
  }

  async function loadSession() {
    setAuthLoading(true);
    setError(null);
    try {
      const me = await apiJson<AuthMe>("/api/auth/me");
      const nextUsername = me.username ?? "";
      setUsername(nextUsername);
      setUserId(me.id ?? null);
      setLoginUsername(nextUsername || "admin");
      setAuthenticated(Boolean(nextUsername));
      setMustChangePassword(Boolean(me.mustChangePassword));
    } catch {
      setAuthenticated(false);
      setUsername("");
      setUserId(null);
      setMustChangePassword(false);
    } finally {
      setAuthLoading(false);
    }
  }

  async function loadShell() {
    if (!authenticated) return;
    setError(null);
    setLoading(true);
    try {
      const pendingShareToken = readPendingShareToken();
      let claimedShareChannelId: string | null = null;
      if (pendingShareToken) {
        try {
          const claimed = await apiJson<{ ok?: boolean; channelId: string }>(
            `/api/channel-share-links/${encodeURIComponent(pendingShareToken)}/claim`,
            {
              method: "POST",
              headers: getApiHeaders()
            }
          );
          claimedShareChannelId = claimed.channelId;
          consumeShareToken(claimed.channelId);
        } catch (claimError) {
          consumeShareToken(readLinkedChannelId());
          setError(
            claimError instanceof Error
              ? claimError.message
              : "Unable to claim shared channel link"
          );
        }
      }
      const [nextChannels, nextAgents, nextHumans, nextTeams, nextProjects, nextOnboarding] = await Promise.all([
        apiJson<Channel[]>("/api/channels?includeArchived=1"),
        apiJson<Agent[]>("/api/agents"),
        apiJson<Array<{ username: string }>>("/api/humans").catch(() => []),
        apiJson<Team[]>("/api/teams/me").catch(() => []),
        apiJson<Project[]>("/api/projects"),
        apiJson<OnboardingSummary>("/api/onboarding/summary").catch(() => null)
      ]);
      setProjectIndex(nextProjects);
      setChannels(nextChannels);
      setAgents(nextAgents);
      setHumans(nextHumans);
      setTeams(nextTeams);
      const nextViewerTeamIds = new Set(nextTeams.map((team) => team.id));
      const visibleChannels = nextChannels.filter((channel) =>
        channelVisibleToUserUi(channel, userId, username, nextViewerTeamIds)
      );
      const nextVisibleChannelAgentNames = new Set<string>();
      for (const channel of visibleChannels) {
        for (const participant of channel.participants ?? []) {
          if (normalizedSubscriberType(participant) === "AGENT" && participant.subscriberId) {
            nextVisibleChannelAgentNames.add(participant.subscriberId);
          }
        }
      }
      const nextVisibleAgents = nextAgents.filter((agent) =>
        agentVisibleToUserUi(agent, nextVisibleChannelAgentNames, userId)
      );
      setSelectedConversationAgents((current) =>
        current.filter((agentName) => nextVisibleAgents.some((agent) => agent.name === agentName))
      );
      setPersonalSetup(nextOnboarding);
      const linkedChannelId = readLinkedChannelId();
      const preferredLinkedId = claimedShareChannelId ?? linkedChannelId;
      const linkedChannel = visibleChannels.find((channel) => channel.id === preferredLinkedId);
      const nextActiveChannelId =
        linkedChannel?.id ??
        (activeChannelId && visibleChannels.some((channel) => channel.id === activeChannelId && !channel.archivedAt)
          ? activeChannelId
          : null);
      if (linkedChannel?.archivedAt) setShowArchivedChannels(true);
      const urlView = new URL(window.location.href).searchParams.get("view");
      if (!claimedShareChannelId && !linkedChannelId && (urlView === "onboarding" || window.location.pathname === "/onboarding" || (!urlView && nextOnboarding && !nextOnboarding.setup?.completedAt && (nextOnboarding.setup || (!nextProjects.length && !nextAgents.some(a=>a.ownerHumanId===userId)))))) {
        const legacySetupLink = urlView === "onboarding" || window.location.pathname === "/onboarding";
        selectAgent(nextOnboarding?.setup?.channelId ? nextOnboarding.setup.name : null, {replace:true,create:legacySetupLink && !nextOnboarding?.setup?.channelId});
      } else if (!claimedShareChannelId && ["agents", "projects", "community"].includes(new URL(window.location.href).searchParams.get("view") ?? "") && !linkedChannelId) {
        setActiveChannelId(nextProjects.find(p => p.id === new URL(window.location.href).searchParams.get("project"))?.channelId ?? null); setView(new URL(window.location.href).searchParams.get("view") === "projects" ? "projects" : new URL(window.location.href).searchParams.get("view") === "community" ? "community" : "agents");
      } else {
        const linkedMessage=new URL(window.location.href).searchParams.get('message');
        const project = nextProjects.find(p => p.channelId === nextActiveChannelId);
        if (project) selectProject(project.id, null, "chat", true);
        else selectChannel(nextActiveChannelId, { replace: true });
        if(linkedMessage&&linkedChannel){setFocusedMessage(linkedMessage);const link=new URL(window.location.href);link.searchParams.set('message',linkedMessage);window.history.replaceState(null,'',link);}
      }
      // Unread-message refresh is optional; it must not hold the page loading state.
      void loadMessageNotifications({ initialize: true });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load workspace");
    } finally {
      setLoading(false);
    }
  }

  function scrollMessagesToBottom(behavior: ScrollBehavior = "smooth") {
    window.requestAnimationFrame(() => {
      const panel = messagesPanelRef.current;
      if (!panel) return;
      panel.scrollTo({ top: panel.scrollHeight, behavior });
    });
  }

  function isMessagesPanelNearBottom() {
    const panel = messagesPanelRef.current;
    if (!panel) return true;
    return panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80;
  }

  function newestMessageTime(channelEvents: EventRow[]) {
    return channelEvents.reduce((newest, event) => {
      if (event.type !== "message.created" && event.type !== "agent.turn.failed") return newest;
      return Math.max(newest, event.createdAt ?? 0);
    }, 0);
  }

  function newestTimelineEventTime(channelEvents: EventRow[]) {
    return channelEvents.reduce((newest, event) => {
      if (event.type !== "message.created" && !isTraceEvent(event)) return newest;
      return Math.max(newest, event.createdAt ?? 0);
    }, 0);
  }

  function markChannelSeen(channelId: string, channelEvents: EventRow[]) {
    if (!chatVisibleRef.current) return;
    const newestMessageAt = newestMessageTime(channelEvents);
    if (newestMessageAt > 0) {
      lastSeenByChannelRef.current[channelId] = Math.max(
        lastSeenByChannelRef.current[channelId] ?? 0,
        newestMessageAt
      );
    }
    setUnreadCounts((current) => {
      if (!current[channelId]) return current;
      const next = { ...current };
      delete next[channelId];
      return next;
    });
  }

  function rememberWsEvent(eventId: string) {
    const seen = seenWsEventIdsRef.current;
    if (seen.has(eventId)) return false;
    seen.add(eventId);
    if (seen.size > 3000) {
      const first = seen.values().next();
      if (!first.done) seen.delete(first.value);
    }
    return true;
  }

  async function loadMessages(
    channelId: string,
    options?: { scrollToBottom?: boolean; showLoading?: boolean; scrollBehavior?: ScrollBehavior }
  ) {
    const fetchSeq = messageFetchSeqRef.current + 1;
    messageFetchSeqRef.current = fetchSeq;
    const limit = adaptiveMessageBatchSize();
    if (options?.showLoading) {
      loadingChannelIdRef.current = channelId;
      setMessagesLoading(true);
    }
    try {
      const [messageEvents, failureEvents, turnEvents, toolEvents, contextEvents, wrapperEvents, processEvents] =
        await Promise.all([
        apiJson<EventRow[]>(
          `/api/events?channelId=${encodeURIComponent(channelId)}&type=message.created&limit=${limit}&order=desc`
        ),
        apiJson<EventRow[]>(
          `/api/events?channelId=${encodeURIComponent(channelId)}&type=agent.turn.failed&limit=${limit}&order=desc`
        ),
        apiJson<EventRow[]>(
          `/api/events?channelId=${encodeURIComponent(channelId)}&typePrefix=agent.turn.&limit=${limit}&order=desc`
        ),
        apiJson<EventRow[]>(
          `/api/events?channelId=${encodeURIComponent(channelId)}&typePrefix=tool.&limit=${limit}&order=desc`
        ),
        apiJson<EventRow[]>(
          `/api/events?channelId=${encodeURIComponent(channelId)}&type=telemetry.context.window.updated&limit=${limit}&order=desc`
        ),
        apiJson<EventRow[]>(
          `/api/events?channelId=${encodeURIComponent(channelId)}&typePrefix=wrapper.turn.&limit=${limit}&order=desc`
        ),
        apiJson<EventRow[]>(
          `/api/events?channelId=${encodeURIComponent(channelId)}&typePrefix=process.&limit=${limit}&order=desc`
        )
      ]);
      if (fetchSeq !== messageFetchSeqRef.current || channelId !== activeChannelIdRef.current) {
        return;
      }
      const nextEvents = mergeEventsChronologically(
        mergeEventsChronologically(
          mergeEventsChronologically(
            mergeEventsChronologically(mergeEventsChronologically(messageEvents, failureEvents), turnEvents),
            mergeEventsChronologically(toolEvents, contextEvents)
          ),
          wrapperEvents
        ),
        processEvents
      ).reverse();
      const chronologicalEvents = [...nextEvents].reverse();
      const previousNewestMessageAt = lastLoadedMessageAtByChannelRef.current[channelId] ?? 0;
      const nextNewestMessageAt = newestMessageTime(nextEvents);
      const previousNewestTimelineAt = lastLoadedTimelineAtByChannelRef.current[channelId] ?? 0;
      const nextNewestTimelineAt = newestTimelineEventTime(nextEvents);
      const hasNewTimelineEvents =
        previousNewestTimelineAt > 0 && nextNewestTimelineAt > previousNewestTimelineAt;

      setEvents((current) =>
        options?.showLoading ? chronologicalEvents : mergeEventsChronologically(current, chronologicalEvents)
      );
      if (options?.showLoading) {
        setHasOlderMessages(messageEvents.length === limit);
      }
      markChannelSeen(channelId, nextEvents);
      lastLoadedMessageAtByChannelRef.current[channelId] = Math.max(
        previousNewestMessageAt,
        nextNewestMessageAt
      );
      lastLoadedTimelineAtByChannelRef.current[channelId] = Math.max(
        previousNewestTimelineAt,
        nextNewestTimelineAt
      );
      if (options?.scrollToBottom) {
        forceScrollToBottomOnLoadRef.current = true;
        setHasNewMessagesBelow(false);
        scrollMessagesToBottom(options.scrollBehavior);
      }
      if (!options?.scrollToBottom && hasNewTimelineEvents && channelId === activeChannelIdRef.current) {
        if (isMessagesPanelNearBottom()) {
          setHasNewMessagesBelow(false);
          scrollMessagesToBottom();
        } else {
          setHasNewMessagesBelow(true);
        }
      }
    } catch (loadError) {
      if (fetchSeq === messageFetchSeqRef.current) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load messages");
      }
    } finally {
      if (
        loadingChannelIdRef.current === channelId &&
        fetchSeq === messageFetchSeqRef.current
      ) {
        loadingChannelIdRef.current = null;
        setMessagesLoading(false);
      }
    }
  }

  async function handleLoadOlderMessages() {
    if (!activeChannelId || events.length === 0 || loadingOlderMessages) return;
    const oldestEventAt = events[0]?.createdAt;
    if (!oldestEventAt) return;
    const channelId = activeChannelId;
    const limit = adaptiveMessageBatchSize();
    const panel = messagesPanelRef.current;
    const previousScrollHeight = panel?.scrollHeight ?? 0;

    setLoadingOlderMessages(true);
    setError(null);
    try {
      const [olderMessages, olderTurns, olderTools, olderWrappers, olderProcesses] = await Promise.all([
        apiJson<EventRow[]>(
          `/api/events?channelId=${encodeURIComponent(channelId)}&type=message.created&limit=${limit}&order=desc&before=${oldestEventAt}`
        ),
        apiJson<EventRow[]>(
          `/api/events?channelId=${encodeURIComponent(channelId)}&typePrefix=agent.turn.&limit=${limit}&order=desc&before=${oldestEventAt}`
        ),
        apiJson<EventRow[]>(
          `/api/events?channelId=${encodeURIComponent(channelId)}&typePrefix=tool.&limit=${limit}&order=desc&before=${oldestEventAt}`
        ),
        apiJson<EventRow[]>(
          `/api/events?channelId=${encodeURIComponent(channelId)}&typePrefix=wrapper.turn.&limit=${limit}&order=desc&before=${oldestEventAt}`
        ),
        apiJson<EventRow[]>(
          `/api/events?channelId=${encodeURIComponent(channelId)}&typePrefix=process.&limit=${limit}&order=desc&before=${oldestEventAt}`
        )
      ]);
      const olderEvents = mergeEventsChronologically(
        mergeEventsChronologically(
          mergeEventsChronologically(olderMessages, olderTurns),
          mergeEventsChronologically(olderTools, olderWrappers)
        ),
        olderProcesses
      );
      if (channelId !== activeChannelIdRef.current) return;
      const chronologicalOlderEvents = [...olderEvents].reverse();
      setEvents((current) => {
        const existingIds = new Set(current.map((event) => event.id));
        return [
          ...chronologicalOlderEvents.filter((event) => !existingIds.has(event.id)),
          ...current
        ];
      });
      setHasOlderMessages(
        olderMessages.length === limit ||
          olderTurns.length === limit ||
          olderTools.length === limit ||
          olderWrappers.length === limit ||
          olderProcesses.length === limit
      );
      window.requestAnimationFrame(() => {
        const currentPanel = messagesPanelRef.current;
        if (!currentPanel) return;
        currentPanel.scrollTop += currentPanel.scrollHeight - previousScrollHeight;
      });
    } catch (olderError) {
      setError(olderError instanceof Error ? olderError.message : "Unable to load previous messages");
    } finally {
      setLoadingOlderMessages(false);
    }
  }

  async function loadMessageNotifications(options?: { initialize?: boolean }) {
    if (!authenticated) return;
    try {
      const nextEvents = await apiJson<EventRow[]>(
        "/api/events?type=message.created&limit=100&order=desc"
      );
      if (options?.initialize) {
        const nextSeen = { ...lastSeenByChannelRef.current };
        for (const event of nextEvents) {
          if (!event.channelId) continue;
          nextSeen[event.channelId] = Math.max(nextSeen[event.channelId] ?? 0, event.createdAt ?? 0);
        }
        lastSeenByChannelRef.current = nextSeen;
        setUnreadCounts({});
        return;
      }

      const activeId = chatVisibleRef.current ? activeChannelIdRef.current : null;
      const nextCounts: Record<string, number> = {};
      for (const event of nextEvents) {
        if (!event.channelId || event.channelId === activeId) continue;
        const channel = channels.find((candidate) => candidate.id === event.channelId);
        if (channel?.archivedAt) continue;
        if ((event.createdAt ?? 0) > (lastSeenByChannelRef.current[event.channelId] ?? 0)) {
          nextCounts[event.channelId] = (nextCounts[event.channelId] ?? 0) + 1;
        }
      }
      setUnreadCounts(nextCounts);
    } catch {
      // Notification polling is best-effort; active channel loading reports visible errors.
    }
  }

  function handleIncomingRealtimeEvent(event: EventRow) {
    if (!event.id || !rememberWsEvent(event.id)) return;
    if(event.type==='message.created')window.dispatchEvent(new Event('nest-message'));
    const eventChannelId = event.channelId;
    if (!eventChannelId) return;

    const currentActiveId = activeChannelIdRef.current;
    if (chatVisibleRef.current && eventChannelId === currentActiveId && (event.type === "message.created" || isTraceEvent(event))) {
      const shouldAutoScroll = isMessagesPanelNearBottom();
      setEvents((current) => mergeEventsChronologically(current, [event]));
      if (event.type === "message.created" || event.type === "agent.turn.failed") {
        const eventCreatedAt = event.createdAt ?? 0;
        if (eventCreatedAt > 0) {
          lastSeenByChannelRef.current[eventChannelId] = Math.max(
            lastSeenByChannelRef.current[eventChannelId] ?? 0,
            eventCreatedAt
          );
          lastLoadedMessageAtByChannelRef.current[eventChannelId] = Math.max(
            lastLoadedMessageAtByChannelRef.current[eventChannelId] ?? 0,
            eventCreatedAt
          );
        }
      }
      const timelineCreatedAt = event.createdAt ?? 0;
      if (timelineCreatedAt > 0) {
        lastLoadedTimelineAtByChannelRef.current[eventChannelId] = Math.max(
          lastLoadedTimelineAtByChannelRef.current[eventChannelId] ?? 0,
          timelineCreatedAt
        );
      }
      setUnreadCounts((current) => {
        if (!current[eventChannelId]) return current;
        const next = { ...current };
        delete next[eventChannelId];
        return next;
      });
      if (shouldAutoScroll) {
        setHasNewMessagesBelow(false);
        scrollMessagesToBottom();
      } else {
        setHasNewMessagesBelow(true);
      }
      return;
    }

    if (event.type !== "message.created") return;
    if (eventChannelId === currentActiveId) return;

    const channel = channelsRef.current.find((candidate) => candidate.id === eventChannelId);
    if (!channel || channel.archivedAt) return;
    if (
      !channelVisibleToUserUi(
        channel,
        userIdRef.current,
        usernameRef.current,
        viewerTeamIdsRef.current
      )
    ) {
      return;
    }
    const eventCreatedAt = event.createdAt ?? 0;
    if (eventCreatedAt <= (lastSeenByChannelRef.current[eventChannelId] ?? 0)) return;

    setUnreadCounts((current) => ({
      ...current,
      [eventChannelId]: (current[eventChannelId] ?? 0) + 1
    }));
  }

  useEffect(() => {
    void loadSession();
  }, []);

  useEffect(() => {
    if (!authenticated || mustChangePassword) return;
    void loadShell();
  }, [authenticated, mustChangePassword]);

  useEffect(() => {
    messageFetchSeqRef.current += 1;
    activeChannelIdRef.current = activeChannelId;
    loadingChannelIdRef.current = activeChannelId;
    forceScrollToBottomOnLoadRef.current = Boolean(activeChannelId);
    setEvents([]);
    setMessagesLoading(Boolean(activeChannelId));
    setLoadingOlderMessages(false);
    setHasOlderMessages(false);
    setHasNewMessagesBelow(false);
    setExpandedTraceEventId(null);
    setShowParticipantsDialog(false);
    setShowChannelManageDialog(false);
    const saved=userId&&activeChannelId?loadChatDraft(userId,activeChannelId):null;
    setPendingAttachments(saved?.attachments.map(file=>({localId:file.fileId,name:file.name,mime:file.mime??'application/octet-stream',size:file.size??0,status:'ready' as const,uploaded:{localId:file.fileId,fileId:file.fileId,name:file.name,mime:file.mime??'application/octet-stream',size:file.size??0}}))??[]);
    setDraftState(saved?{text:saved.text,mentions:saved.mentions}:{text:'',mentions:[]});sendRequestRef.current=saved?.request??null;
    setDraftScope(userId&&activeChannelId?{owner:userId,channel:activeChannelId}:null);
    setShareValue("");
    setShareLinkCopied(false);
    setShareRemovingKey(null);
    setShareSubmitting(false);
  }, [activeChannelId,userId]);

  useEffect(()=>{
    if(!authenticated||!userId||!activeChannelId||draftScope?.owner!==userId||draftScope.channel!==activeChannelId)return;
    setDraftStored(saveChatDraft(userId,activeChannelId,{...draftState,attachments:readyAttachments.map(({fileId,name,mime,size})=>({fileId,name,mime,size})),...(sendRequestRef.current?{request:sendRequestRef.current}:{})}));
  },[draftState,pendingAttachments,draftScope,userId,activeChannelId,authenticated]);
  useEffect(()=>{if(userId&&view==='projects'&&selectedProject&&projectIndex.some(p=>p.id===selectedProject))rememberProject(userId,selectedProject);},[userId,view,selectedProject,projectIndex]);

  useEffect(() => {
    if (!authenticated || mustChangePassword) return;
    if (!activeChannelId) {
      setEvents([]);
      return;
    }
    void loadMessages(activeChannelId, {
      scrollBehavior: "auto",
      scrollToBottom: true,
      showLoading: true
    });
  }, [activeChannelId, authenticated, mustChangePassword, projectTab]);

  useEffect(()=>{
    if(!authenticated||!activeChannelId||!focusedMessage||messagesLoading)return;
    const abort=new AbortController();
    void apiJson<EventRow>('/api/events/'+encodeURIComponent(focusedMessage),{signal:abort.signal}).then(event=>{
      if(abort.signal.aborted)return;if(event.channelId!==activeChannelId)throw Error('Mention is in another conversation');
      setEvents(current=>mergeEventsChronologically(current,[event]));
      window.requestAnimationFrame(()=>{const node=document.getElementById('message-'+event.id);node?.scrollIntoView({block:'center'});node?.focus({preventScroll:true});});
    }).catch(()=>{if(!abort.signal.aborted)setError('This mentioned message is no longer available.');});
    return()=>abort.abort();
  },[authenticated,activeChannelId,focusedMessage,messagesLoading]);

  useEffect(() => {
    if (!activeChannelId || messagesLoading) return;
    if (!forceScrollToBottomOnLoadRef.current) return;
    forceScrollToBottomOnLoadRef.current = false;
    if(focusedMessage)return;
    // Run after paint to handle initial DOM/layout settling on hard reload.
    window.requestAnimationFrame(() => {
      scrollMessagesToBottom("auto");
      window.requestAnimationFrame(() => {
        scrollMessagesToBottom("auto");
      });
    });
  }, [activeChannelId, messagesLoading, timelineItems.length, focusedMessage]);

  useEffect(() => {
    if (!authenticated || mustChangePassword) return;
    void loadMessageNotifications();
  }, [authenticated, mustChangePassword, channels]);

  useEffect(() => {
    if (!authenticated || mustChangePassword) return;
    wsShouldReconnectRef.current = true;
    const url = wsUrl();

    const clearReconnectTimer = () => {
      if (wsReconnectTimerRef.current !== null) {
        window.clearTimeout(wsReconnectTimerRef.current);
        wsReconnectTimerRef.current = null;
      }
    };

    const subscribeTopic = (topic: string) => {
      if (!wsSubscribedTopicsRef.current.has(topic)) {
        wsSubscribedTopicsRef.current.add(topic);
      }
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "subscribe", topic }));
      }
    };

    const connect = () => {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => {
        setWsConnected(true);
        wsReconnectAttemptRef.current = 0;
        for (const topic of wsSubscribedTopicsRef.current) {
          ws.send(JSON.stringify({ type: "subscribe", topic }));
        }
        const liveChannelId = activeChannelIdRef.current;
        if (liveChannelId) {
          void loadMessages(liveChannelId);
        }
        void loadMessageNotifications();
      };
      ws.onmessage = (raw) => {
        try {
          const parsed = JSON.parse(String(raw.data)) as WsServerEventMessage;
          if (parsed.type === "event" && parsed.data) {
            handleIncomingRealtimeEvent(parsed.data);
          }
        } catch {
          // Ignore malformed payloads from background topics.
        }
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        setWsConnected(false);
        if (!wsShouldReconnectRef.current) return;
        const delay = Math.min(5000, 400 * 2 ** wsReconnectAttemptRef.current);
        wsReconnectAttemptRef.current += 1;
        clearReconnectTimer();
        wsReconnectTimerRef.current = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      wsShouldReconnectRef.current = false;
      clearReconnectTimer();
      wsRef.current?.close();
      wsRef.current = null;
      wsReconnectAttemptRef.current = 0;
      wsSubscribedTopicsRef.current.clear();
      setWsConnected(false);
    };
  }, [authenticated, mustChangePassword]);

  useEffect(() => {
    if (!authenticated || mustChangePassword) return;
    const desiredTopics = new Set<string>();
    for (const channel of visibleChannels) {
      desiredTopics.add(`channel:${channel.id}`);
    }
    const ws = wsRef.current;
    for (const topic of [...wsSubscribedTopicsRef.current]) {
      if (!desiredTopics.has(topic)) {
        wsSubscribedTopicsRef.current.delete(topic);
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "unsubscribe", topic }));
        }
      }
    }
    for (const topic of desiredTopics) {
      if (!wsSubscribedTopicsRef.current.has(topic)) {
        wsSubscribedTopicsRef.current.add(topic);
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "subscribe", topic }));
        }
      }
    }
  }, [authenticated, mustChangePassword, visibleChannels]);

  useEffect(() => {
    if (!authenticated || mustChangePassword || wsConnected) return;
    const interval = window.setInterval(() => {
      const liveChannelId = activeChannelIdRef.current;
      if (liveChannelId) void loadMessages(liveChannelId);
      void loadMessageNotifications();
    }, 10000);
    return () => window.clearInterval(interval);
  }, [authenticated, mustChangePassword, wsConnected]);

  useEffect(() => {
    if (!authenticated || mustChangePassword) return;
    function handleShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        selectProject(null, null, "new");
      }
      if (event.key === "Escape") {
        setShowConversationDialog(false);
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [authenticated, mustChangePassword]);

  useEffect(() => {
    if (!authenticated || mustChangePassword) return;
    function handlePopState() {
      const linkedChannelId = readLinkedChannelId();
      const linkedChannel = channels.find(
        (channel) =>
          channel.id === linkedChannelId &&
          channelVisibleToUserUi(channel, userId, username, viewerTeamIds)
      );
      if (linkedChannel?.archivedAt) setShowArchivedChannels(true);
      setActiveChannelId(linkedChannel?.id ?? null);
      const url = new URL(window.location.href);
      setFocusedMessage(url.searchParams.get("message"));
      setView(linkedChannel ? "workspace" : url.searchParams.get("view") === "onboarding" ? "agents" : url.searchParams.get("view") === "agents" ? "agents" : url.searchParams.get("view") === "projects" ? "projects" : url.searchParams.get("view") === "community" ? "community" : "dashboard");
      setSelectedAgent(url.searchParams.get("agent"));
      setRequestLocation(readAgentRequestLocation());
      setCreatingPersonalAgent(url.searchParams.get("create") === "personal");
      setSelectedCommunitySkill(url.searchParams.get("skill"));
      setSelectedProject(url.searchParams.get("project")); setSelectedTask(url.searchParams.get("task"));
      setProjectTab(readProjectTab());
      if (!linkedChannel && url.searchParams.get("view") === "projects") setActiveChannelId(projectIndex.find(p => p.id === url.searchParams.get("project"))?.channelId ?? null);
      const project = projectIndex.find(p => p.channelId === linkedChannelId);
      if (project) selectProject(project.id, null, "chat", true);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [authenticated, channels, mustChangePassword, userId, username, viewerTeamIds, projectIndex]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setAuthLoading(true);
    try {
      await apiFetch("/api/auth/login", {
        method: "POST",
        headers: getApiHeaders(),
        body: JSON.stringify({
          username: loginUsername.trim(),
          password: loginPassword
        })
      });
      setLoginPassword("");
      await loadSession();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Unable to sign in");
      setAuthenticated(false);
      setAuthLoading(false);
    }
  }

  async function handleLogout() {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    if(userId)clearOwnerDrafts(userId);
    setAuthenticated(false);
    setUsername("");
    setUserId(null);
    setMustChangePassword(false);
    setNewPassword("");
    setConfirmPassword("");
    setChannels([]);
    setProjectIndex([]);
    try {sessionStorage.removeItem("nest-new-project");sessionStorage.removeItem("nest-new-project-chat");} catch {}
    setAgents([]);
    setTeams([]);
    setEvents([]);
    setActiveChannelId(null);
    updateChannelDeepLink(null, true);
    setChannelQuery("");
    setConversationName("");
    setConversationDescription("");
    setConversationVisibility("PRIVATE");
    setSelectedConversationAgents([]);
    setAgentSearchQuery("");
    setShowArchivedChannels(false);
    setShowConversationDialog(false);
    setUnreadCounts({});
    setHasNewMessagesBelow(false);
    setExpandedTraceEventId(null);
    lastSeenByChannelRef.current = {};
    lastLoadedMessageAtByChannelRef.current = {};
    lastLoadedTimelineAtByChannelRef.current = {};
  }

  async function handlePasswordUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const nextPassword = newPassword.trim();
    if (nextPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (nextPassword !== confirmPassword.trim()) {
      setError("New password and confirmation do not match.");
      return;
    }

    setAuthLoading(true);
    try {
      await apiFetch("/api/auth/profile", {
        method: "PATCH",
        headers: getApiHeaders(),
        body: JSON.stringify({
          username: username || loginUsername.trim(),
          newPassword: nextPassword
        })
      });
      setNewPassword("");
      setConfirmPassword("");
      await loadSession();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Unable to update password");
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeChannelId || activeChannel?.archivedAt || !activeChannelCanPost) return;
    if (uploadingAttachmentCount > 0 || multipleAgentTargets || sending) return;
    const trimmedText = draft.trim();
    if (!trimmedText && readyAttachments.length === 0) return;

    setSending(true);
    setError(null);
    try {
      const effectiveText =
        trimmedText ||
        `Attached ${readyAttachments.length} file${readyAttachments.length === 1 ? "" : "s"} for reference.`;
      const leading=draft.length-draft.trimStart().length;
      const selected=draftState.mentions.map(m=>({...m,start:m.start-leading,end:m.end-leading}));
      const message={channelId:activeChannelId,text:effectiveText,mentions:selected,attachments:readyAttachments.map(({fileId,name,mime,size})=>({fileId,name,mime,size}))};
      const fingerprint=JSON.stringify(message);
      if(sendRequestRef.current?.fingerprint!==fingerprint)sendRequestRef.current={fingerprint,id:crypto.randomUUID()};
      const request=sendRequestRef.current;
      const saved:ChatDraft={...draftState,attachments:message.attachments,request};
      if(userId)setDraftStored(saveChatDraft(userId,activeChannelId,saved));
      await apiFetch('/api/messages',{method:'POST',headers:getApiHeaders(),body:JSON.stringify({id:request.id,...message})});
      if(userId)clearSentDraft(userId,activeChannelId,saved);
      if(activeChannelIdRef.current!==activeChannelId)return;
      if(activeChannelIdRef.current===activeChannelId){
        if(sendRequestRef.current?.id===request.id)sendRequestRef.current=null;
        setDraftState({text:'',mentions:[]});setPendingAttachments([]);
      }
      setHasNewMessagesBelow(false);
      if (wsConnected) {
        scrollMessagesToBottom();
      } else {
        await loadMessages(activeChannelId, { scrollToBottom: true });
      }
      window.requestAnimationFrame(() => {
        scrollMessagesToBottom("auto");
        composerTextareaRef.current?.scrollIntoView({ block: "nearest" });
      });
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Unable to send message");
    } finally {
      setSending(false);
    }
  }

  function addConversationAgent(agentName: string) {
    setSelectedConversationAgents((current) =>
      current.includes(agentName) ? current : [...current, agentName]
    );
    setAgentSearchQuery("");
  }

  function removeConversationAgent(agentName: string) {
    setSelectedConversationAgents((current) => current.filter((name) => name !== agentName));
  }

  async function refreshChannels(nextActiveChannelId?: string | null) {
    const nextChannels = await apiJson<Channel[]>("/api/channels?includeArchived=1");
    setChannels(nextChannels);
    const visibleChannels = nextChannels.filter((channel) =>
      channelVisibleToUserUi(channel, userId, username, viewerTeamIds)
    );
    const nextSelectedChannelId =
      nextActiveChannelId !== undefined
        ? nextActiveChannelId
        : activeChannelId &&
            visibleChannels.some((channel) => channel.id === activeChannelId && !channel.archivedAt)
          ? activeChannelId
          : visibleChannels.find((channel) => !channel.archivedAt)?.id ?? null;
    if (view === "projects" && projectIndex.some(project => project.id === selectedProject && project.channelId === nextSelectedChannelId) && visibleChannels.some(channel => channel.id === nextSelectedChannelId && !channel.archivedAt)) {
      setActiveChannelId(nextSelectedChannelId);
    } else selectChannel(nextSelectedChannelId, { replace: true });
    return nextChannels;
  }

  async function handleStartConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = conversationName.trim();
    const description = conversationDescription.trim();
    const selectedAgents = selectedConversationAgents.filter(Boolean);
    setError(null);

    if (!name && selectedAgents.length !== 1) {
      setError("Choose one agent for a direct message, or add a channel name.");
      return;
    }

    setLoading(true);
    try {
      if (!name) {
        const direct = await apiJson<{ id: string }>("/api/channels/direct/human-agent", {
          method: "POST",
          headers: getApiHeaders(),
          body: JSON.stringify({ agentName: selectedAgents[0] })
        });
        setCollapsedChannelGroups((current) => ({ ...current, direct: false }));
        await refreshChannels(direct.id);
      } else {
        const created = await apiJson<{ id: string }>("/api/channels", {
          method: "POST",
          headers: getApiHeaders(),
          body: JSON.stringify({
            name,
            description: description || undefined,
            visibility: conversationVisibility
          })
        });
        await Promise.all([
          username
            ? apiFetch(`/api/channels/${encodeURIComponent(created.id)}/subscribe`, {
                method: "POST",
                headers: getApiHeaders(),
                body: JSON.stringify({ subscriberType: "HUMAN", subscriberId: username })
              }).catch(() => undefined)
            : Promise.resolve(),
          ...selectedAgents.map((agentName) =>
            apiFetch(`/api/channels/${encodeURIComponent(created.id)}/subscribe`, {
              method: "POST",
              headers: getApiHeaders(),
              body: JSON.stringify({ subscriberType: "AGENT", subscriberId: agentName })
            })
          )
        ]);
        setCollapsedChannelGroups((current) => ({ ...current, channels: false }));
        await refreshChannels(created.id);
      }
      setConversationName("");
      setConversationDescription("");
      setSelectedConversationAgents([]);
      setConversationVisibility("PRIVATE");
      setAgentSearchQuery("");
      setChannelQuery("");
      setShowConversationDialog(false);
    } catch (conversationError) {
      setError(
        conversationError instanceof Error
          ? conversationError.message
          : "Unable to start conversation"
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteChannel(channel: Channel) {
    if (!window.confirm(`Permanently delete ${channelLabel(channel, username)}?`)) return;
    setError(null);
    setLoading(true);
    try {
      await apiFetch(`/api/channels/${encodeURIComponent(channel.id)}`, { method: "DELETE" });
      await refreshChannels(activeChannelId === channel.id ? null : undefined);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete channel");
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveChannelSettings() {
    if (!activeChannel) return;
    setUpdatingChannelVisibility(true);
    setError(null);
    try {
      const currentVisibility = activeChannel.visibility === "PUBLIC" ? "PUBLIC" : "PRIVATE";
      if (channelVisibilityDraft !== currentVisibility) {
        await apiFetch(`/api/channels/${encodeURIComponent(activeChannel.id)}`, {
          method: "PATCH",
          headers: getApiHeaders(),
          body: JSON.stringify({ visibility: channelVisibilityDraft })
        });
      }
      const currentlyArchived = Boolean(activeChannel.archivedAt);
      if (archiveDraft !== currentlyArchived) {
        await apiFetch(
          `/api/channels/${encodeURIComponent(activeChannel.id)}/${archiveDraft ? "archive" : "unarchive"}`,
          { method: "POST" }
        );
        if (archiveDraft) setShowArchivedChannels(true);
      }
      await refreshChannels(activeChannel.id);
      setShowChannelManageDialog(false);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Unable to update channel settings");
    } finally {
      setUpdatingChannelVisibility(false);
    }
  }

  async function handleAddParticipant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeChannelId || !participantValue.trim()) return;
    setParticipantSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/api/channels/${encodeURIComponent(activeChannelId)}/subscribe`, {
        method: "POST",
        headers: getApiHeaders(),
        body: JSON.stringify({
          subscriberType: participantKind,
          subscriberId: participantValue.trim()
        })
      });
      await refreshChannels(activeChannelId);
      setParticipantValue("");
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Unable to add participant");
    } finally {
      setParticipantSubmitting(false);
    }
  }

  async function handleRemoveParticipant(participant: ChannelParticipant) {
    if (!activeChannelId) return;
    const participantKey = `${participant.subscriberType}:${participant.subscriberId}`;
    setParticipantRemovingKey(participantKey);
    setError(null);
    try {
      await apiFetch(`/api/channels/${encodeURIComponent(activeChannelId)}/unsubscribe`, {
        method: "POST",
        headers: getApiHeaders(),
        body: JSON.stringify({
          subscriberType: participant.subscriberType,
          subscriberId: participant.subscriberId
        })
      });
      await refreshChannels(activeChannelId);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Unable to remove participant");
    } finally {
      setParticipantRemovingKey(null);
    }
  }

  async function handleAddShare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeChannelId || !shareValue.trim()) return;
    setShareSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/api/channels/${encodeURIComponent(activeChannelId)}/share`, {
        method: "POST",
        headers: getApiHeaders(),
        body: JSON.stringify({
          viewerType: shareKind,
          viewerId: shareValue.trim()
        })
      });
      await refreshChannels(activeChannelId);
      setShareValue("");
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : "Unable to share channel");
    } finally {
      setShareSubmitting(false);
    }
  }

  async function handleRemoveShare(share: ChannelShare) {
    if (!activeChannelId) return;
    const shareKey = `${share.viewerType}:${share.viewerId}`;
    setShareRemovingKey(shareKey);
    setError(null);
    try {
      await apiFetch(`/api/channels/${encodeURIComponent(activeChannelId)}/unshare`, {
        method: "POST",
        headers: getApiHeaders(),
        body: JSON.stringify({
          viewerType: share.viewerType,
          viewerId: share.viewerId
        })
      });
      await refreshChannels(activeChannelId);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Unable to remove shared viewer");
    } finally {
      setShareRemovingKey(null);
    }
  }

  function handleMessagesScroll() {
    if (hasNewMessagesBelow && isMessagesPanelNearBottom()) {
      setHasNewMessagesBelow(false);
    }
  }

  async function handleCopyShareLink() {
    if (!activeChannelId) return;
    try {
      const created = await apiJson<{ token: string; channelId: string }>(
        `/api/channels/${encodeURIComponent(activeChannelId)}/share-link`,
        {
          method: "POST",
          headers: getApiHeaders()
        }
      );
      const url = new URL(window.location.href);
      url.searchParams.set("share", created.token);
      url.searchParams.set("channel", created.channelId);
      const shareLink = url.toString();
      await navigator.clipboard.writeText(shareLink);
      setShareLinkCopied(true);
      window.setTimeout(() => setShareLinkCopied(false), 2000);
    } catch {
      setError("Unable to copy link. Please copy it from the address bar.");
    }
  }

  async function uploadSingleFile(file: File) {
    const localId = createLocalAttachmentId();
    const mime = file.type || "application/octet-stream";
    setPendingAttachments((current) => [
      ...current,
      {
        localId,
        name: file.name || "upload",
        mime,
        size: file.size,
        status: "uploading"
      }
    ]);
    try {
      const body = new FormData();
      body.append("file", file, file.name);
      const uploadResponse = await apiFetch("/api/files", { method: "POST", body });
      const uploadPayload = (await uploadResponse.json()) as { id: string };
      const meta = await apiJson<{
        id: string;
        original_name?: string;
        mime?: string;
        size?: number;
        sha256?: string;
      }>(`/api/files/${encodeURIComponent(uploadPayload.id)}/meta`);
      const uploaded: UploadedAttachment = {
        localId,
        fileId: uploadPayload.id,
        name: meta.original_name || file.name || "upload",
        mime: meta.mime || mime,
        size: typeof meta.size === "number" ? meta.size : file.size,
        ...(typeof meta.sha256 === "string" && meta.sha256 ? { sha256: meta.sha256 } : {})
      };
      setPendingAttachments((current) =>
        current.map((item) =>
          item.localId === localId
            ? {
                ...item,
                name: uploaded.name,
                mime: uploaded.mime,
                size: uploaded.size,
                status: "ready",
                uploaded,
                error: undefined
              }
            : item
        )
      );
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : "Upload failed";
      setPendingAttachments((current) =>
        current.map((item) =>
          item.localId === localId ? { ...item, status: "error", error: message } : item
        )
      );
    }
  }

  function uploadFiles(files: File[]) {
    for (const file of files) {
      void uploadSingleFile(file);
    }
  }

  function handlePickFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    uploadFiles(files);
    event.currentTarget.value = "";
  }

  function resizeComposerTextarea(textarea?: HTMLTextAreaElement | null) {
    const target = textarea ?? composerTextareaRef.current;
    if (!target) return;
    const viewportMax = isConversationEmpty
      ? Math.max(56, Math.floor(window.innerHeight / 8))
      : Math.max(120, Math.floor(window.innerHeight / 3));
    const minHeight = isConversationEmpty ? 34 : 56;
    target.style.maxHeight = `${viewportMax}px`;
    target.style.height = "auto";
    const nextHeight = Math.min(target.scrollHeight, viewportMax);
    target.style.height = `${Math.max(minHeight, nextHeight)}px`;
    target.style.overflowY = target.scrollHeight > viewportMax ? "auto" : "hidden";
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(event.clipboardData.items ?? []);
    const imageFiles = items
      .map((item) => {
        if (!item.type.startsWith("image/")) return null;
        return item.getAsFile();
      })
      .filter((file): file is File => Boolean(file));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    const filesToUpload = imageFiles.map((image) => {
      const ext = image.type.includes("/") ? image.type.split("/")[1] : "png";
      const safeExt = ext.replace(/[^a-zA-Z0-9]/g, "") || "png";
      const filename = `pasted-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${safeExt}`;
      return new File([image], filename, { type: image.type || "image/png" });
    });
    uploadFiles(filesToUpload);
  }

  useEffect(() => {
    resizeComposerTextarea();
  }, [draft, isConversationEmpty, activeChannelId]);

  useEffect(() => {
    function handleWindowResize() {
      resizeComposerTextarea();
    }
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, []);

  if (authLoading && !authenticated) {
    return <main className="loading-screen" role="status">Loading workspace…</main>;
  }

  if (!authenticated) {
    return (
      <main className="login-screen">
        <section className="login-copy">
          <InstanceBrand />
          <p>Your {branding.displayName} workspace</p>
          <h1>Great work starts here.</h1>
          <span>One workspace for your people, your agents, and what comes next.</span>
          <PoweredByNest />
        </section>

        <form className="login-card" onSubmit={handleLogin}>
          <ThemeToggle />
          <div>
            <span>Welcome back</span>
            <strong>Sign in to {branding.displayName}</strong>
          </div>
          <GoogleSignIn apiUrl={apiUrl} />
          {error ? <div className="notice error" role="alert">{error}</div> : null}
          <label>
            Username
            <input
              value={loginUsername}
              onChange={(event) => setLoginUsername(event.target.value)}
              autoComplete="username"
            />
          </label>
          <label>
            Password
            <input
              value={loginPassword}
              onChange={(event) => setLoginPassword(event.target.value)}
              type="password"
              autoComplete="current-password"
            />
          </label>
          <button disabled={!loginUsername.trim() || !loginPassword || authLoading}>
            {authLoading ? "Signing in..." : "Continue"}
          </button>
        </form>
      </main>
    );
  }

  if (mustChangePassword) {
    return (
      <main className="login-screen">
        <section className="login-copy">
          <InstanceBrand />
          <p>Your {branding.displayName} workspace</p>
          <h1>Set a new password</h1>
          <span>Finish first-time setup before opening your workspace.</span>
          <PoweredByNest />
        </section>

        <form className="login-card" onSubmit={handlePasswordUpdate}>
          <ThemeToggle />
          <div>
            <span>First login</span>
            <strong>{username || branding.displayName}</strong>
          </div>
          <p className="login-hint">
            Your temporary password worked. Choose a new password with at least 8 characters.
          </p>
          {error ? <div className="notice error" role="alert">{error}</div> : null}
          <label>
            New password
            <input
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              type="password"
              autoComplete="new-password"
            />
          </label>
          <label>
            Confirm new password
            <input
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              type="password"
              autoComplete="new-password"
            />
          </label>
          <button
            disabled={
              newPassword.trim().length < 8 ||
              newPassword.trim() !== confirmPassword.trim() ||
              authLoading
            }
          >
            {authLoading ? "Updating..." : "Update password"}
          </button>
          <button className="secondary-button" type="button" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </form>
      </main>
    );
  }

  const chatWorkspace = <section className={`workspace${view === "workspace" ? " standalone-workspace" : ""}`}>
        {view === "workspace" && <WorkspaceTopbar
          onMenu={() => setMobileSidebarOpen(true)}
          search={<label className="dashboard-search"><DesignIcon name="search" /><input
            aria-label="Search channels" placeholder="Search channels…" value={channelQuery}
            onChange={event => setChannelQuery(event.target.value)}
          /></label>}
        />}
        <header className="workspace-header">
          <div>
            <span>Workspace</span>
            <div className="workspace-title-row">
              <h1>{channelLabel(activeChannel, username)}</h1>
            </div>
            <p>
              {activeChannel?.archivedAt
                ? "Archived channel"
                : activeChannel && !activeChannelCanPost
                  ? "Read-only shared channel"
                : activeChannel?.description || "Talk to the team and agents in plain language."}
            </p>
          </div>
          {activeChannel && activeChannelManageable ? (
            <div className="channel-actions">
              <button type="button" onClick={() => setShowChannelManageDialog(true)}>
                Manage channel
              </button>
            </div>
          ) : null}
        </header>

        {error ? <div className="notice error" role="alert">{error}</div> : null}
        {loading ? <div className="notice">Loading workspace…</div> : null}

        <section className="chat-stack">
          <section
            className={`messages-panel${isConversationEmpty ? " messages-panel-empty" : ""}`}
            ref={messagesPanelRef}
            onScroll={handleMessagesScroll}
          >
            {!messagesLoading && hasOlderMessages ? (
              <button
                className="load-older-button"
                disabled={loadingOlderMessages}
                onClick={() => void handleLoadOlderMessages()}
              >
                {loadingOlderMessages ? "Loading previous messages..." : "Load previous messages"}
              </button>
            ) : null}
            {messagesLoading ? (
              <div className="empty-state">
                <strong>Loading messages...</strong>
                <p>Fetching the latest channel activity.</p>
              </div>
            ) : timelineItems.length === 0 ? (
              <div className="empty-state">
                <strong>No messages yet</strong>
                <p>Send a short update or request to start the conversation.</p>
              </div>
            ) : (
              timelineItems.map((item) => {
                if (item.kind === "message") {
                  const event = item.event;
                  const role = messageRole(event.source);
                  const attachments = parseMessageAttachments(event.payload);
                  const text = messageText(event);
                  const markdown = shouldRenderMarkdown(text);
                  return (
                    <article tabIndex={focusedMessage===event.id?-1:undefined} id={`message-${event.id}`} className={`message message-${role}${focusedMessage===event.id?" message-highlight":""}`} key={item.id}>
                      <div className="message-meta">
                        <strong>{sourceLabel(event.source)}</strong>
                        <span>{formatTime(messageDisplayTime(event))}</span>
                      </div>
                      {Boolean(event.payload)&&typeof event.payload==='object'&&event.payload!==null&&'targetAgentName' in event.payload&&<span className="message-target">To @{String(event.payload.targetAgentName)}</span>}
                      {markdown ? (
                        <div className="message-markdown">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              a: ({ node: _node, ...props }) => (
                                <a {...props} target="_blank" rel="noreferrer" />
                              )
                            }}
                          >
                            {text}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <p>{text}</p>
                      )}
                      {attachments.length > 0 ? (
                        <div className="message-attachments">
                          <strong>Attachments</strong>
                          <ul>
                            {attachments.map((attachment, index) => {
                              const sizeLabel = formatAttachmentSize(attachment.size);
                              const mimeLabel = attachment.mime ? attachment.mime : "";
                              return (
                                <li key={`${event.id}-attachment-${index}`}>
                                  <a href={`/api/files/${encodeURIComponent(attachment.fileId)}`} target="_blank" rel="noreferrer">
                                    {attachment.name}
                                  </a>
                                  {mimeLabel || sizeLabel ? (
                                    <span>
                                      {mimeLabel}
                                      {mimeLabel && sizeLabel ? " • " : ""}
                                      {sizeLabel || ""}
                                    </span>
                                  ) : null}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ) : null}
                    </article>
                  );
                }
                const selectedEvent = item.traceEvents.find((event) => event.id === expandedTraceEventId) ?? null;
                return (
                  <article className={`trace-group trace-group-${item.tone}`} key={item.id}>
                    <div className="trace-chips" role="list" aria-label="Agent activity trace">
                      {item.traceEvents.map((event) => {
                        const selected = event.id === expandedTraceEventId;
                        const summary = traceTitle(event);
                        return (
                          <button
                            key={event.id}
                            className={`trace-chip trace-chip-${traceChipTone(event)} ${
                              selected ? "trace-chip-active" : ""
                            }`}
                            title={`${summary}${event.createdAt ? ` • ${formatTime(event.createdAt)}` : ""}`}
                            type="button"
                            onClick={() =>
                              setExpandedTraceEventId((current) => (current === event.id ? null : event.id))
                            }
                            aria-label={summary}
                          >
                            <span>{traceChipCode(event)}</span>
                          </button>
                        );
                      })}
                    </div>
                    {selectedEvent ? (
                      <div className="trace-detail-card">
                        <div className="trace-detail-meta">
                          <strong>{traceTitle(selectedEvent)}</strong>
                          <span>{formatTime(selectedEvent.createdAt)}</span>
                        </div>
                        {traceDetail(selectedEvent) ? (
                          <pre>{traceDetail(selectedEvent)}</pre>
                        ) : (
                          <p>No additional details.</p>
                        )}
                      </div>
                    ) : null}
                  </article>
                );
              })
            )}
          </section>

          {hasNewMessagesBelow ? (
            <button
              className="new-messages-button"
              onClick={() => {
                setHasNewMessagesBelow(false);
                scrollMessagesToBottom();
              }}
            >
              New messages below
            </button>
          ) : null}

          <form className={`composer${isConversationEmpty ? " composer-compact" : ""}`} onSubmit={handleSubmit}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="composer-file-input"
            onChange={handlePickFiles}
          />
          {pendingAttachments.length > 0 ? (
            <div className="composer-attachments">
              {pendingAttachments.map((attachment) => (
                <article key={attachment.localId}>
                  <div>
                    <strong>{attachment.name}</strong>
                    <span>
                      {attachment.status === "ready"
                        ? `Ready${formatAttachmentSize(attachment.size) ? ` • ${formatAttachmentSize(attachment.size)}` : ""}`
                        : attachment.status === "uploading"
                          ? "Uploading..."
                          : attachment.error || "Upload failed"}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="composer-attachment-remove"
                    onClick={() =>
                      setPendingAttachments((current) =>
                        current.filter((item) => item.localId !== attachment.localId)
                      )
                    }
                  >
                    Remove
                  </button>
                </article>
              ))}
            </div>
          ) : null}
          <div className="mention-input">
          {mentions.popup}
          <textarea
            {...mentions.textareaProps}
            aria-label="Message"
            ref={composerTextareaRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              mentions.sync(event.currentTarget);
              resizeComposerTextarea(event.currentTarget);
            }}
            onPaste={handleComposerPaste}
            onKeyDown={(event) => {
              if (mentions.onKeyDown(event)) return;
              if (event.keyCode === 229) return;
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={
              activeChannel?.archivedAt
                ? "Restore this channel to send messages"
                : activeChannel && !activeChannelCanPost
                  ? "This channel is shared with you as read-only"
                : activeChannel
                  ? isConversationEmpty
                    ? `Message ${activeConversationName}`
                    : `Message ${activeConversationName} (Enter to send, Shift+Enter for newline)`
                  : "Select a channel first"
            }
            disabled={!activeChannel || Boolean(activeChannel.archivedAt) || !activeChannelCanPost || sending}
            rows={isConversationEmpty ? 1 : 3}
          />
          </div>
          {draftRecipients.length>0&&<div className="mention-delivery" aria-label="Message recipients">{draftRecipients.map(m=><span key={m.kind+':'+m.name}>{m.kind==='AGENT'?'Ask':'Notify'} @{m.name}<button type="button" aria-label={'Remove mention @'+m.name} onClick={()=>{const spans=draftState.mentions.filter(x=>x.kind===m.kind&&x.name===m.name).sort((a,b)=>b.start-a.start);let next=draft;for(const span of spans)next=next.slice(0,span.start)+next.slice(span.end);setDraft(next);}}>×</button></span>)}</div>}
          {draft.trim()&&<span className="draft-storage-status" role="status">{draftStored?'Draft saved on this device':'Draft storage is unavailable. Keep this tab open until you send.'}</span>}
          {multipleAgentTargets?<p className="mention-delivery-error" role="alert">Choose one agent target per message. You can notify multiple people.</p>:<p className="mention-delivery-hint">{draftRecipients.some(m=>m.kind==='AGENT')?'Only the selected agent receives this request.':'Select an @mention to direct a request or notify a person.'}</p>}
          <div className="composer-actions">
            <button
              type="button"
              className="composer-secondary"
              disabled={!activeChannel || Boolean(activeChannel.archivedAt) || !activeChannelCanPost || sending}
              onClick={() => fileInputRef.current?.click()}
            >
              Attach files
            </button>
            <button
              disabled={
                !activeChannel ||
                Boolean(activeChannel.archivedAt) ||
                !activeChannelCanPost ||
                sending || multipleAgentTargets ||
                uploadingAttachmentCount > 0 ||
                (!draft.trim() && readyAttachments.length === 0)
              }
            >
              {uploadingAttachmentCount > 0
                ? `Uploading ${uploadingAttachmentCount}...`
                : sending
                  ? "Sending..."
                  : "Send"}
            </button>
          </div>
          {hasAttachmentErrors ? (
            <p className="composer-attachment-error">
              One or more attachments failed to upload. Remove them or retry.
            </p>
          ) : null}
          </form>
        </section>
      </section>;
  const chatMembers = <aside className="activity-panel">
        <section className="participants-card">
          <div className="participants-header-row">
            <h2>Participants</h2>
          </div>
          <div className="participant-list">
            {activeChannel?.participants?.map((participant, index) => {
              const agentStatus = participantAgentStatus(participant, agents);
              return (
                <article key={`${participant.subscriberType}:${participant.subscriberId}:${index}`}>
                  {normalizedSubscriberType(participant) === "AGENT" ? <AgentAvatar name={participant.subscriberId} size={34} /> : <div className="participant-avatar">{participantName(participant).slice(0, 2)}</div>}
                  <div>
                    <strong>
                      {agentStatus ? (
                        <i
                          className={`agent-status-dot agent-status-${agentStatus}`}
                          title={agentStatus === "running" ? "Agent running" : "Agent off"}
                        />
                      ) : null}
                      {participantName(participant)}
                    </strong>
                    <span>{participantType(participant)}</span>
                  </div>
                </article>
              );
            })}
            {!activeChannel?.participants?.length ? (
              <p>No participants listed for this channel.</p>
            ) : null}
          </div>
          <div className="shared-viewer-list">
            <h3>Shared viewers</h3>
            {activeChannel?.shares?.map((share, index) => (
              <article key={`${share.viewerType}:${share.viewerId}:${index}`}>
                <div className="participant-avatar">{share.viewerId.slice(0, 2) || "SV"}</div>
                <div>
                  <strong>{share.viewerId}</strong>
                  <span>{shareTypeLabel(share)}</span>
                </div>
              </article>
            ))}
            {!activeChannel?.shares?.length ? <p>No shared viewers.</p> : null}
          </div>
        </section>

        <section>
          <h2>Recent Activity</h2>
          {agentIsThinking ? <p className="thinking-indicator">Agent is thinking...</p> : null}
          <div className="activity-list">
            {events.slice(-6).reverse().map((event) => (
              <article key={event.id}>
                <strong>{sourceLabel(event.source)}</strong>
                <span>{event.type.replaceAll(".", " ")}</span>
              </article>
            ))}
            {events.length === 0 ? <p>No recent activity in this channel.</p> : null}
          </div>
        </section>
      </aside>;

  return (
    <AgentAvatarChoices value={Object.fromEntries(agents.map(agent=>[agent.name, agent.icon]))}><WorkspaceHeaderProvider channelLabel={(id,fallback)=>projectIndex.find(project=>project.channelId===id)?.name ?? fallback} username={username} onAgents={()=>selectAgent(null)} onSignOut={()=>void handleLogout()} onMention={(channelId,eventId)=>{selectChannel(channelId);setFocusedMessage(eventId);const url=new URL(window.location.href);url.searchParams.set('message',eventId);window.history.replaceState(null,'',url);}}><main className={`app-shell product-shell ${view !== "workspace" ? "dashboard-shell" : ""}`}>
      <aside className={`sidebar ${mobileSidebarOpen ? "sidebar-mobile-open" : ""}`}>
        <button
          type="button"
          className="sidebar-mobile-close"
          onClick={() => setMobileSidebarOpen(false)}
        >
          Close
        </button>
        <InstanceBrand />
        <nav className="product-nav" aria-label="Main navigation">
          <button aria-current={view === "dashboard" ? "page" : undefined} onClick={() => selectChannel(null)}><DesignIcon name="dashboard" />Dashboard</button>
          <ProjectNavigation projects={projectIndex} currentProjectId={view === "projects" ? selectedProject : null} inProjects={view === "projects" || view === "workspace"} creating={view === "projects" && !selectedProject && projectTab === "new"} unreadCounts={unreadCounts} onBrowse={() => selectProject(null)} onSelect={id => selectProject(id)} onCreate={() => selectProject(null, null, "new")} />
          <button aria-current={view === "agents" ? "page" : undefined} onClick={() => selectAgent(null)}><DesignIcon name="agents" />Agents</button>
          <button aria-current={view === "community" ? "page" : undefined} onClick={()=>selectCommunity(null)}><DesignIcon name="community" />Community</button>
        </nav>

        {view === "workspace" && <section className="sidebar-section">
          <div className="channel-list">
            {groupedChannels.map((group) => {
              const isCollapsed = !isSearchingChannels && collapsedChannelGroups[group.id];
              return (
                <section className="channel-group" key={group.id}>
                  <button
                    type="button"
                    className="channel-group-toggle"
                    aria-expanded={!isCollapsed}
                    onClick={() =>
                      setCollapsedChannelGroups((current) => ({
                        ...current,
                        [group.id]: !current[group.id]
                      }))
                    }
                  >
                    <span>{group.label}</span>
                    <em>{group.channels.length}</em>
                    <strong>{isCollapsed ? "+" : "-"}</strong>
                  </button>

                  {!isCollapsed ? (
                    <div className="channel-group-items">
                      {group.channels.map((channel) => (
                        <button
                          key={channel.id}
                          aria-current={channel.id === activeChannelId ? "page" : undefined}
                          className={channel.id === activeChannelId ? "active" : undefined}
                          onClick={() => selectChannel(channel.id)}
                        >
                          <span>{channelLabel(channel, username)}</span>
                          {unreadCounts[channel.id] ? <em>{unreadCounts[channel.id]}</em> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            })}
            {filteredArchivedChannels.length > 0 ? (
              <section className="channel-group">
                <button
                  type="button"
                  className="channel-group-toggle"
                  aria-expanded={isSearchingChannels || showArchivedChannels}
                  onClick={() => setShowArchivedChannels((current) => !current)}
                >
                  <span>Archived</span>
                  <em>{filteredArchivedChannels.length}</em>
                  <strong>{isSearchingChannels || showArchivedChannels ? "-" : "+"}</strong>
                </button>

                {isSearchingChannels || showArchivedChannels ? (
                  <div className="channel-group-items archived-channel-items">
                    {filteredArchivedChannels.map((channel) => (
                      <button
                        key={channel.id}
                        aria-current={channel.id === activeChannelId ? "page" : undefined}
                          className={channel.id === activeChannelId ? "active" : undefined}
                        onClick={() => selectChannel(channel.id)}
                      >
                        <span>{channelLabel(channel, username)}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
            {!loading &&
            channelQuery.trim() &&
            filteredChannels.length === 0 &&
            filteredArchivedChannels.length === 0 ? (
              <p className="channel-empty">No channels match "{channelQuery.trim()}".</p>
            ) : null}
          </div>
        </section>}

        <div className="instance-sidebar-footer dashboard-attribution"><span>Powered by</span><DesignIcon name="nest-mark" /><img src={`${import.meta.env.BASE_URL}design/nest-wordmark.svg`} alt="Nest" /></div>
      </aside>
      {mobileSidebarOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="sidebar-mobile-backdrop"
          onClick={() => setMobileSidebarOpen(false)}
        />
      ) : null}

      {view === "community" ? <Community skillName={selectedCommunitySkill} onSelect={selectCommunity} onMenu={()=>setMobileSidebarOpen(true)} agents={visibleAgents}/> : view === "projects" ? <Projects participants={activeChannel?.participants ?? []} userId={userId ?? ""} existingChats={standaloneChannels.map(channel => ({id:channel.id,name:channelLabel(channel, username),archived:!!channel.archivedAt}))} onChat={selectChannel} projectId={selectedProject} taskId={selectedTask} tab={projectTab} agents={visibleAgents} onSelect={selectProject} onLoaded={onProjectLoaded} onMenu={() => setMobileSidebarOpen(true)} chat={chatWorkspace} onMembersChanged={async()=>{await refreshChannels();}} onManage={activeChannelManageable?()=>setShowChannelManageDialog(true):undefined} /> : view === "agents" ? <Agents requestLocation={requestLocation} onRequests={(id,assistant)=>selectAgent(null,{requests:true,request:id,assistant})} setup={personalSetup} creating={creatingPersonalAgent} onCreate={()=>selectAgent(null,{create:true})} onCreated={name=>{selectAgent(name);void loadShell();}} onChat={selectChannel} agents={visibleAgents} name={selectedAgent} userId={userId} loading={loading} error={error} onSelect={selectAgent} onMenu={() => setMobileSidebarOpen(true)} onRetry={() => void loadShell()} onSaved={updated => setAgents(current => current.map(agent => agent.name === updated.name ? { ...agent, ...updated } : agent))} /> : view === "dashboard" ? <Dashboard
        resumeProject={userId?projectIndex.find(p=>p.id===recentProject(userId)):undefined} channels={visibleChannels} projects={projectIndex} onProject={selectProject} unreadCounts={unreadCounts} onCommunity={selectCommunity}
        loading={loading} error={error} label={channel => channelLabel(channel, username)}
        onSelect={selectChannel} onCreate={() => selectProject(null, null, "new")}
        onMenu={() => setMobileSidebarOpen(true)} onRetry={() => void loadShell()}
      /> : <>{chatWorkspace}{chatMembers}</>}

      {showConversationDialog ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setShowConversationDialog(false)}>
          <section
            aria-modal="true"
            className="conversation-dialog"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>Start conversation</span>
                <h2>New conversation</h2>
              </div>
              <button
                aria-label="Close dialog"
                className="dialog-close"
                onClick={() => setShowConversationDialog(false)}
              >
                Close
              </button>
            </header>
            <form className="conversation-form" onSubmit={handleStartConversation}>
              <label>
                <span>Channel name</span>
                <input
                  autoFocus
                  value={conversationName}
                  onChange={(event) => setConversationName(event.target.value)}
                  placeholder="Leave blank for a DM"
                />
              </label>
              <label>
                <span>Description</span>
                <input
                  value={conversationDescription}
                  onChange={(event) => setConversationDescription(event.target.value)}
                  placeholder="Optional"
                />
              </label>
              <label>
                <span>Visibility</span>
                <select
                  value={conversationVisibility}
                  onChange={(event) =>
                    setConversationVisibility(event.target.value === "PUBLIC" ? "PUBLIC" : "PRIVATE")
                  }
                >
                  <option value="PRIVATE">Private</option>
                  <option value="PUBLIC">Public</option>
                </select>
              </label>
              <div className="agent-combobox">
                <span>Agents</span>
                {selectedConversationAgentRecords.length > 0 ? (
                  <div className="selected-agent-chips">
                    {selectedConversationAgentRecords.map((agent) => (
                      <button
                        key={agent.name}
                        onClick={() => removeConversationAgent(agent.name)}
                        type="button"
                      >
                        {agent.name}
                        <span>Remove</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="agent-picker-hint">Select one agent for a DM, or many for a channel.</p>
                )}
                <label className="agent-search-field">
                  <span>Search agents</span>
                  <input
                    value={agentSearchQuery}
                    onChange={(event) => setAgentSearchQuery(event.target.value)}
                    placeholder="Type an agent name..."
                  />
                </label>
                {visibleAgents.length === 0 ? (
                  <p className="sidebar-note">No available agents.</p>
                ) : agentSuggestions.length > 0 ? (
                  <div className="agent-suggestions">
                    {agentSuggestions.map((agent) => (
                      <button
                        key={agent.name}
                        onClick={() => addConversationAgent(agent.name)}
                        type="button"
                      >
                        <span>{agent.name}</span>
                        <em>{agent.runtimeState === "RUNNING" ? "Running" : "Off"}</em>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="agent-picker-hint">No matching agents.</p>
                )}
              </div>
              <button disabled={loading || !canStartConversation}>Start</button>
            </form>
          </section>
        </div>
      ) : null}

      {showParticipantsDialog && activeChannel && activeChannelManageable ? (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={() => setShowParticipantsDialog(false)}
        >
          <section
            aria-modal="true"
            className="conversation-dialog participants-dialog"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>Channel controls</span>
                <h2>Manage participants</h2>
              </div>
              <button
                aria-label="Close dialog"
                className="dialog-close"
                onClick={() => setShowParticipantsDialog(false)}
                type="button"
              >
                Close
              </button>
            </header>

            <form className="participant-form" onSubmit={handleAddParticipant}>
              <select
                value={participantKind}
                onChange={(event) => setParticipantKind(event.target.value === "HUMAN" ? "HUMAN" : "AGENT")}
                disabled={participantSubmitting}
              >
                <option value="AGENT">Agent</option>
                <option value="HUMAN">Human</option>
              </select>
              <input
                list={participantKind === "AGENT" ? "agent-participant-options" : "human-participant-options"}
                placeholder={participantKind === "AGENT" ? "agent name" : "username"}
                value={participantValue}
                onChange={(event) => setParticipantValue(event.target.value)}
                disabled={participantSubmitting}
              />
              <button type="submit" disabled={participantSubmitting || !participantValue.trim()}>
                {participantSubmitting ? "Adding..." : "Add"}
              </button>
              <datalist id="agent-participant-options">
                {visibleAgents.map((agent) => (
                  <option key={agent.name} value={agent.name} />
                ))}
              </datalist>
              <datalist id="human-participant-options">
                {humans.map((human) => (
                  <option key={human.username} value={human.username} />
                ))}
              </datalist>
            </form>

            <div className="participants-dialog-list">
              {(activeChannel.participants ?? []).map((participant, index) => {
                const participantKey = `${participant.subscriberType}:${participant.subscriberId}`;
                return (
                  <article key={`${participant.subscriberType}:${participant.subscriberId}:${index}`}>
                    <div>
                      <strong>{participantName(participant)}</strong>
                      <span>{participantType(participant)}</span>
                    </div>
                    <button
                      className="participant-remove-button"
                      onClick={() => void handleRemoveParticipant(participant)}
                      disabled={participantRemovingKey === participantKey}
                      title={`Remove ${participantName(participant)}`}
                      type="button"
                    >
                      {participantRemovingKey === participantKey ? "Removing..." : "Remove"}
                    </button>
                  </article>
                );
              })}
              {(activeChannel.participants ?? []).length === 0 ? (
                <p>No participants yet.</p>
              ) : null}
            </div>

            <header>
              <div>
                <span>Read-only sharing</span>
                <h2>Shared viewers</h2>
              </div>
            </header>

            <form className="participant-form" onSubmit={handleAddShare}>
              <select
                value={shareKind}
                onChange={(event) => setShareKind(event.target.value === "AGENT" ? "AGENT" : "HUMAN")}
                disabled={shareSubmitting}
              >
                <option value="HUMAN">Human viewer</option>
                <option value="AGENT">Agent viewer</option>
              </select>
              <input
                list={shareKind === "AGENT" ? "agent-share-options" : "human-share-options"}
                placeholder={shareKind === "AGENT" ? "agent name" : "username"}
                value={shareValue}
                onChange={(event) => setShareValue(event.target.value)}
                disabled={shareSubmitting}
              />
              <button type="submit" disabled={shareSubmitting || !shareValue.trim()}>
                {shareSubmitting ? "Sharing..." : "Share"}
              </button>
              <datalist id="agent-share-options">
                {visibleAgents.map((agent) => (
                  <option key={agent.name} value={agent.name} />
                ))}
              </datalist>
              <datalist id="human-share-options">
                {humans.map((human) => (
                  <option key={human.username} value={human.username} />
                ))}
              </datalist>
            </form>

            <div className="participants-dialog-list">
              {(activeChannel.shares ?? []).map((share, index) => {
                const shareKey = `${share.viewerType}:${share.viewerId}`;
                return (
                  <article key={`${share.viewerType}:${share.viewerId}:${index}`}>
                    <div>
                      <strong>{share.viewerId}</strong>
                      <span>{shareTypeLabel(share)}</span>
                    </div>
                    <button
                      className="participant-remove-button"
                      onClick={() => void handleRemoveShare(share)}
                      disabled={shareRemovingKey === shareKey}
                      title={`Remove shared viewer ${share.viewerId}`}
                      type="button"
                    >
                      {shareRemovingKey === shareKey ? "Removing..." : "Remove"}
                    </button>
                  </article>
                );
              })}
              {(activeChannel.shares ?? []).length === 0 ? (
                <p>No shared viewers yet.</p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {showChannelManageDialog && activeChannel && activeChannelManageable ? (
        <div
          className={`dialog-backdrop${showParticipantsDialog ? " dialog-backdrop-underlay" : ""}`}
          role="presentation"
          onMouseDown={() => setShowChannelManageDialog(false)}
        >
          <section
            aria-modal="true"
            className="conversation-dialog participants-dialog"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>Channel settings</span>
                <h2>Manage channel</h2>
              </div>
              <button
                aria-label="Close dialog"
                className="dialog-close"
                onClick={() => setShowChannelManageDialog(false)}
                type="button"
              >
                Close
              </button>
            </header>

            <div className="channel-manage-grid">
              <label>
                <span>Visibility</span>
                <select
                  value={channelVisibilityDraft}
                  onChange={(event) =>
                    setChannelVisibilityDraft(event.target.value === "PUBLIC" ? "PUBLIC" : "PRIVATE")
                  }
                  disabled={updatingChannelVisibility}
                >
                  <option value="PRIVATE">Private</option>
                  <option value="PUBLIC">Public</option>
                </select>
              </label>

              <label className="archive-checkbox-row">
                <input
                  type="checkbox"
                  checked={archiveDraft}
                  onChange={(event) => setArchiveDraft(event.target.checked)}
                  disabled={updatingChannelVisibility}
                />
                <span>Archived</span>
              </label>
            </div>

            <div className="channel-manage-quick-actions">
              <button
                type="button"
                className="channel-manage-secondary-button"
                onClick={() => {
                  setShowParticipantsDialog(true);
                }}
                disabled={updatingChannelVisibility}
              >
                Manage participants
              </button>
              <button
                type="button"
                className="channel-manage-secondary-button"
                onClick={() => void handleCopyShareLink()}
                disabled={updatingChannelVisibility}
              >
                {shareLinkCopied ? "Link copied" : "Copy share link"}
              </button>
            </div>

            <button
              className="channel-manage-save-button"
              type="button"
              onClick={() => void handleSaveChannelSettings()}
              disabled={
                updatingChannelVisibility ||
                (channelVisibilityDraft === (activeChannel.visibility === "PUBLIC" ? "PUBLIC" : "PRIVATE") &&
                  archiveDraft === Boolean(activeChannel.archivedAt))
              }
            >
              {updatingChannelVisibility ? "Saving..." : "Save"}
            </button>

            <button
              className="channel-manage-delete-button"
              type="button"
              onClick={() => void handleDeleteChannel(activeChannel)}
              disabled={updatingChannelVisibility}
            >
              Delete channel
            </button>
          </section>
        </div>
      ) : null}
    </main></WorkspaceHeaderProvider></AgentAvatarChoices>
  );
}
