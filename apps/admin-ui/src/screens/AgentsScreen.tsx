import type { AgentModelCatalog } from "@nest/schemas";
import { apiFetch } from "../api";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Agent,
  AgentWorkspaceFileResponse,
  AgentWorkspaceListResponse,
  EventRow,
  RunnerNode,
  SkillMeta
} from "../types";
import { Button, Card, Input, Textarea } from "../components/ui";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { formatTimestamp } from "../utils/formatTimestamp";
import {
  DEFAULT_CLAUDE_CODE_OPTIONS,
  buildClaudeCodeWrappedConfig,
  credentialSecretName,
  isValidSecretName,
  isValidSecretPath,
  SHARED_DEFAULT_WORKSPACE,
  defaultClaudeCodeWorkspace,
  pickClaudeCodeRunner,
  readClaudeCodeOptions,
  requiredSecretNames,
  type ClaudeCodeOptions
} from "../claudeCodeAgent";

type AgentForm = {
  name: string;
  modelId: string;
  visibility: "PUBLIC" | "PRIVATE";
  mode: "CLASSIC" | "RLM_REPL" | "WRAPPED";
  memoryContextMode: "PER_CHANNEL_CROSS_CHANNEL" | "FULL_CHANNEL_EVENTS" | "OFF";
  emitAuditEvents: boolean;
  llmCallTimeoutMs: string;
  contextSessionGapMs: string;
  workspacePath: string;
  allowOutsideWorkspace: boolean;
  assignedRunnerId: string;
  soulContents: string;
  enabledSkills: string[];
  alwaysPreloadedSkills: string[];
  wrappedConfigJson: string;
  wrappedConfig?: Record<string, unknown>;
  // Set when the WRAPPED agent is a Claude Code agent built from the form, not raw JSON.
  claudeCode?: ClaudeCodeOptions | null;
};

const DEFAULT_WRAPPED_CONFIG = JSON.stringify(
  {
    kind: "custom",
    harness: "command",
    runtime: {
      command: 'printf "%s" "$NEST_WRAPPED_MESSAGE"',
      parse: "text",
      timeoutMs: 600000
    },
    session: {
      scope: "per-channel"
    }
  },
  null,
  2
);

const DEFAULT_AGENT_FORM: AgentForm = {
  name: "",
  modelId: "",
  visibility: "PUBLIC",
  mode: "CLASSIC",
  memoryContextMode: "PER_CHANNEL_CROSS_CHANNEL",
  emitAuditEvents: true,
  llmCallTimeoutMs: "",
  contextSessionGapMs: "",
  workspacePath: ".nest-data/workspaces/default",
  allowOutsideWorkspace: false,
  assignedRunnerId: "",
  soulContents: "",
  enabledSkills: [],
  alwaysPreloadedSkills: [],
  wrappedConfigJson: DEFAULT_WRAPPED_CONFIG,
  claudeCode: null
};

function parseOptionalPositiveIntInput(
  value: string,
  fieldName: string
): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer when provided.`);
  }
  return Math.floor(parsed);
}

function stringifyWrappedConfig(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(value, null, 2);
  }
  return DEFAULT_WRAPPED_CONFIG;
}

function parseWrappedConfigJson(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Wrapped config must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function readWrappedDisplayValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatAgentModelLabel(agent: Agent): string {
  if ((agent.mode ?? "CLASSIC") !== "WRAPPED") return agent.modelId ?? "-";
  const config = agent.wrappedConfig ?? {};
  const kind = readWrappedDisplayValue(config.kind);
  const name = readWrappedDisplayValue(config.name);
  const harness = readWrappedDisplayValue(config.harness) ?? readWrappedDisplayValue(config.transport);
  return `wrapped: ${kind ?? name ?? harness ?? "custom"}`;
}

const SECRET_NAME_HINT =
  "Use capital letters, digits and underscores. Names starting with NEST_, ORGOPS_, ANTHROPIC_ or CLAUDE_ are reserved.";

function readClaudeCodeValidationMessage(options: ClaudeCodeOptions | null | undefined) {
  if (!options) return null;
  return Number.isInteger(options.timeoutMinutes) && options.timeoutMinutes > 0
    ? null
    : "Turn limit must be a whole number of minutes.";
}

function ClaudeCodeFields({
  agentName,
  options,
  hasAgentRunner,
  onChange
}: {
  agentName: string;
  options: ClaudeCodeOptions;
  hasAgentRunner: boolean;
  onChange: (options: ClaudeCodeOptions) => void;
}) {
  const [secretDraft, setSecretDraft] = useState("");
  const [fileDraft, setFileDraft] = useState({ name: "", path: "" });
  const [draftError, setDraftError] = useState<string | null>(null);
  const preview = useMemo(
    () => JSON.stringify(buildClaudeCodeWrappedConfig(options), null, 2),
    [options]
  );
  const addSecret = () => {
    const name = secretDraft.trim();
    if (!isValidSecretName(name)) return setDraftError(SECRET_NAME_HINT);
    setDraftError(null);
    setSecretDraft("");
    if (!options.secretNames.includes(name)) onChange({ ...options, secretNames: [...options.secretNames, name] });
  };
  const addFile = () => {
    const name = fileDraft.name.trim();
    const path = fileDraft.path.trim();
    if (!isValidSecretName(name)) return setDraftError(SECRET_NAME_HINT);
    if (!isValidSecretPath(path)) {
      return setDraftError("Use a path inside Claude's home, such as .ssh/id_ed25519.");
    }
    setDraftError(null);
    setFileDraft({ name: "", path: "" });
    onChange({
      ...options,
      secretFiles: [...options.secretFiles.filter((file) => file.path !== path), { name, path }]
    });
  };
  const selectClassName =
    "w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100";
  return (
    <div className="space-y-4 rounded border border-slate-800 bg-slate-950 p-3" aria-label="Claude Code settings" role="group">
      <div className="space-y-1">
        <div className="text-sm text-slate-400">Sign-in</div>
        <select
          aria-label="Claude credential"
          value={options.credential}
          onChange={(e) =>
            onChange({ ...options, credential: e.target.value === "apiKey" ? "apiKey" : "oauth" })
          }
          className={selectClassName}
        >
          <option value="oauth">Subscription token</option>
          <option value="apiKey">API key</option>
        </select>
        <p className="text-xs text-slate-500">
          Stored as the secret {credentialSecretName(options)}. Claude Code never sees this value; the agent container swaps in the real credential for each request.
        </p>
      </div>
      <div className="space-y-1">
        <div className="text-sm text-slate-400">Turn limit (minutes)</div>
        <Input
          aria-label="Turn limit in minutes"
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={Number.isNaN(options.timeoutMinutes) ? "" : String(options.timeoutMinutes)}
          onChange={(e) => onChange({ ...options, timeoutMinutes: e.target.value ? Number(e.target.value) : Number.NaN })}
        />
        <p className="text-xs text-slate-500">
          A turn that runs longer is stopped, together with the tools it started.
        </p>
      </div>
      <div className="space-y-2">
        <div>
          <div className="text-sm text-slate-400">Tool secrets as environment variables</div>
          <p className="text-xs text-slate-500">For example GH_TOKEN for the GitHub CLI.</p>
        </div>
        {options.secretNames.length ? (
          <ul className="space-y-1" aria-label="Tool secrets">
            {options.secretNames.map((name) => (
              <li key={name} className="flex items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1 text-sm">
                <code className="min-w-0 break-all text-slate-200">{name}</code>
                <Button
                  type="button"
                  variant="secondary"
                  className="shrink-0 px-2 py-1 text-xs"
                  aria-label={`Remove ${name}`}
                  onClick={() => onChange({ ...options, secretNames: options.secretNames.filter((item) => item !== name) })}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            aria-label="Tool secret name"
            value={secretDraft}
            placeholder="GH_TOKEN"
            onChange={(e) => setSecretDraft(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addSecret();
              }
            }}
          />
          <Button type="button" variant="secondary" className="shrink-0 text-sm" onClick={addSecret}>
            Add secret
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        <div>
          <div className="text-sm text-slate-400">Secret files</div>
          <p className="text-xs text-slate-500">
            Written under Claude's home before each turn, readable only by Claude Code.
          </p>
        </div>
        {options.secretFiles.length ? (
          <ul className="space-y-1" aria-label="Secret files">
            {options.secretFiles.map((file) => (
              <li key={file.path} className="flex items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1 text-sm">
                <span className="min-w-0 break-all text-slate-200">
                  <code>{file.name}</code> <span className="text-slate-500">to</span> <code>~/{file.path}</code>
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  className="shrink-0 px-2 py-1 text-xs"
                  aria-label={`Remove ${file.path}`}
                  onClick={() => onChange({ ...options, secretFiles: options.secretFiles.filter((item) => item.path !== file.path) })}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input
            aria-label="Secret file name"
            value={fileDraft.name}
            placeholder="SSH_PRIVATE_KEY"
            onChange={(e) => setFileDraft((prev) => ({ ...prev, name: e.target.value.toUpperCase() }))}
          />
          <Input
            aria-label="Secret file path"
            value={fileDraft.path}
            placeholder=".ssh/id_ed25519"
            onChange={(e) => setFileDraft((prev) => ({ ...prev, path: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addFile();
              }
            }}
          />
          <Button type="button" variant="secondary" className="text-sm" onClick={addFile}>
            Add file
          </Button>
        </div>
      </div>
      {draftError ? (
        <p role="alert" className="text-xs text-rose-400">
          {draftError}
        </p>
      ) : null}
      <div role="note" className="rounded border border-blue-300 bg-slate-900 p-3 text-sm text-slate-200">
        Add these secrets in Admin → Secrets with scope Private, agent {agentName.trim() || "(this agent's name)"}:{" "}
        {requiredSecretNames(options).map((name, index) => (
          <span key={name}>
            {index ? ", " : ""}
            <code className="whitespace-nowrap font-mono">{name}</code>
          </span>
        ))}
        <span className="mt-1 block text-xs text-slate-500">
          {credentialSecretName(options)} is required. The others hold your tool credentials.
        </span>
      </div>
      {!hasAgentRunner ? (
        <p role="status" className="rounded border border-amber-600 bg-slate-900 p-3 text-sm text-slate-200">
          No agent container runner found. Claude Code agents need the nest-agents container (docs/CLAUDE_CODE_AGENT.md).
        </p>
      ) : null}
      <details className="rounded border border-slate-800">
        <summary className="cursor-pointer px-3 py-2 text-sm text-slate-300">Generated recipe</summary>
        <pre
          aria-label="Generated recipe"
          className="max-w-full overflow-x-auto whitespace-pre-wrap break-all border-t border-slate-800 p-3 font-mono text-xs text-slate-300"
        >
          {preview}
        </pre>
      </details>
    </div>
  );
}

type AgentsScreenProps = {
  agents: Agent[];
  runners: RunnerNode[];
  skills: SkillMeta[];
  onCreateAgent: (agent: AgentForm) => Promise<void>;
  onUpdateAgent: (name: string, agent: Omit<AgentForm, "name">) => Promise<void>;
  onDeleteAgent: (name: string) => Promise<void>;
  onStartAgent: (name: string) => Promise<void>;
  onStopAgent: (name: string) => Promise<void>;
  onCleanupAgentWorkspace: (name: string) => Promise<void>;
  loadAgentCrossMemory: (
    name: string
  ) => Promise<{ recent: string; full: string; updatedAtRecent?: number; updatedAtFull?: number }>;
  loadAgentEvents: (name: string) => Promise<EventRow[]>;
  loadAgentWorkspace: (
    name: string,
    path?: string
  ) => Promise<AgentWorkspaceListResponse>;
  loadAgentWorkspaceFile: (
    name: string,
    path: string
  ) => Promise<AgentWorkspaceFileResponse>;
  loadAgentSystemPrompt: (
    name: string
  ) => Promise<{
    found: boolean;
    promptText?: string;
    error?: string;
    createdAt?: number;
    channelId?: string | null;
    modelId?: string | null;
    triggerEventId?: string | null;
  }>;
  onDownloadAgentWorkspaceFile: (name: string, path: string) => void;
  focusAgentName?: string | null;
  onFocusAgentApplied?: () => void;
  drawerOnly?: boolean;
};

export function AgentsScreen({
  agents,
  runners,
  skills,
  onCreateAgent,
  onUpdateAgent,
  onDeleteAgent,
  onStartAgent,
  onStopAgent,
  onCleanupAgentWorkspace,
  loadAgentCrossMemory,
  loadAgentEvents,
  loadAgentWorkspace,
  loadAgentWorkspaceFile,
  loadAgentSystemPrompt,
  onDownloadAgentWorkspaceFile,
  focusAgentName,
  onFocusAgentApplied,
  drawerOnly = false
}: AgentsScreenProps) {
  const [modelCatalog, setModelCatalog] = useState<AgentModelCatalog | null>(null);
  const [modelError, setModelError] = useState(false);
  const [modelAttempt, setModelAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setModelError(false);
    void apiFetch('/api/agent-models', {signal:controller.signal}).then(r => r.json()).then(setModelCatalog)
      .catch(() => {if (!controller.signal.aborted) setModelError(true);});
    return () => controller.abort();
  }, [modelAttempt]);
  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [activeTab, setActiveTab] = useState<"details" | "events" | "workspace">(
    "details"
  );
  const [form, setForm] = useState<AgentForm>(DEFAULT_AGENT_FORM);
  const [isFormDirty, setIsFormDirty] = useState(false);
  const [runnerChosen, setRunnerChosen] = useState(false);
  // While false, a new Claude Code agent's workspace follows its name.
  const [workspaceEdited, setWorkspaceEdited] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isTogglingRuntime, setIsTogglingRuntime] = useState(false);
  const [isDeletingAgent, setIsDeletingAgent] = useState(false);
  const [agentEvents, setAgentEvents] = useState<EventRow[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [workspaceData, setWorkspaceData] = useState<AgentWorkspaceListResponse | null>(
    null
  );
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [fileLoadingPath, setFileLoadingPath] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<AgentWorkspaceFileResponse | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [crossMemoryDrawerOpen, setCrossMemoryDrawerOpen] = useState(false);
  const [systemPromptDrawerOpen, setSystemPromptDrawerOpen] = useState(false);
  const [systemPromptLoading, setSystemPromptLoading] = useState(false);
  const [systemPromptError, setSystemPromptError] = useState<string | null>(null);
  const [systemPromptText, setSystemPromptText] = useState("");
  const [systemPromptMeta, setSystemPromptMeta] = useState<{
    createdAt?: number;
    channelId?: string | null;
    modelId?: string | null;
    triggerEventId?: string | null;
  } | null>(null);
  const [crossMemoryLoading, setCrossMemoryLoading] = useState(false);
  const [crossMemoryError, setCrossMemoryError] = useState<string | null>(null);
  const [crossMemory, setCrossMemory] = useState<{
    recent: string;
    full: string;
    updatedAtRecent?: number;
    updatedAtFull?: number;
  } | null>(null);
  const crossMemoryCacheRef = useRef<
    Map<string, { recent: string; full: string; updatedAtRecent?: number; updatedAtFull?: number }>
  >(new Map());
  const systemPromptCacheRef = useRef<
    Map<
      string,
      {
        promptText: string;
        createdAt?: number;
        channelId?: string | null;
        modelId?: string | null;
        triggerEventId?: string | null;
      }
    >
  >(new Map());

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.name === selectedAgentName) ?? null,
    [agents, selectedAgentName]
  );
  const selectedEvent = useMemo(
    () => agentEvents.find((event) => event.id === selectedEventId) ?? null,
    [agentEvents, selectedEventId]
  );
  const publicAgents = agents.filter((agent) => agent.visibility !== "PRIVATE");
  const privateAgents = agents.filter((agent) => agent.visibility === "PRIVATE");
  const drawerOpen = Boolean(selectedAgent || isCreating);
  const eventDetailsDrawerOpen = activeTab === "events" && Boolean(selectedEvent);
  const isWrappedMode = form.mode === "WRAPPED";
  const claudeCode = isWrappedMode ? form.claudeCode ?? null : null;
  const claudeCodeRunnerId = pickClaudeCodeRunner(runners);
  const workspaceSegments =
    workspaceData && workspaceData.path !== "."
      ? workspaceData.path.split("/").filter(Boolean)
      : [];
  const headerValidationMessage =
    !form.name.trim()
      ? "Name is required."
      : !isWrappedMode && !form.modelId.trim() && !(isCreating && modelCatalog?.defaultModel)
        ? "Model is required."
        : !form.workspacePath.trim()
          ? "Workspace directory is required."
          : null;
  const wrappedConfigValidationMessage = useMemo(() => {
    if (form.mode !== "WRAPPED") return null;
    if (form.claudeCode) return readClaudeCodeValidationMessage(form.claudeCode);
    try {
      parseWrappedConfigJson(form.wrappedConfigJson);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Wrapped config must be valid JSON.";
    }
  }, [form.mode, form.wrappedConfigJson, form.claudeCode]);

  useEffect(() => {
    if (isCreating) return;
    if (!selectedAgent) return;
    if (isFormDirty) return;
    setForm({
      name: selectedAgent.name,
      modelId: selectedAgent.modelId ?? "",
      visibility: selectedAgent.visibility === "PRIVATE" ? "PRIVATE" : "PUBLIC",
      mode: selectedAgent.mode ?? "CLASSIC",
      memoryContextMode: selectedAgent.memoryContextMode ?? "PER_CHANNEL_CROSS_CHANNEL",
      emitAuditEvents: selectedAgent.emitAuditEvents !== false,
      llmCallTimeoutMs:
        selectedAgent.llmCallTimeoutMs && selectedAgent.llmCallTimeoutMs > 0
          ? String(selectedAgent.llmCallTimeoutMs)
          : "",
      contextSessionGapMs:
        selectedAgent.contextSessionGapMs && selectedAgent.contextSessionGapMs > 0
          ? String(selectedAgent.contextSessionGapMs)
          : "",
      workspacePath:
        selectedAgent.workspacePath ??
        `.nest-data/workspaces/${selectedAgent.name}`,
      allowOutsideWorkspace: Boolean(selectedAgent.allowOutsideWorkspace),
      assignedRunnerId: selectedAgent.assignedRunnerId ?? "",
      soulContents: selectedAgent.soulContents ?? "",
      enabledSkills: selectedAgent.enabledSkills ?? [],
      alwaysPreloadedSkills: selectedAgent.alwaysPreloadedSkills ?? [],
      wrappedConfigJson: stringifyWrappedConfig(selectedAgent.wrappedConfig),
      claudeCode:
        selectedAgent.mode === "WRAPPED" ? readClaudeCodeOptions(selectedAgent.wrappedConfig) : null
    });
  }, [isCreating, selectedAgent, isFormDirty]);

  useEffect(() => {
    if (!focusAgentName) return;
    if (!agents.some((agent) => agent.name === focusAgentName)) return;
    setSelectedAgentName(focusAgentName);
    setIsCreating(false);
    setActiveTab("details");
    setIsFormDirty(false);
    setSaveStatus(null);
    setPanelError(null);
    setSelectedEventId(null);
    setOpenFile(null);
    setCrossMemoryDrawerOpen(false);
    setSystemPromptDrawerOpen(false);
    setSystemPromptLoading(false);
    setSystemPromptError(null);
    setSystemPromptText("");
    setSystemPromptMeta(null);
    onFocusAgentApplied?.();
  }, [agents, focusAgentName, onFocusAgentApplied]);

  useEffect(() => {
    if (!selectedAgent || isCreating) {
      setAgentEvents([]);
      setSelectedEventId(null);
      setWorkspaceData(null);
      setOpenFile(null);
      setCrossMemoryDrawerOpen(false);
      setSystemPromptDrawerOpen(false);
      setSystemPromptLoading(false);
      setSystemPromptError(null);
      setSystemPromptText("");
      setSystemPromptMeta(null);
      setCrossMemory(null);
      setCrossMemoryError(null);
      setCrossMemoryLoading(false);
      return;
    }
    setPanelError(null);
  }, [selectedAgent, isCreating]);

  const handleNewAgent = () => {
    setSelectedAgentName(null);
    setIsCreating(true);
    setActiveTab("details");
    setForm(DEFAULT_AGENT_FORM);
    setIsFormDirty(false);
    setRunnerChosen(false);
    setWorkspaceEdited(false);
    setSaveStatus(null);
    setPanelError(null);
    setSelectedEventId(null);
    setOpenFile(null);
    setCrossMemoryDrawerOpen(false);
    setSystemPromptDrawerOpen(false);
    setSystemPromptLoading(false);
    setSystemPromptError(null);
    setSystemPromptText("");
    setSystemPromptMeta(null);
  };

  const handleSelectAgent = (name: string) => {
    setSelectedAgentName(name);
    setIsCreating(false);
    setActiveTab("details");
    setIsFormDirty(false);
    setSaveStatus(null);
    setPanelError(null);
    setSelectedEventId(null);
    setOpenFile(null);
    setCrossMemoryDrawerOpen(false);
    setSystemPromptDrawerOpen(false);
    setSystemPromptLoading(false);
    setSystemPromptError(null);
    setSystemPromptText("");
    setSystemPromptMeta(null);
  };

  const closeDrawer = () => {
    setSelectedAgentName(null);
    setIsCreating(false);
    setSaveStatus(null);
    setPanelError(null);
    setSelectedEventId(null);
    setOpenFile(null);
    setCrossMemoryDrawerOpen(false);
  };

  useEscapeKey(
    drawerOpen ||
      eventDetailsDrawerOpen ||
      crossMemoryDrawerOpen ||
      systemPromptDrawerOpen ||
      Boolean(openFile),
    () => {
      if (systemPromptDrawerOpen) {
        setSystemPromptDrawerOpen(false);
        return;
      }
      if (crossMemoryDrawerOpen) {
        setCrossMemoryDrawerOpen(false);
        return;
      }
      if (openFile) {
        setOpenFile(null);
        return;
      }
      if (eventDetailsDrawerOpen) {
        setSelectedEventId(null);
        return;
      }
      if (drawerOpen) {
        closeDrawer();
      }
    }
  );

  const openEventsTab = async () => {
    if (!selectedAgent) return;
    setActiveTab("events");
    setPanelError(null);
    setEventsLoading(true);
    try {
      const data = await loadAgentEvents(selectedAgent.name);
      setAgentEvents(data);
      setSelectedEventId((prev) =>
        prev && data.some((event) => event.id === prev) ? prev : null
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load agent events.";
      setPanelError(message);
    } finally {
      setEventsLoading(false);
    }
  };

  const openWorkspacePath = async (path = ".") => {
    if (!selectedAgent) return;
    setActiveTab("workspace");
    setPanelError(null);
    setWorkspaceLoading(true);
    try {
      const data = await loadAgentWorkspace(selectedAgent.name, path);
      setWorkspaceData(data);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to load workspace contents.";
      setPanelError(message);
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const handleOpenWorkspaceEntry = async (entry: AgentWorkspaceListResponse["entries"][number]) => {
    if (!selectedAgent) return;
    if (entry.kind === "directory") {
      await openWorkspacePath(entry.path);
      return;
    }
    if (!entry.isTextFile) {
      onDownloadAgentWorkspaceFile(selectedAgent.name, entry.path);
      return;
    }
    setPanelError(null);
    setFileLoadingPath(entry.path);
    try {
      const file = await loadAgentWorkspaceFile(selectedAgent.name, entry.path);
      setOpenFile(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load file.";
      setPanelError(message);
    } finally {
      setFileLoadingPath(null);
    }
  };

  const refreshCrossMemory = async (agentName: string) => {
    try {
      setCrossMemoryLoading(true);
      setCrossMemoryError(null);
      const data = await loadAgentCrossMemory(agentName);
      crossMemoryCacheRef.current.set(agentName, data);
      setCrossMemory(data);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load cross-channel memory.";
      setCrossMemoryError(message);
    } finally {
      setCrossMemoryLoading(false);
    }
  };

  const openCrossMemoryDrawer = async () => {
    if (!selectedAgent) return;
    setCrossMemoryDrawerOpen(true);
    setCrossMemoryError(null);
    const cached = crossMemoryCacheRef.current.get(selectedAgent.name);
    if (cached) {
      setCrossMemory(cached);
      setCrossMemoryLoading(false);
      return;
    }
    await refreshCrossMemory(selectedAgent.name);
  };

  const openSystemPromptDrawer = async () => {
    if (!selectedAgent) return;
    setSystemPromptDrawerOpen(true);
    setSystemPromptError(null);
    const cached = systemPromptCacheRef.current.get(selectedAgent.name);
    if (cached) {
      setSystemPromptText(cached.promptText);
      setSystemPromptMeta({
        createdAt: cached.createdAt,
        channelId: cached.channelId,
        modelId: cached.modelId,
        triggerEventId: cached.triggerEventId
      });
      setSystemPromptLoading(false);
      return;
    }
    setSystemPromptLoading(true);
    try {
      const data = await loadAgentSystemPrompt(selectedAgent.name);
      if (!data.found || !data.promptText?.trim()) {
        setSystemPromptText("");
        setSystemPromptMeta(null);
        setSystemPromptError(
          data.error ??
            "No composed prompt found yet for this agent. Wait for the next agent turn, then refresh."
        );
        return;
      }
      const payload = {
        promptText: data.promptText,
        createdAt: data.createdAt,
        channelId: data.channelId,
        modelId: data.modelId,
        triggerEventId: data.triggerEventId
      };
      systemPromptCacheRef.current.set(selectedAgent.name, payload);
      setSystemPromptText(payload.promptText);
      setSystemPromptMeta({
        createdAt: payload.createdAt,
        channelId: payload.channelId,
        modelId: payload.modelId,
        triggerEventId: payload.triggerEventId
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load composed system prompt.";
      setSystemPromptError(message);
    } finally {
      setSystemPromptLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!form.name.trim() || (!isWrappedMode && !form.modelId.trim() && !(isCreating && modelCatalog?.defaultModel)) || !form.workspacePath.trim()) {
      return;
    }
    setIsSubmitting(true);
    setSaveStatus(null);
    try {
      const llmCallTimeoutMs = isWrappedMode
        ? null
        : parseOptionalPositiveIntInput(form.llmCallTimeoutMs, "LLM call timeout");
      const contextSessionGapMs = isWrappedMode
        ? null
        : parseOptionalPositiveIntInput(form.contextSessionGapMs, "Context session gap");
      const claudeCodeError = readClaudeCodeValidationMessage(claudeCode);
      if (claudeCodeError) throw new Error(claudeCodeError);
      const wrappedConfig = claudeCode
        ? buildClaudeCodeWrappedConfig(claudeCode)
        : isWrappedMode
          ? parseWrappedConfigJson(form.wrappedConfigJson)
          : {};
      // The engine stores wrappedConfig; the form-only Claude Code options never leave the browser.
      const { claudeCode: _formOnly, ...fields } = form;
      const modelId = isWrappedMode ? "wrapped:none" : form.modelId.trim() || modelCatalog?.defaultModel || "";
      const memoryContextMode = isWrappedMode ? "OFF" : form.memoryContextMode;
      const emitAuditEvents = isWrappedMode ? true : form.emitAuditEvents;
      const soulContents = isWrappedMode ? "" : form.soulContents;
      const enabledSkills = isWrappedMode ? [] : form.enabledSkills;
      const alwaysPreloadedSkills = isWrappedMode ? [] : form.alwaysPreloadedSkills;
      const allowOutsideWorkspace = isWrappedMode ? false : form.allowOutsideWorkspace;
      if (isCreating) {
        const normalizedName = form.name.trim();
        await onCreateAgent({
          ...fields,
          name: normalizedName,
          modelId,
          visibility: form.visibility,
          mode: form.mode,
          memoryContextMode,
          emitAuditEvents,
          llmCallTimeoutMs: llmCallTimeoutMs === null ? "" : String(llmCallTimeoutMs),
          contextSessionGapMs:
            contextSessionGapMs === null ? "" : String(contextSessionGapMs),
          workspacePath: form.workspacePath.trim(),
          allowOutsideWorkspace,
          assignedRunnerId: form.assignedRunnerId.trim(),
          soulContents,
          enabledSkills,
          alwaysPreloadedSkills,
          wrappedConfigJson: JSON.stringify(wrappedConfig),
          wrappedConfig
        });
        setIsCreating(false);
        setSelectedAgentName(normalizedName);
        setActiveTab("details");
        setIsFormDirty(false);
        setSaveStatus({
          kind: "success",
          message: `Agent "${normalizedName}" was saved successfully.`
        });
        return;
      }
      if (!selectedAgent) return;
      await onUpdateAgent(selectedAgent.name, {
        modelId,
        visibility: form.visibility,
        mode: form.mode,
        memoryContextMode,
        emitAuditEvents,
        llmCallTimeoutMs: llmCallTimeoutMs === null ? "" : String(llmCallTimeoutMs),
        contextSessionGapMs:
          contextSessionGapMs === null ? "" : String(contextSessionGapMs),
        workspacePath: form.workspacePath.trim(),
        allowOutsideWorkspace,
        assignedRunnerId: form.assignedRunnerId.trim(),
        soulContents,
        enabledSkills,
        alwaysPreloadedSkills,
        wrappedConfigJson: JSON.stringify(wrappedConfig),
        wrappedConfig
      });
      setIsFormDirty(false);
      setSaveStatus({
        kind: "success",
        message: `Agent "${selectedAgent.name}" was saved successfully.`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save agent.";
      setSaveStatus({ kind: "error", message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleRuntime = async () => {
    if (!selectedAgent) return;
    const isRunning = selectedAgent.runtimeState === "RUNNING";
    setIsTogglingRuntime(true);
    setSaveStatus(null);
    try {
      if (isRunning) {
        await onStopAgent(selectedAgent.name);
      } else {
        await onStartAgent(selectedAgent.name);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update agent state.";
      setSaveStatus({ kind: "error", message });
    } finally {
      setIsTogglingRuntime(false);
    }
  };

  const handleDeleteAgent = async () => {
    if (!selectedAgent) return;
    const agentName = selectedAgent.name;
    const confirmed = window.confirm(
      `Delete agent "${agentName}"? This removes its runtime state, memory, and channel memberships. This cannot be undone.`
    );
    if (!confirmed) return;
    setIsDeletingAgent(true);
    setSaveStatus(null);
    setPanelError(null);
    try {
      await onDeleteAgent(agentName);
      crossMemoryCacheRef.current.delete(agentName);
      systemPromptCacheRef.current.delete(agentName);
      setSelectedAgentName(null);
      setIsCreating(false);
      setActiveTab("details");
      setForm(DEFAULT_AGENT_FORM);
      setIsFormDirty(false);
      setAgentEvents([]);
      setSelectedEventId(null);
      setWorkspaceData(null);
      setOpenFile(null);
      setCrossMemoryDrawerOpen(false);
      setSystemPromptDrawerOpen(false);
      setCrossMemory(null);
      setSystemPromptText("");
      setSystemPromptMeta(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete agent.";
      setSaveStatus({ kind: "error", message });
    } finally {
      setIsDeletingAgent(false);
    }
  };

  const toggleSkill = (skillName: string) => {
    setIsFormDirty(true);
    setSaveStatus(null);
    setForm((prev) => {
      const exists = prev.enabledSkills.includes(skillName);
      if (exists) {
        return {
          ...prev,
          enabledSkills: prev.enabledSkills.filter((name) => name !== skillName),
          alwaysPreloadedSkills: prev.alwaysPreloadedSkills.filter(
            (name) => name !== skillName
          )
        };
      }
      return { ...prev, enabledSkills: [...prev.enabledSkills, skillName] };
    });
  };

  const toggleAlwaysPreloadedSkill = (skillName: string) => {
    setIsFormDirty(true);
    setSaveStatus(null);
    setForm((prev) => {
      const isEnabled = prev.enabledSkills.includes(skillName);
      if (!isEnabled) {
        return {
          ...prev,
          enabledSkills: [...prev.enabledSkills, skillName],
          alwaysPreloadedSkills: [...prev.alwaysPreloadedSkills, skillName]
        };
      }
      const exists = prev.alwaysPreloadedSkills.includes(skillName);
      if (exists) {
        return {
          ...prev,
          alwaysPreloadedSkills: prev.alwaysPreloadedSkills.filter(
            (name) => name !== skillName
          )
        };
      }
      return {
        ...prev,
        alwaysPreloadedSkills: [...prev.alwaysPreloadedSkills, skillName]
      };
    });
  };

  const renderVisibilityBadge = (agent: Pick<Agent, "visibility">) => (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] ${
        agent.visibility === "PRIVATE"
          ? "border border-violet-700/70 bg-violet-950/40 text-violet-200"
          : "border border-slate-700 bg-slate-900 text-slate-300"
      }`}
    >
      {agent.visibility === "PRIVATE" ? "Private" : "Public"}
    </span>
  );

  const renderAgentRows = (list: Agent[]) =>
    list.map((agent) => (
      <tr
        key={agent.name}
        className={`cursor-pointer border-b border-slate-900 align-top hover:bg-slate-900/40 ${
          selectedAgentName === agent.name && !isCreating ? "bg-slate-900/70" : ""
        }`}
        onClick={() => handleSelectAgent(agent.name)}
      >
        <td className="whitespace-nowrap px-2 py-2">
          {renderVisibilityBadge(agent)}
        </td>
        <td className="whitespace-nowrap px-2 py-2 text-slate-200">
          {agent.name}
        </td>
        <td className="whitespace-nowrap px-2 py-2 text-slate-300">
          {agent.runtimeState}
        </td>
        <td className="whitespace-nowrap px-2 py-2 text-slate-400">
          {agent.desiredState}
        </td>
        <td className="max-w-[220px] truncate px-2 py-2 text-slate-400">
          {formatAgentModelLabel(agent)}
        </td>
        <td className="whitespace-nowrap px-2 py-2 text-slate-400">
          {agent.mode ?? "CLASSIC"}
        </td>
        <td className="whitespace-nowrap px-2 py-2 text-slate-400">
          {agent.memoryContextMode ?? "PER_CHANNEL_CROSS_CHANNEL"}
        </td>
        <td className="whitespace-nowrap px-2 py-2 text-slate-400">
          {agent.assignedRunnerId ?? "-"}
        </td>
        <td className="max-w-[420px] truncate px-2 py-2 text-slate-500">
          {agent.workspacePath ?? "-"}
        </td>
      </tr>
    ));

  return (
    <div className="space-y-4">
      {!drawerOnly ? (
      <Card title={`Agents (${agents.length})`}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-xs text-slate-500">
            Click an agent row to open details, events, and workspace.
          </div>
          <Button onClick={handleNewAgent}>New agent</Button>
        </div>
        <div className="space-y-6 overflow-x-auto">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
              <span>Public agents</span>
              <span className="rounded bg-slate-900 px-1.5 py-0.5 text-slate-400">
                {publicAgents.length}
              </span>
            </div>
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-slate-300">
                <th className="px-2 py-2">Visibility</th>
                <th className="px-2 py-2">Name</th>
                <th className="px-2 py-2">Runtime</th>
                <th className="px-2 py-2">Desired</th>
                <th className="px-2 py-2">Model</th>
                <th className="px-2 py-2">Mode</th>
                <th className="px-2 py-2">Memory Context</th>
                <th className="px-2 py-2">Runner</th>
                <th className="px-2 py-2">Workspace</th>
              </tr>
            </thead>
            <tbody>{renderAgentRows(publicAgents)}</tbody>
          </table>
          {publicAgents.length === 0 && (
            <div className="py-4 text-center text-slate-500">No public agents found.</div>
          )}
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-violet-300">
              <span>Private agents visible to you</span>
              <span className="rounded bg-violet-950/60 px-1.5 py-0.5 text-violet-200">
                {privateAgents.length}
              </span>
            </div>
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-slate-300">
                  <th className="px-2 py-2">Visibility</th>
                  <th className="px-2 py-2">Name</th>
                  <th className="px-2 py-2">Runtime</th>
                  <th className="px-2 py-2">Desired</th>
                  <th className="px-2 py-2">Model</th>
                  <th className="px-2 py-2">Mode</th>
                  <th className="px-2 py-2">Memory Context</th>
                  <th className="px-2 py-2">Runner</th>
                  <th className="px-2 py-2">Workspace</th>
                </tr>
              </thead>
              <tbody>{renderAgentRows(privateAgents)}</tbody>
            </table>
            {privateAgents.length === 0 && (
              <div className="py-4 text-center text-slate-500">
                No private agents visible to you.
              </div>
            )}
          </div>

          {agents.length === 0 && (
            <div className="py-8 text-center text-slate-500">No agents found.</div>
          )}
        </div>
      </Card>
      ) : null}

      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity lg:left-56 ${
          drawerOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={closeDrawer}
      />

      <aside
        className={`fixed bottom-0 right-0 top-0 z-50 w-full max-w-4xl border-l border-slate-800 bg-slate-950 shadow-2xl transition-transform duration-300 ${
          drawerOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!drawerOpen}
      >
        <div className="relative flex h-full flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                {isCreating
                  ? "Create Agent"
                  : selectedAgent
                    ? `Agent: ${selectedAgent.name}`
                    : "Agent"}
              </h3>
              <p className="text-xs text-slate-500">
                {isCreating
                  ? "Set up a new agent."
                  : selectedAgent
                    ? `${selectedAgent.runtimeState} | ${formatAgentModelLabel(selectedAgent)} | ${
                        selectedAgent.visibility === "PRIVATE" ? "Private" : "Public"
                      }`
                    : "Select an agent row."}
              </p>
              {activeTab === "details" && (isCreating || selectedAgent) ? (
                <p
                  className={`mt-1 text-xs ${
                    saveStatus
                      ? saveStatus.kind === "success"
                        ? "text-emerald-300"
                        : "text-rose-400"
                      : headerValidationMessage
                        ? "text-amber-300"
                        : "text-slate-500"
                  }`}
                >
                  {saveStatus?.message ??
                    headerValidationMessage ??
                    (isFormDirty ? "Unsaved changes." : "No unsaved changes.")}
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {activeTab === "details" && (isCreating || selectedAgent) ? (
                <>
                  <Button
                    onClick={handleSubmit}
                    disabled={
                      isSubmitting ||
                      (!isCreating && !isFormDirty) ||
                      !form.name.trim() ||
                      (!isWrappedMode && !form.modelId.trim() && !(isCreating && modelCatalog?.defaultModel)) ||
                      !form.workspacePath.trim() ||
                      Boolean(wrappedConfigValidationMessage)
                    }
                  >
                    {isSubmitting
                      ? isCreating
                        ? "Creating..."
                        : "Saving..."
                      : isCreating
                        ? "Create Agent"
                        : "Save Details"}
                  </Button>
                  {!isCreating && selectedAgent && (
                    <Button
                      variant="secondary"
                      onClick={handleToggleRuntime}
                      disabled={isTogglingRuntime}
                    >
                      {isTogglingRuntime
                        ? selectedAgent.runtimeState === "RUNNING"
                          ? "Stopping..."
                          : "Starting..."
                        : selectedAgent.runtimeState === "RUNNING"
                          ? "Stop"
                          : "Start"}
                    </Button>
                  )}
                </>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                className="px-2 py-1 text-xs"
                onClick={closeDrawer}
              >
                Close
              </Button>
            </div>
          </div>

          <div className="flex shrink-0 gap-2 border-b border-slate-800 px-4 py-3">
            <Button
              variant={activeTab === "details" ? "primary" : "secondary"}
              className="px-3 py-1 text-xs"
              onClick={() => setActiveTab("details")}
            >
              Details
            </Button>
            <Button
              variant={activeTab === "events" ? "primary" : "secondary"}
              className="px-3 py-1 text-xs"
              onClick={openEventsTab}
              disabled={!selectedAgent}
            >
              Events
            </Button>
            <Button
              variant={activeTab === "workspace" ? "primary" : "secondary"}
              className="px-3 py-1 text-xs"
              onClick={() => openWorkspacePath(".")}
              disabled={!selectedAgent}
            >
              Workspace
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
            {activeTab === "details" && (
              <div className="space-y-4">
                {!isCreating && !selectedAgent ? (
                  <div className="text-sm text-slate-500">
                    Select an existing agent or create a new one.
                  </div>
                ) : (
                  <>
                    {!isWrappedMode && !isCreating && selectedAgent && (
                      <div className="rounded border border-slate-800 bg-slate-950 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm text-slate-300">Cross-Channel Memory</div>
                          <Button
                            type="button"
                            variant="secondary"
                            className="px-2 py-1 text-xs"
                            onClick={() => {
                              void openCrossMemoryDrawer();
                            }}
                          >
                            View memory
                          </Button>
                        </div>
                      </div>
                    )}
                    {!isWrappedMode ? (
                    <div className="rounded border border-slate-800 bg-slate-950 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm text-slate-300">System Prompt</div>
                        <Button
                          type="button"
                          variant="secondary"
                          className="px-2 py-1 text-xs"
                          onClick={() => {
                            void openSystemPromptDrawer();
                          }}
                          disabled={!selectedAgent}
                        >
                          View system prompt
                        </Button>
                      </div>
                    </div>
                    ) : null}
                    <div className="space-y-1">
                      <div className="text-sm text-slate-400">Name</div>
                      <Input
                        value={form.name}
                        disabled={!isCreating}
                        onChange={(e) => {
                          setIsFormDirty(true);
                          setSaveStatus(null);
                          const name = e.target.value;
                          setForm((prev) => ({
                            ...prev,
                            name,
                            workspacePath:
                              isCreating && prev.mode === "WRAPPED" && prev.claudeCode && !workspaceEdited
                                ? defaultClaudeCodeWorkspace(name)
                                : prev.workspacePath
                          }));
                        }}
                        placeholder="Agent name"
                      />
                    </div>
                    {!isWrappedMode ? (
                    <div className="space-y-1">
                      <div className="text-sm text-slate-400">Model</div>
                      <select
                        aria-label="Language model"
                        value={form.modelId}
                        disabled={!modelCatalog}
                        onChange={(e) => {
                          setIsFormDirty(true);
                          setSaveStatus(null);
                          setForm((prev) => ({ ...prev, modelId: e.target.value }));
                        }}
                        className="w-full min-w-0 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                      >
                        {isCreating && <option value="">{modelCatalog?.defaultModel ? `Instance default · ${modelCatalog.defaultModel}` : 'Choose a model'}</option>}
                        {!isCreating && !modelCatalog?.models.some(m => m.reference === form.modelId) && <option value={form.modelId}>{form.modelId || 'Not configured'} (current)</option>}
                        {modelCatalog?.models.map(m => <option key={m.id} value={m.reference}>{m.name} · {m.provider}</option>)}
                      </select>
                      {!modelCatalog && !modelError && <p role="status">Loading models…</p>}
                      {modelError && <p role="alert">Could not load models. <button type="button" onClick={() => setModelAttempt(n => n + 1)}>Retry models</button></p>}
                      {modelCatalog?.models.length === 0 && <p>No enabled models. Configure a model before creating a native agent.</p>}
                    </div>
                    ) : null}
                    <div className="space-y-1">
                      <div className="text-sm text-slate-400">Visibility</div>
                      <select
                        value={form.visibility}
                        onChange={(e) => {
                          setIsFormDirty(true);
                          setSaveStatus(null);
                          setForm((prev) => ({
                            ...prev,
                            visibility: e.target.value === "PRIVATE" ? "PRIVATE" : "PUBLIC"
                          }));
                        }}
                        className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                      >
                        <option value="PUBLIC">Public (discoverable by everyone)</option>
                        <option value="PRIVATE">
                          Private (owner + humans sharing a channel)
                        </option>
                      </select>
                      <p className="text-xs text-slate-500">
                        Private agents can still participate in channels but are hidden from global discovery.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <div className="text-sm text-slate-400">Mode</div>
                      <select
                        aria-label="Mode"
                        value={claudeCode ? "CLAUDE_CODE" : form.mode}
                        onChange={(e) => {
                          setIsFormDirty(true);
                          setSaveStatus(null);
                          const isClaudeCode = e.target.value === "CLAUDE_CODE";
                          const nextMode =
                            e.target.value === "WRAPPED" || isClaudeCode
                              ? "WRAPPED"
                              : e.target.value === "RLM_REPL"
                                ? "RLM_REPL"
                                : "CLASSIC";
                          setForm((prev) => ({
                            ...prev,
                            mode: nextMode,
                            modelId:
                              nextMode === "WRAPPED"
                                ? "wrapped:none"
                                : prev.modelId === "wrapped:none"
                                  ? ""
                                  : prev.modelId,
                            claudeCode: isClaudeCode
                              ? prev.claudeCode ?? DEFAULT_CLAUDE_CODE_OPTIONS
                              : null,
                            // Claude Code belongs in the agent container, not on the Nest container's runner.
                            assignedRunnerId:
                              isClaudeCode && isCreating && !runnerChosen
                                ? claudeCodeRunnerId
                                : prev.assignedRunnerId,
                            workspacePath:
                              isClaudeCode &&
                              isCreating &&
                              !workspaceEdited &&
                              [SHARED_DEFAULT_WORKSPACE, ""].includes(prev.workspacePath.trim())
                                ? defaultClaudeCodeWorkspace(prev.name)
                                : prev.workspacePath
                          }));
                        }}
                        className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                      >
                        <option value="CLASSIC">CLASSIC</option>
                        <option value="RLM_REPL">RLM_REPL</option>
                        <option value="WRAPPED">WRAPPED</option>
                        <option value="CLAUDE_CODE">Claude Code</option>
                      </select>
                      {claudeCode ? (
                        <p className="text-xs text-slate-500">
                          Claude Code runs in the agent container under its own account. Nest builds its runtime recipe from the settings below.
                        </p>
                      ) : form.mode === "WRAPPED" ? (
                        <p className="text-xs text-slate-500">
                          Wrapped agents use an external runtime harness. Nest manages lifecycle and routing.
                        </p>
                      ) : null}
                    </div>
                    {claudeCode ? (
                      <ClaudeCodeFields
                        agentName={form.name}
                        options={claudeCode}
                        hasAgentRunner={Boolean(claudeCodeRunnerId)}
                        onChange={(options) => {
                          setIsFormDirty(true);
                          setSaveStatus(null);
                          setForm((prev) => ({ ...prev, claudeCode: options }));
                        }}
                      />
                    ) : null}
                    {form.mode === "WRAPPED" && !claudeCode ? (
                      <div className="space-y-2 rounded border border-slate-800 bg-slate-950 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div className="text-sm text-slate-300">Wrapped runtime config</div>
                            <p className="text-xs text-slate-500">
                              JSON object passed to the selected wrapper harness. Use `harness: "command"` for command recipes.
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="secondary"
                            className="px-2 py-1 text-xs"
                            onClick={() => {
                              setIsFormDirty(true);
                              setSaveStatus(null);
                              setForm((prev) => ({
                                ...prev,
                                wrappedConfigJson: DEFAULT_WRAPPED_CONFIG
                              }));
                            }}
                          >
                            Reset template
                          </Button>
                        </div>
                        <Textarea
                          rows={14}
                          value={form.wrappedConfigJson}
                          onChange={(e) => {
                            setIsFormDirty(true);
                            setSaveStatus(null);
                            setForm((prev) => ({
                              ...prev,
                              wrappedConfigJson: e.target.value
                            }));
                          }}
                          className="font-mono text-xs"
                          placeholder={DEFAULT_WRAPPED_CONFIG}
                        />
                        <div
                          className={`text-xs ${
                            wrappedConfigValidationMessage ? "text-rose-400" : "text-slate-500"
                          }`}
                        >
                          {wrappedConfigValidationMessage ??
                            "Valid JSON. Setup/runtime commands execute on the runner host."}
                        </div>
                      </div>
                    ) : null}
                    {!isWrappedMode ? (
                    <div className="space-y-1">
                      <div className="text-sm text-slate-400">Memory context mode</div>
                      <select
                        value={form.memoryContextMode}
                        onChange={(e) => {
                          setIsFormDirty(true);
                          setSaveStatus(null);
                          const mode = e.target.value;
                          setForm((prev) => ({
                            ...prev,
                            memoryContextMode:
                              mode === "FULL_CHANNEL_EVENTS"
                                ? "FULL_CHANNEL_EVENTS"
                                : mode === "OFF"
                                  ? "OFF"
                                  : "PER_CHANNEL_CROSS_CHANNEL"
                          }));
                        }}
                        className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                      >
                        <option value="PER_CHANNEL_CROSS_CHANNEL">
                          PER_CHANNEL_CROSS_CHANNEL
                        </option>
                        <option value="FULL_CHANNEL_EVENTS">FULL_CHANNEL_EVENTS</option>
                        <option value="OFF">OFF</option>
                      </select>
                    </div>
                    ) : null}
                    {!isWrappedMode ? (
                    <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        checked={form.emitAuditEvents}
                        onChange={(e) => {
                          setIsFormDirty(true);
                          setSaveStatus(null);
                          setForm((prev) => ({
                            ...prev,
                            emitAuditEvents: e.target.checked
                          }));
                        }}
                      />
                      <span>Emit observability/debug audit events for this agent</span>
                    </label>
                    ) : null}
                    <div className="space-y-1">
                      <div className="text-sm text-slate-400">Assigned runner</div>
                      <select
                        value={form.assignedRunnerId}
                        aria-label="Assigned runner"
                        onChange={(e) => {
                          setIsFormDirty(true);
                          setRunnerChosen(true);
                          setSaveStatus(null);
                          setForm((prev) => ({
                            ...prev,
                            assignedRunnerId: e.target.value
                          }));
                        }}
                        className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                      >
                        <option value="">Unassigned</option>
                        {runners.map((runner) => (
                          <option key={runner.id} value={runner.id}>
                            {runner.displayName} ({runner.online ? "online" : "offline"})
                          </option>
                        ))}
                      </select>
                    </div>
                    {!isWrappedMode ? (
                    <div className="space-y-1">
                      <div className="text-sm text-slate-400">LLM call timeout (ms)</div>
                      <Input
                        value={form.llmCallTimeoutMs}
                        onChange={(e) => {
                          setIsFormDirty(true);
                          setSaveStatus(null);
                          setForm((prev) => ({ ...prev, llmCallTimeoutMs: e.target.value }));
                        }}
                        placeholder="Leave empty to use system default (10800000)"
                      />
                    </div>
                    ) : null}
                    {!isWrappedMode ? (
                    <div className="space-y-1">
                      <div className="text-sm text-slate-400">
                        Session gap threshold (ms)
                      </div>
                      <Input
                        value={form.contextSessionGapMs}
                        onChange={(e) => {
                          setIsFormDirty(true);
                          setSaveStatus(null);
                          setForm((prev) => ({
                            ...prev,
                            contextSessionGapMs: e.target.value,
                          }));
                        }}
                        placeholder="Leave empty to use default (300000)"
                      />
                    </div>
                    ) : null}
                    <div className="space-y-1">
                      <div className="text-sm text-slate-400">Workspace directory</div>
                      <Input
                        value={form.workspacePath}
                        onChange={(e) => {
                          setIsFormDirty(true);
                          setSaveStatus(null);
                          setWorkspaceEdited(true);
                          setForm((prev) => ({ ...prev, workspacePath: e.target.value }));
                        }}
                        aria-label="Workspace directory"
                        placeholder=".nest-data/workspaces/agent-name"
                      />
                    </div>
                    {!isWrappedMode ? (
                    <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        checked={form.allowOutsideWorkspace}
                        onChange={(e) => {
                          setIsFormDirty(true);
                          setSaveStatus(null);
                          setForm((prev) => ({
                            ...prev,
                            allowOutsideWorkspace: e.target.checked
                          }));
                        }}
                      />
                      <span>Allow access outside workspace (full host filesystem)</span>
                    </label>
                    ) : null}
                    {!isWrappedMode ? (
                    <div className="space-y-2">
                      <div className="text-sm text-slate-400">Enabled skills</div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {skills.map((skill) => (
                          <div
                            key={skill.path}
                            className="flex items-start gap-2 rounded border border-slate-800 bg-slate-950 px-2 py-2 text-sm text-slate-300"
                          >
                            <div className="space-y-2">
                              <div className="leading-tight">
                                <span className="block text-slate-200">{skill.name}</span>
                                <span className="text-xs text-slate-500">{skill.description}</span>
                              </div>
                              <label className="flex items-center gap-2 text-xs text-slate-300">
                                <input
                                  type="checkbox"
                                  checked={form.enabledSkills.includes(skill.name)}
                                  onChange={() => toggleSkill(skill.name)}
                                  className="mt-0.5"
                                />
                                <span>Enabled</span>
                              </label>
                              <label className="flex items-center gap-2 text-xs text-slate-300">
                                <input
                                  type="checkbox"
                                  checked={form.alwaysPreloadedSkills.includes(skill.name)}
                                  onChange={() => toggleAlwaysPreloadedSkill(skill.name)}
                                  className="mt-0.5"
                                />
                                <span>Always pre-load into context</span>
                              </label>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    ) : null}
                    {!isWrappedMode ? (
                    <div className="space-y-1">
                      <div className="text-sm text-slate-400">SOUL contents</div>
                      <Textarea
                        rows={12}
                        value={form.soulContents}
                        onChange={(e) => {
                          setIsFormDirty(true);
                          setSaveStatus(null);
                          setForm((prev) => ({ ...prev, soulContents: e.target.value }));
                        }}
                        placeholder="System-level guidance and behavior instructions."
                      />
                    </div>
                    ) : null}
                    {isFormDirty && (
                      <div className="text-sm text-amber-300">Unsaved changes.</div>
                    )}
                    {saveStatus && (
                      <div
                        className={`text-sm ${
                          saveStatus.kind === "success" ? "text-emerald-300" : "text-rose-400"
                        }`}
                      >
                        {saveStatus.message}
                      </div>
                    )}
                    {!isCreating && selectedAgent && (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="secondary"
                          className="bg-amber-900 text-amber-100 hover:bg-amber-800"
                          onClick={async () => {
                            const confirmed = confirm(
                              `Clean workspace for ${selectedAgent.name}? This deletes all files in ${form.workspacePath}.`
                            );
                            if (!confirmed) return;
                            await onCleanupAgentWorkspace(selectedAgent.name);
                            await openWorkspacePath(".");
                          }}
                        >
                          Clean Workspace
                        </Button>
                        <Button
                          variant="secondary"
                          className="bg-rose-900 text-rose-100 hover:bg-rose-800"
                          onClick={handleDeleteAgent}
                          disabled={isDeletingAgent}
                        >
                          {isDeletingAgent ? "Deleting..." : "Delete Agent"}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {activeTab === "events" && (
              <div className="space-y-2 rounded border border-slate-800 bg-slate-950 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm text-slate-300">Agent Events</h3>
                  <Button
                    variant="secondary"
                    className="px-2 py-1 text-xs"
                    onClick={openEventsTab}
                    disabled={!selectedAgent || eventsLoading}
                  >
                    Refresh
                  </Button>
                </div>
                <div className="max-h-full space-y-2 overflow-auto pr-1 text-sm">
                  {eventsLoading && (
                    <div className="text-sm text-slate-500">Loading events...</div>
                  )}
                  {!eventsLoading &&
                    agentEvents.map((event) => (
                      <button
                        type="button"
                        key={event.id}
                        className={`w-full rounded border-b border-slate-800 px-2 py-2 text-left hover:bg-slate-900/40 ${
                          selectedEventId === event.id ? "bg-slate-900/70" : ""
                        }`}
                        onClick={() => setSelectedEventId(event.id)}
                      >
                        <div className="text-slate-300">{event.type}</div>
                        <div className="text-xs text-slate-500">
                          {event.source} | {formatTimestamp(event.createdAt)}
                        </div>
                      </button>
                    ))}
                  {!eventsLoading && agentEvents.length === 0 && (
                    <div className="text-sm text-slate-500">No events found for this agent.</div>
                  )}
                </div>
              </div>
            )}

            {activeTab === "workspace" && (
              <div className="space-y-3 rounded border border-slate-800 bg-slate-950 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Button
                    variant="secondary"
                    className="px-2 py-1 text-xs"
                    onClick={() => openWorkspacePath(".")}
                    disabled={!selectedAgent || workspaceLoading}
                  >
                    Root
                  </Button>
                  {workspaceSegments.map((segment, index) => {
                    const path = workspaceSegments.slice(0, index + 1).join("/");
                    return (
                      <Button
                        key={path}
                        variant="secondary"
                        className="px-2 py-1 text-xs"
                        onClick={() => openWorkspacePath(path)}
                        disabled={!selectedAgent || workspaceLoading}
                      >
                        {segment}
                      </Button>
                    );
                  })}
                </div>

                {workspaceLoading && (
                  <div className="text-sm text-slate-500">Loading workspace...</div>
                )}

                {!workspaceLoading && workspaceData && (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-800 text-left text-slate-300">
                          <th className="px-2 py-2">Name</th>
                          <th className="px-2 py-2">Kind</th>
                          <th className="px-2 py-2">Size</th>
                          <th className="px-2 py-2">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workspaceData.entries.map((entry) => (
                          <tr
                            key={entry.path}
                            className="cursor-pointer border-b border-slate-900 hover:bg-slate-900/40"
                            onClick={() => handleOpenWorkspaceEntry(entry)}
                          >
                            <td className="px-2 py-2 text-slate-200">{entry.name}</td>
                            <td className="px-2 py-2 text-slate-400">{entry.kind}</td>
                            <td className="whitespace-nowrap px-2 py-2 text-slate-500">
                              {entry.kind === "file" ? (entry.size ?? "-") : "-"}
                            </td>
                            <td className="px-2 py-2 text-slate-300">
                              {entry.kind === "directory"
                                ? "Open"
                                : entry.isTextFile
                                  ? fileLoadingPath === entry.path
                                    ? "Opening..."
                                    : "Preview"
                                  : "Download"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {workspaceData.entries.length === 0 && (
                      <div className="py-6 text-center text-sm text-slate-500">
                        This folder is empty.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {panelError && (
              <div className="rounded border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
                {panelError}
              </div>
            )}
          </div>

          <div
            className={`absolute inset-0 z-10 flex justify-end bg-black/30 transition-opacity ${
              eventDetailsDrawerOpen
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none opacity-0"
            }`}
            onClick={() => setSelectedEventId(null)}
          >
            <div
              className={`pointer-events-auto flex h-full w-full max-w-2xl flex-col border-l border-slate-800 bg-slate-950 shadow-2xl transition-transform duration-300 ${
                eventDetailsDrawerOpen ? "translate-x-0" : "translate-x-full"
              }`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                <div>
                  <h4 className="text-sm font-semibold text-slate-100">Event Details</h4>
                  <p className="text-xs text-slate-500">
                    {selectedEvent ? selectedEvent.id : "No event selected"}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  className="px-2 py-1 text-xs"
                  onClick={() => setSelectedEventId(null)}
                >
                  Back
                </Button>
              </div>

              {selectedEvent ? (
                <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-4 text-sm">
                  <div className="rounded border border-slate-800 bg-slate-950 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Type</div>
                    <div className="mt-1 text-slate-200">{selectedEvent.type}</div>
                  </div>
                  <div className="rounded border border-slate-800 bg-slate-950 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Source</div>
                    <div className="mt-1 break-all text-slate-200">{selectedEvent.source}</div>
                  </div>
                  <div className="rounded border border-slate-800 bg-slate-950 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Created</div>
                    <div className="mt-1 text-slate-200">
                      {formatTimestamp(selectedEvent.createdAt)}
                    </div>
                  </div>
                  <div className="rounded border border-slate-800 bg-slate-950 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Status</div>
                    <div className="mt-1 text-slate-200">{selectedEvent.status ?? "N/A"}</div>
                  </div>
                  <div className="rounded border border-slate-800 bg-slate-950 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Channel ID</div>
                    <div className="mt-1 break-all text-slate-200">
                      {selectedEvent.channelId ?? "N/A"}
                    </div>
                  </div>
                  <div className="rounded border border-slate-800 bg-slate-950 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">
                      Deliver At
                    </div>
                    <div className="mt-1 text-slate-200">
                      {selectedEvent.deliverAt ? formatTimestamp(selectedEvent.deliverAt) : "N/A"}
                    </div>
                  </div>
                  <div className="rounded border border-slate-800 bg-slate-950 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Payload</div>
                    <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-900 p-2 text-xs text-slate-300">
                      {JSON.stringify(selectedEvent.payload ?? {}, null, 2)}
                    </pre>
                  </div>
                  {selectedEvent.lastError ? (
                    <div className="rounded border border-rose-900/60 bg-rose-950/20 p-3">
                      <div className="text-xs uppercase tracking-wide text-rose-400">
                        Last Error
                      </div>
                      <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-900 p-2 text-xs text-rose-300">
                        {selectedEvent.lastError}
                      </pre>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div
            className={`absolute inset-0 z-20 flex justify-end bg-black/35 transition-opacity ${
              crossMemoryDrawerOpen
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none opacity-0"
            }`}
            onClick={() => setCrossMemoryDrawerOpen(false)}
          >
            <div
              className={`pointer-events-auto flex h-full w-full max-w-3xl flex-col border-l border-slate-800 bg-slate-950 shadow-2xl transition-transform duration-300 ${
                crossMemoryDrawerOpen ? "translate-x-0" : "translate-x-full"
              }`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                <div>
                  <h4 className="text-sm font-semibold text-slate-100">Cross-Channel Memory</h4>
                  <p className="text-xs text-slate-500">
                    {selectedAgent ? selectedAgent.name : "No agent selected"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    className="px-2 py-1 text-xs"
                    disabled={!selectedAgent || crossMemoryLoading}
                    onClick={() => {
                      if (!selectedAgent) return;
                      void refreshCrossMemory(selectedAgent.name);
                    }}
                  >
                    Refresh
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    className="px-2 py-1 text-xs"
                    onClick={() => setCrossMemoryDrawerOpen(false)}
                  >
                    Close
                  </Button>
                </div>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-4">
                {crossMemoryLoading ? (
                  <div className="text-sm text-slate-500">Loading cross-channel memory...</div>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded border border-slate-800 bg-slate-900 p-3">
                      <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">Recent</div>
                      <div className="whitespace-pre-wrap text-sm text-slate-200">
                        {crossMemory?.recent?.trim() || "No recent cross-channel memory yet."}
                      </div>
                      <div className="mt-2 text-[11px] text-slate-500">
                        Updated: {formatTimestamp(crossMemory?.updatedAtRecent)}
                      </div>
                    </div>
                    <div className="rounded border border-slate-800 bg-slate-900 p-3">
                      <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">Full</div>
                      <div className="whitespace-pre-wrap text-sm text-slate-200">
                        {crossMemory?.full?.trim() || "No full cross-channel memory yet."}
                      </div>
                      <div className="mt-2 text-[11px] text-slate-500">
                        Updated: {formatTimestamp(crossMemory?.updatedAtFull)}
                      </div>
                    </div>
                  </div>
                )}
                {crossMemoryError ? (
                  <div className="rounded border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
                    {crossMemoryError}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div
            className={`absolute inset-0 z-30 flex justify-end bg-black/35 transition-opacity ${
              systemPromptDrawerOpen
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none opacity-0"
            }`}
            onClick={() => setSystemPromptDrawerOpen(false)}
          >
            <div
              className={`pointer-events-auto flex h-full w-full max-w-3xl flex-col border-l border-slate-800 bg-slate-950 shadow-2xl transition-transform duration-300 ${
                systemPromptDrawerOpen ? "translate-x-0" : "translate-x-full"
              }`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                <div>
                  <h4 className="text-sm font-semibold text-slate-100">System Prompt</h4>
                  <p className="text-xs text-slate-500">
                    {selectedAgent ? selectedAgent.name : "New agent"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    className="px-2 py-1 text-xs"
                    disabled={!selectedAgent || systemPromptLoading}
                    onClick={() => {
                      if (!selectedAgent) return;
                      systemPromptCacheRef.current.delete(selectedAgent.name);
                      void openSystemPromptDrawer();
                    }}
                  >
                    Refresh
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    className="px-2 py-1 text-xs"
                    onClick={() => setSystemPromptDrawerOpen(false)}
                  >
                    Close
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-auto px-4 py-4">
                <div className="text-xs text-slate-500">
                  Read-only prompt captured from the runner during the latest turn.
                </div>
                {systemPromptMeta && (
                  <div className="rounded border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-400">
                    Captured: {formatTimestamp(systemPromptMeta.createdAt)} | Model:{" "}
                    {systemPromptMeta.modelId ?? "unknown"} | Channel:{" "}
                    {systemPromptMeta.channelId ?? "unknown"}
                  </div>
                )}
                {systemPromptLoading ? (
                  <div className="text-sm text-slate-500">Loading composed prompt...</div>
                ) : (
                  <Textarea
                    rows={18}
                    value={systemPromptText}
                    readOnly
                    placeholder="No composed prompt found yet for this agent."
                  />
                )}
                {systemPromptError ? (
                  <div className="rounded border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
                    {systemPromptError}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </aside>

      <aside
        className={`fixed bottom-0 left-0 top-0 z-[60] w-full max-w-3xl border-r border-slate-700 bg-slate-950 shadow-2xl transition-transform duration-300 ${
          openFile ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-hidden={!openFile}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">{openFile?.name}</h3>
              <p className="text-xs text-slate-500">{openFile?.path}</p>
            </div>
            <Button
              variant="secondary"
              className="px-2 py-1 text-xs"
              onClick={() => setOpenFile(null)}
            >
              Back
            </Button>
          </div>
          <div className="border-b border-slate-800 px-4 py-2 text-xs text-slate-500">
            {openFile ? `${openFile.size} bytes | ${formatTimestamp(openFile.modifiedAt)}` : ""}
          </div>
          <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs text-slate-200">
            {openFile?.content}
          </pre>
        </div>
      </aside>
    </div>
  );
}
