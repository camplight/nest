import {AgentNavigation, AgentWorkspaceTabs, type AgentTab} from './components/AgentNavigation';
import {conversationAgent, recentAgentChat, rememberAgentChat} from './agent-conversations';
import {QuickTour, tourSeen, rememberTour} from './components/QuickTour';
import {demoReturnTo, pendingDemoReturnTo, rememberDemoReturnTo, clearDemoReturnTo} from './demo-return';

import {DemoArtifact} from './components/DemoArtifact';
import {ChatFileDrop} from './components/ChatFileDrop';
import {createChannelEventsCore,type ChannelEventsCore} from './chat/channel-events';
import {fetchAgentStarts} from './chat/lifecycles';
import {useChannelEvents} from './chat/useChannelEvents';
import {adaptiveMessageBatchSize} from './chat/history';
import {ChatThread, type ChatThreadHandle} from './chat/ChatThread';
import {ChatComposer,useComposerSession,type ChatComposerHandle} from './chat/ChatComposer';
import {HuddleButton} from './huddle/HuddleButton';
import './huddle/huddle.css';
import type {ChannelEventsSnapshot} from './chat/channel-events';
import {consumeConnectionReturn,forgetConnectionReturn} from './project-connection-return';
import {ProjectConnections} from './ProjectConnections';
import {loadChatDraft,saveChatDraft,clearOwnerDrafts,rememberProject,recentProject} from './drafts';
import { readAgentRequestLocation } from "./AgentRequests";
import {WorkspaceHeaderProvider, WorkspaceTopbar} from './components/WorkspaceTopbar';
import { mentionCandidates } from "./mentions";
import type { OnboardingSummary } from "@nest/schemas";
import {apiUrl} from './config';
import {GoogleSignIn} from '../../nest-brand/GoogleSignIn';
import { Community } from "./Community";
import type { Project } from "@nest/schemas";
import { Projects } from "./Projects";
import { ProjectNavigation } from "./components/ProjectNavigation";
import { Agents } from "./Agents";
import { AgentAvatar, AgentAvatarChoices } from "./components/AgentAvatar";
import {AgentRuntimeStatus} from './components/AgentRuntimeStatus';
import { Dashboard, DesignIcon } from "./Dashboard";
import { useBranding } from "../../nest-brand/BrandingProvider";
import { PoweredByNest, InstanceBrand, ThemeToggle } from "../../nest-brand/Brand";
import {
  FormEvent,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState
} from "react";
import { apiFetch, apiJson, getApiHeaders } from "./api";
import { wsUrl } from "./config";
import type { Agent, AuthMe, Channel, ChannelParticipant, ChannelShare, EventRow, Team } from "./types";

function sourceLabel(source: string) {
  if (source.startsWith("human:")) return source.slice("human:".length) || "Human";
  if (source.startsWith("agent:")) return source.slice("agent:".length) || "Agent";
  return source || "System";
}

const DIRECT_CHANNEL_KINDS = new Set(["HUMAN_AGENT_DM", "AGENT_AGENT_DM", "DIRECT_GROUP"]);
const CHANNEL_GROUPS = [
  { id: "direct", label: "Direct messages" },
  { id: "channels", label: "Channels" },
  { id: "shared", label: "Shared channels" }
] as const;

type ChannelGroupId = (typeof CHANNEL_GROUPS)[number]["id"];

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

function createSessionChannelEvents() {
  const limit = () =>
    adaptiveMessageBatchSize(
      (
        navigator as Navigator & {
          connection?: { downlink?: number; effectiveType?: string; saveData?: boolean };
        }
      ).connection
    );
  return createChannelEventsCore({ fetchJson: apiJson, limit, loadAgentStarts:()=>fetchAgentStarts(apiJson) });
}

const NO_EVENTS: EventRow[] = [];
const NO_DETACHED: ReadonlySet<string> = new Set();

export default function App() {
  const { branding } = useBranding();
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const chatThreadRef = useRef<ChatThreadHandle | null>(null);
  const activeChannelIdRef = useRef<string | null>(null);
  const lastSeenByChannelRef = useRef<Record<string, number>>({});
  const channelsRef = useRef<Channel[]>([]);
  const usernameRef = useRef("");
  const userIdRef = useRef<string | null>(null);
  const viewerTeamIdsRef = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const wsSubscribedTopicsRef = useRef<Set<string>>(new Set());
  const wsReconnectTimerRef = useRef<number | null>(null);
  const wsShouldReconnectRef = useRef(true);
  const wsReconnectAttemptRef = useRef(0);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [personalSetup, setPersonalSetup] = useState<OnboardingSummary | null>(null);
  const [creatingPersonalAgent, setCreatingPersonalAgent] = useState(() => new URL(window.location.href).searchParams.get("create") === "personal");
  const [humans, setHumans] = useState<Array<{ username: string }>>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [channelEvents, setChannelEvents] = useState<ChannelEventsCore>(createSessionChannelEvents);
  const channelEventsRef = useRef(channelEvents);
  channelEventsRef.current = channelEvents;
  const channelSnapshot = useChannelEvents(channelEvents);
  // Until the core has switched to a newly selected channel, render that channel as loading and empty.
  const channelEventsCurrent = channelSnapshot.channelId === activeChannelId;
  const events = channelEventsCurrent ? channelSnapshot.events : NO_EVENTS;
  // The new chat reads the snapshot itself; a channel the core has not switched to yet renders as loading and empty.
  const threadSnapshot = useMemo<ChannelEventsSnapshot>(() => channelEventsCurrent ? channelSnapshot : {
    channelId: activeChannelId, events: NO_EVENTS, detachedIds: NO_DETACHED, loading: Boolean(activeChannelId), loadingOlder: false, hasOlder: false, error: null
  }, [channelEventsCurrent, channelSnapshot, activeChannelId]);
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
  const [focusedMessage,setFocusedMessage]=useState<string|null>(()=>new URL(window.location.href).searchParams.get('message'));
  const [username, setUsername] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [loginUsername, setLoginUsername] = useState("admin");
  const [loginPassword, setLoginPassword] = useState("");
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [demoPreview, setDemoPreview] = useState<{channel:string;path:string}|null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const messagesLoading = channelEventsCurrent ? channelSnapshot.loading : Boolean(activeChannelId);
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
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [tourOpen,setTourOpen]=useState(false);
  const tourSidebarWasOpen=useRef(false);
  function startTour(){tourSidebarWasOpen.current=mobileSidebarOpen;setMobileSidebarOpen(true);setTourOpen(true);}
  function closeTour(){rememberTour(userId??username);setTourOpen(false);setMobileSidebarOpen(tourSidebarWasOpen.current);}

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

  const isConversationEmpty = !messagesLoading && visibleTimelineEvents.length === 0;

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
  const [agentOpening,setAgentOpening]=useState(false);
  const [agentNavigationError,setAgentNavigationError]=useState('');
  const [agentTab,setAgentTab]=useState<AgentTab>(()=>new URL(window.location.href).searchParams.get('tab')==='connections'?'connections':'settings');
  const standaloneChannels = useMemo(() => visibleChannels.filter(channel => !projectIndex.some(project => project.channelId === channel.id)), [visibleChannels, projectIndex]);
  const agentChats = useMemo(()=>{
    const result=new Map<string,Channel[]>();
    for(const channel of standaloneChannels){const name=conversationAgent(channel,username,userId);if(name)result.set(name,[...(result.get(name)??[]),channel]);}
    return result;
  },[standaloneChannels,username,userId]);
  const activeChatAgent = view==='workspace' && activeChannel && standaloneChannels.some(c=>c.id===activeChannel.id) ? conversationAgent(activeChannel,username,userId) : null;
  useEffect(()=>{if(activeChatAgent&&activeChannelId)rememberAgentChat(userId,activeChatAgent,activeChannelId);},[activeChatAgent,activeChannelId,userId]);
  useEffect(() => {
    if (view === "projects") setActiveChannelId(projectIndex.find(project => project.id === selectedProject)?.channelId ?? null);
  }, [view, selectedProject, projectIndex]);
  const activeChannels = useMemo(
    () => standaloneChannels.filter((channel) => !channel.archivedAt && !conversationAgent(channel,username,userId)),
    [standaloneChannels,username,userId]
  );
  const archivedChannels = useMemo(
    () => standaloneChannels.filter((channel) => Boolean(channel.archivedAt) && !conversationAgent(channel,username,userId)),
    [standaloneChannels,username,userId]
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
    for(const candidate of candidates){
      const agent=visibleAgents.find(agent=>candidate.kind==='Agent'&&agent.name===candidate.name);
      if(agent?.visibility==='PRIVATE'&&agent.ownerHumanId!==userId&&!sharedAssistants.some(a=>a.agentName===agent.name))candidate.inviteBlockedReason='Only this agent’s owner can invite it';
    }
    return candidates;
  }, [visibleAgents, humans, activeChannel?.participants,sharedAssistants,userId]);

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
  const activeChannelManageable = canManageUserChannel(activeChannel, userId);
  const activeChannelCanPost = activeChannel ? activeChannel.canPost !== false : false;
  const activeConversationName = activeChannel ? projectIndex.find(project => project.channelId === activeChannel.id)?.name ?? channelLabel(activeChannel, username) : "";
  const mentionProject=projectIndex.find(project=>project.channelId===activeChannelId);
  const canInviteMention=activeChannelManageable&&(!mentionProject||mentionProject.ownerId===userId);
  // Held here, above the project tabs, so leaving Chat for Files keeps a send, upload or invite in flight.
  const composerSession = useComposerSession({
    userId,
    channel: activeChannel,
    canPost: activeChannelCanPost,
    onStateChange: state => { setSending(state.sending); if (state.sending) setError(null); },
    onSent: handleSent,
    onError: setError,
    mentionCandidates: mentionOptions,
    canInvite: canInviteMention,
    onInvite: inviteMention,
    onAskAssistant: askAssistant,
  });
  async function inviteMention(candidate:import('./mentions').MentionCandidate){
    const channelId=activeChannelId,ownerId=userId;
    if(!channelId||!ownerId||!canInviteMention||!activeChannelCanPost||activeChannel?.archivedAt||candidate.inviteBlockedReason)throw Error('Invitation unavailable');
    const member={subscriberType:candidate.kind==='Agent'?'AGENT':'HUMAN',subscriberId:candidate.name};
    try{
      await apiFetch(mentionProject?`/api/projects/${encodeURIComponent(mentionProject.id)}/members`:`/api/channels/${encodeURIComponent(channelId)}/subscribe`,{method:'POST',headers:getApiHeaders(),body:JSON.stringify(member)});
    }catch{/* Re-read membership to reconcile a response lost after subscription. */}
    const fresh=await apiJson<Channel[]>('/api/channels?includeArchived=1');
    const channel=fresh.find(channel=>channel.id===channelId);
    if(!channel||channel.archivedAt||channel.canPost===false||!canManageUserChannel(channel,ownerId)||!channel.participants?.some(participant=>participant.subscriberType===member.subscriberType&&participant.subscriberId===member.subscriberId))throw Error('Invitation unconfirmed');
    if(userIdRef.current!==ownerId)throw Error('Session changed');
    // Refresh the roster without navigating back if the user changed chats.
    setChannels(fresh);
  }
  function askAssistant(name:string,brief:string){if(userId)void apiJson<{channelId:string}>('/api/collaboration/agents/'+encodeURIComponent(name)+'/chat',{method:'POST',headers:getApiHeaders(),body:'{}'}).then(async r=>{const existing=loadChatDraft(userId,r.channelId);if(!existing.text&&!existing.attachments.length&&!existing.request)saveChatDraft(userId,r.channelId,{text:brief,mentions:[],attachments:[]});await refreshChannels(r.channelId);void loadShell();}).catch(()=>setError('Could not open the agent conversation. Try again.'));}
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

  function selectAgent(name: string | null, options: {tab?:AgentTab; replace?:boolean; create?:boolean; requests?:boolean; request?:string; assistant?:string} = {}) {
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
    setAgentTab(options.tab??'settings');
    if(name)url.searchParams.set("tab",options.tab??"settings");
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

  async function openAgentChat(name:string) {
    if(agentOpening)return;
    const chats=(agentChats.get(name)??[]).filter(c=>!c.archivedAt);
    const previous=recentAgentChat(userId,name);
    const chat=chats.find(c=>c.id===previous)??chats[0];
    if(chat){selectChannel(chat.id);return;}
    setAgentOpening(true);setAgentNavigationError('');
    try {
      const agent=agents.find(a=>a.name===name);
      const shared=!agent||(agent.visibility==='PRIVATE'&&agent.ownerHumanId!==userId);
      const result=await apiJson<{id?:string;channelId?:string}>(shared?`/api/collaboration/agents/${encodeURIComponent(name)}/chat`:'/api/channels/direct/human-agent',{method:'POST',headers:getApiHeaders(),body:JSON.stringify({agentName:name})});
      const id=result.channelId??result.id;
      if(!id)throw Error('No conversation returned');
      await refreshChannels(id);
    }catch{setAgentNavigationError('Could not open this chat. Try again.');}
    finally{setAgentOpening(false);}
  }
  function newAgentChat(name:string) {
    setConversationName(`Chat with ${name} ${(agentChats.get(name)?.length??0)+1}`);
    setConversationDescription('');setConversationVisibility('PRIVATE');setSelectedConversationAgents([name]);setAgentSearchQuery('');setShowConversationDialog(true);setMobileSidebarOpen(false);
  }

  // Deep-link focus inside the open channel (reply links); clearing first makes a repeated id scroll and highlight again.
  function focusMessage(eventId: string) {
    setFocusedMessage(null);
    window.setTimeout(() => {
      setFocusedMessage(eventId);
      const url = new URL(window.location.href);
      url.searchParams.set("message", eventId);
      window.history.replaceState(null, "", url);
    });
  }

  async function loadSession() {
    setAuthLoading(true);
    setError(null);
    try {
      const me = await apiJson<AuthMe>("/api/auth/me");
      const nextUsername = me.username ?? "";
      const destination = demoReturnTo(window.location.search, window.location.hash) ?? pendingDemoReturnTo();
      if (nextUsername && !me.mustChangePassword && destination) {
        clearDemoReturnTo();
        window.location.replace(destination);
        return;
      }
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
      const returning=userId?consumeConnectionReturn(userId,nextProjects,new URL(window.location.href)):null;
      if(returning){
        const clean=new URL(window.location.href);clean.searchParams.delete('status');clean.searchParams.delete('connected_account_id');window.history.replaceState(null,'',clean);
        selectProject(returning.id,null,'chat',true);
      } else if (!claimedShareChannelId && !linkedChannelId && (urlView === "onboarding" || window.location.pathname === "/onboarding" || (!urlView && nextOnboarding && !nextOnboarding.setup?.completedAt && (nextOnboarding.setup || (!nextProjects.length && !nextAgents.some(a=>a.ownerHumanId===userId)))))) {
        const legacySetupLink = urlView === "onboarding" || window.location.pathname === "/onboarding";
        selectAgent(nextOnboarding?.setup?.channelId ? nextOnboarding.setup.name : null, {replace:true,create:legacySetupLink && !nextOnboarding?.setup?.channelId,tab:new URL(window.location.href).searchParams.has('connected_account_id')?'connections':'settings'});
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

  function newestMessageTime(channelEvents: EventRow[]) {
    return channelEvents.reduce((newest, event) => {
      if (event.type !== "message.created" && event.type !== "agent.turn.failed") return newest;
      return Math.max(newest, event.createdAt ?? 0);
    }, 0);
  }

  function markChannelSeen(channelId: string, newestMessageAt: number) {
    if (!chatVisibleRef.current) return;
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

  async function switchChannelEvents(channelId: string | null) {
    const core = channelEventsRef.current;
    await core.switchTo(channelId);
    const snapshot = core.snapshot();
    if (!channelId || snapshot.channelId !== channelId || snapshot.loading || snapshot.error) return;
    if (channelId !== activeChannelIdRef.current) return;
    markChannelSeen(channelId, newestMessageTime(snapshot.events));
  }

  async function refreshChannelEvents() {
    const channelId = activeChannelIdRef.current;
    const core = channelEventsRef.current;
    if (!channelId || core.snapshot().channelId !== channelId) return;
    const result = await core.refresh();
    if (channelId !== activeChannelIdRef.current || core.snapshot().channelId !== channelId) return;
    markChannelSeen(channelId, result.newestMessageAt);
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
    if (!event.id) return;
    const core = channelEventsRef.current;
    core.observeLifecycle(event);
    // Only a first sighting counts for unread and nest-message; a status republish just updates the store.
    const sighting = core.seen(event.id, event.status);
    if (sighting === "duplicate") return;
    const eventChannelId = event.channelId;
    const currentActiveId = activeChannelIdRef.current;
    const activeTimelineEvent =
      chatVisibleRef.current &&
      Boolean(eventChannelId) &&
      eventChannelId === currentActiveId &&
      (event.type === "message.created" || isTraceEvent(event));
    if (sighting === "update") {
      if (activeTimelineEvent) core.ingest(event);
      return;
    }
    if(event.type==='message.created')window.dispatchEvent(new Event('nest-message'));
    if (!eventChannelId) return;

    if (activeTimelineEvent) {
      core.ingest(event);
      if (event.type === "message.created" || event.type === "agent.turn.failed") {
        const eventCreatedAt = event.createdAt ?? 0;
        if (eventCreatedAt > 0) {
          lastSeenByChannelRef.current[eventChannelId] = Math.max(
            lastSeenByChannelRef.current[eventChannelId] ?? 0,
            eventCreatedAt
          );
        }
      }
      setUnreadCounts((current) => {
        if (!current[eventChannelId]) return current;
        const next = { ...current };
        delete next[eventChannelId];
        return next;
      });
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
    activeChannelIdRef.current = activeChannelId;
    setShowParticipantsDialog(false);
    setShowChannelManageDialog(false);
    setShareValue("");
    setShareLinkCopied(false);
    setShareRemovingKey(null);
    setShareSubmitting(false);
  }, [activeChannelId,userId]);

  useEffect(()=>{if(userId&&view==='projects'&&selectedProject&&projectIndex.some(p=>p.id===selectedProject))rememberProject(userId,selectedProject);},[userId,view,selectedProject,projectIndex]);

  useEffect(() => {
    if (!authenticated || mustChangePassword) return;
    void switchChannelEvents(activeChannelId);
  }, [activeChannelId, authenticated, mustChangePassword, projectTab, channelEvents]);

  useEffect(() => {
    if (channelSnapshot.error) setError(channelSnapshot.error);
  }, [channelSnapshot.error]);

  useEffect(()=>{
    if(!authenticated||!activeChannelId||!focusedMessage||messagesLoading)return;
    let cancelled=false;
    void channelEventsRef.current.focus(focusedMessage).then(result=>{
      if(cancelled)return;
      // The thread scrolls the loaded message into view and focuses it (spec 8.5).
      if(result!=='loaded')setError('This mentioned message is no longer available.');
    });
    return()=>{cancelled=true;};
  },[authenticated,activeChannelId,focusedMessage,messagesLoading]);

  useEffect(() => {
    if (!authenticated || mustChangePassword) return;
    void loadMessageNotifications();
  }, [authenticated, mustChangePassword, channels]);

  useEffect(() => {
    if (!authenticated || mustChangePassword) return;
    const controller = new AbortController();
    let inFlight = false;
    async function refreshAgents() {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const next = await apiJson<Agent[]>('/api/agents', {signal:controller.signal});
        if (!controller.signal.aborted) setAgents(next);
      } catch {
        // Keep directory details usable without presenting stale status as current.
        if (!controller.signal.aborted) {
          setAgents(current => current.map(agent => ({...agent,runtimeState:undefined})));
        }
      } finally { inFlight = false; }
    }
    const interval = window.setInterval(() => void refreshAgents(), 10000);
    window.addEventListener('focus', refreshAgents);
    return () => { controller.abort(); window.clearInterval(interval); window.removeEventListener('focus', refreshAgents); };
  }, [authenticated, mustChangePassword]);

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
        void refreshChannelEvents();
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
      void refreshChannelEvents();
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
      setAgentTab(url.searchParams.get("tab")==='connections'?'connections':'settings');
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
    if(userId){clearOwnerDrafts(userId);forgetConnectionReturn(userId);}
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
    const nextChannelEvents = createSessionChannelEvents();
    channelEventsRef.current = nextChannelEvents;
    setChannelEvents(nextChannelEvents);
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
    lastSeenByChannelRef.current = {};
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

  // After the composer's send: a reload when the WebSocket is down, then the thread scrolls to its end.
  async function handleSent() {
    if (!wsConnected) await refreshChannelEvents();
    window.requestAnimationFrame(() => chatThreadRef.current?.scrollToBottom());
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
        try {
        const subscriptions=await Promise.allSettled([
          username
            ? apiFetch(`/api/channels/${encodeURIComponent(created.id)}/subscribe`, {
                method: "POST",
                headers: getApiHeaders(),
                body: JSON.stringify({ subscriberType: "HUMAN", subscriberId: username })
              })
            : Promise.resolve(),
          ...selectedAgents.map((agentName) =>
            apiFetch(`/api/channels/${encodeURIComponent(created.id)}/subscribe`, {
              method: "POST",
              headers: getApiHeaders(),
              body: JSON.stringify({ subscriberType: "AGENT", subscriberId: agentName })
            })
          )
        ]);
        if(subscriptions.some(result=>result.status==='rejected'))throw Error('Participant setup failed');
        } catch {
          // This empty channel was created by this action. Do not leave a successful-looking
          // conversation without its requested participants, or duplicate it on retry.
          try { await apiFetch(`/api/channels/${encodeURIComponent(created.id)}`,{method:'DELETE'}); }
          catch { await refreshChannels(created.id);throw Error('The chat was created, but participants could not be added. Use Manage channel to finish setup.'); }
          throw Error('Could not add the participants. No new chat was kept; try again.');
        }
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


  const demoDestination = demoReturnTo(window.location.search, window.location.hash) ?? pendingDemoReturnTo();

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
          <GoogleSignIn apiUrl={apiUrl} onStart={() => { if (demoDestination) rememberDemoReturnTo(demoDestination); }} />
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
        <ChatFileDrop scope={`${userId??''}:${activeChannelId??''}`} onFiles={files=>composerRef.current?.enqueueFiles(files)} disabledReason={!activeChannel?'Choose a conversation before attaching files.':activeChannel.archivedAt?'Restore this conversation before attaching files.':!activeChannelCanPost?'This conversation is read-only.':sending?'Wait for this message to finish sending.':undefined}/>
        {view === "workspace" && <WorkspaceTopbar
          onMenu={() => setMobileSidebarOpen(true)}
          search={<label className="dashboard-search"><DesignIcon name="search" /><input
            aria-label="Search channels" placeholder="Search channels…" value={channelQuery}
            onChange={event => setChannelQuery(event.target.value)}
          /></label>}
        />}
        {activeChatAgent&&<AgentWorkspaceTabs name={activeChatAgent} tab="chat" onChat={()=>{}} onTab={tab=>selectAgent(activeChatAgent,{tab})}/>}
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

        <div className={`artifact-chat-layout${demoPreview?.channel===activeChannelId ? " has-preview" : ""}`}>
        <section className="chat-stack">
          <ChatThread
            key={activeChannelId ?? ""}
            snapshot={threadSnapshot}
            core={channelEvents}
            currentUsername={username}
            agents={agents}
            focusedMessageId={focusedMessage}
            isConversationEmpty={isConversationEmpty}
            channelLabel={activeConversationName}
            headerActions={activeChannel && <HuddleButton key={activeChannel.id} channel={activeChannel} label={activeConversationName} username={username} agents={agents} events={threadSnapshot.events} canPost={activeChannelCanPost}/>}
            onPreviewDemo={path => setDemoPreview({channel: activeChannelId!, path})}
            onQuote={(target, quotedText) => {composerRef.current?.setReplyTarget(target, quotedText);composerRef.current?.focus();}}
            onFocusMessage={focusMessage}
            handle={chatThreadRef}
            footer={view==='projects'&&selectedProject&&activeChannel&&<ProjectConnections key={activeChannel.id} ownerId={userId??''} projectId={selectedProject} text={events.filter(e=>e.channelId===activeChannel.id&&e.type==='message.created').slice(-4).map(e=>String((e.payload as {text?:unknown})?.text??'').slice(0,4000)).join('\n')}/>}
          />
          <ChatComposer
            ref={composerRef}
            session={composerSession}
            conversationName={activeConversationName}
            isConversationEmpty={isConversationEmpty}
            inProject={Boolean(mentionProject)}
            mentionCandidates={mentionOptions}
            canInvite={canInviteMention}
            onInvite={inviteMention}
            onAskAssistant={askAssistant}
            openInvite={() => setShowParticipantsDialog(true)}
            openFiles={() => { if (mentionProject) selectProject(mentionProject.id, null, "files"); }}
          />
        </section>
        {demoPreview?.channel===activeChannelId && <DemoArtifact key={demoPreview.path} path={demoPreview.path} onClose={()=>setDemoPreview(null)} editable={!!activeChannel && !activeChannel.archivedAt && activeChannelCanPost && !sending} onEdit={()=>{composerRef.current?.insertText('Please update '+new URL(demoPreview.path,window.location.origin).href+': ');composerRef.current?.focus();}}/>}
        </div>
      </section>;
  const chatMembers = <aside className="activity-panel">
        <section className="participants-card">
          <div className="participants-header-row">
            <h2>Participants</h2>
          </div>
          <div className="participant-list">
            {activeChannel?.participants?.map((participant, index) => {
              const agent = agents.find(agent => agent.name === participant.subscriberId);
              return (
                <article key={`${participant.subscriberType}:${participant.subscriberId}:${index}`}>
                  {normalizedSubscriberType(participant) === "AGENT" ? <AgentAvatar name={participant.subscriberId} size={34} /> : <div className="participant-avatar">{participantName(participant).slice(0, 2)}</div>}
                  <div>
                    <strong>
                      {participantName(participant)}
                    </strong>
                    <span>{participantType(participant)}{normalizedSubscriberType(participant)==='AGENT' && <> · <AgentRuntimeStatus state={agent?.runtimeState}/></>}</span>
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
    <AgentAvatarChoices value={Object.fromEntries(agents.map(agent=>[agent.name, agent.icon]))}><WorkspaceHeaderProvider onTour={startTour} tourNew={!tourSeen(userId??username)} channelLabel={(id,fallback)=>projectIndex.find(project=>project.channelId===id)?.name ?? fallback} username={username} onAgents={()=>selectAgent(null)} onSignOut={()=>void handleLogout()} onMention={(channelId,eventId)=>{selectChannel(channelId);setFocusedMessage(eventId);const url=new URL(window.location.href);url.searchParams.set('message',eventId);window.history.replaceState(null,'',url);}}><main className={`app-shell product-shell ${view !== "workspace" ? "dashboard-shell" : ""}`}>
      <aside className={`sidebar ${mobileSidebarOpen ? "sidebar-mobile-open" : ""} ${tourOpen ? "tour-navigation" : ""}`}>
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
          <AgentNavigation agents={visibleAgents} chats={agentChats} activeAgent={activeChatAgent??(view==='agents'?selectedAgent:null)} activeChannelId={activeChannelId} inAgents={view==='agents'||!!activeChatAgent} busy={agentOpening} error={agentNavigationError} unread={unreadCounts} label={c=>isHumanAgentDirectChannel(c)?'First conversation':channelLabel(c,username)} onBrowse={()=>selectAgent(null)} onOpen={name=>void openAgentChat(name)} onChat={selectChannel} onNew={newAgentChat}/>
          <button data-tour="community" aria-current={view === "community" ? "page" : undefined} onClick={()=>selectCommunity(null)}><DesignIcon name="community" />Community</button>
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

      {view === "community" ? <Community skillName={selectedCommunitySkill} onSelect={selectCommunity} onMenu={()=>setMobileSidebarOpen(true)} agents={visibleAgents}/> : view === "projects" ? <Projects participants={activeChannel?.participants ?? []} userId={userId ?? ""} existingChats={standaloneChannels.map(channel => ({id:channel.id,name:channelLabel(channel, username),archived:!!channel.archivedAt}))} onChat={selectChannel} projectId={selectedProject} taskId={selectedTask} tab={projectTab} agents={visibleAgents} onSelect={selectProject} onLoaded={onProjectLoaded} onMenu={() => setMobileSidebarOpen(true)} chat={chatWorkspace} onMembersChanged={async()=>{await refreshChannels();}} onManage={activeChannelManageable?()=>setShowChannelManageDialog(true):undefined} /> : view === "agents" ? <Agents tab={agentTab} onTab={tab=>selectAgent(selectedAgent,{tab})} onOpenChat={name=>void openAgentChat(name)} requestLocation={requestLocation} setup={personalSetup} creating={creatingPersonalAgent} onCreate={()=>selectAgent(null,{create:true})} onCreated={name=>{selectAgent(name);void loadShell();}} onChat={id=>{void refreshChannels(id).then(()=>loadShell()).catch(()=>setError('Could not load the conversation. Reload to try again.'));}} agents={visibleAgents} name={selectedAgent} userId={userId} loading={loading} error={error} onSelect={selectAgent} onMenu={() => setMobileSidebarOpen(true)} onRetry={() => void loadShell()} onSaved={updated => setAgents(current => current.map(agent => agent.name === updated.name ? { ...agent, ...updated } : agent))} /> : view === "dashboard" ? <Dashboard
        resumeProject={userId?projectIndex.find(p=>p.id===recentProject(userId)):undefined} channels={visibleChannels} projects={projectIndex} onProject={selectProject} unreadCounts={unreadCounts} onCommunity={selectCommunity}
        loading={loading} error={error} label={channel => channelLabel(channel, username)}
        onSelect={selectChannel} onCreate={() => selectProject(null, null, "new")}
        onMenu={() => setMobileSidebarOpen(true)} onRetry={() => void loadShell()}
      /> : <>{chatWorkspace}{chatMembers}</>}

      {tourOpen && <QuickTour onClose={closeTour}/> }
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
                      <span>{participantType(participant)}{normalizedSubscriberType(participant)==='AGENT' && <> · <AgentRuntimeStatus state={agents.find(agent=>agent.name===participant.subscriberId)?.runtimeState}/></>}</span>
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
                  setShowChannelManageDialog(false);
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
