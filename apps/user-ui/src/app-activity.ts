// Which outside apps an agent used in a chat, and whether each call read or changed something there.
// Worked out in the browser from engine tool.* events; Nest keeps no copy.
//
// Privacy: only payload.tool and payload.args.command (or .cmd) are read, never payload.output. An AppCall
// holds an app, an action name and (for gh) a repo, never the command text, its arguments or any result.
import {actionName,connectionAppName} from './components/connection-names';

export type AppCall = {
  id: string; channelId: string; agent: string; at: number;
  app: string; appName: string; action: string;
  kind: 'read' | 'change'; label: string | null;
  state: 'running' | 'done' | 'failed';
};
export type ToolPhase = 'started' | 'executed' | 'failed';
export type ToolEvent = {id: string; type: string; source: string; channelId?: string; createdAt?: number; payload?: unknown};
export type Classified = Omit<AppCall, 'state'> & {phase: ToolPhase};
/** What the browser holds per tool event: a Classified plus an opaque pairing key (a hash, not the command). */
export type Inspected = Classified & {key: string};
export type AppSummary = {apps: {app: string; appName: string; reads: number; changes: number; running: boolean}[]; reads: number; changes: number};

/** An unpaired tool.started older than this is taken to have failed. */
export const RUNNING_MAX_MS = 10 * 60_000;

const PHASES: Record<string, ToolPhase> = {'tool.started': 'started', 'tool.executed': 'executed', 'tool.failed': 'failed'};
const READ_VERBS = new Set('GET LIST FETCH SEARCH FIND READ QUERY DOWNLOAD EXPORT VIEW'.split(' '));
const CHANGE_WORDS = new Set('CREATE ADD SEND POST UPDATE PATCH DELETE REMOVE MOVE ARCHIVE REPLY FORWARD UPLOAD SET MERGE CLOSE'.split(' '));
const GH_READS = new Set('view list status diff checks search'.split(' '));
const GH_GROUPS = new Set('pr issue api repo run release workflow search gist auth label project status browse codespace cache secret variable ruleset org extension alias config attestation ssh-key gpg-key'.split(' '));
const CONNECTION_TOKEN = /connections\.mjs\s+execute/g;
const CONNECTION = /connections\.mjs\s+execute\s+(\S+)\s+([A-Z0-9_]+)/g;
const GH = /(?<![\w.-])gh\s+([^;&|\n\r()`$<>]*)/g;
/** Every gh token, known subcommand or not: more than one invocation in a command makes it a change. */
const GH_TOKEN = /(?<![\w.-])gh(?=\s|$)/g;
/** Command substitution and process substitution can hide a second invocation. */
const SUBSTITUTION = /`|\$\(|<\(|>\(/;
/** A pipe into a shell or evaluator, `${`, or a variable in command position can run something not visible here. */
const INDIRECT = [/\|&?\s*(?:\S*\/)?(?:sh|bash|zsh|eval|xargs|source)(?=[\s;&|)]|$)/, /\$\{/, /(?:^|[;&|(\n\r])\s*\$[A-Za-z_]/];
const REPO = /^(?:[\w.-]+\/)?[\w.-]+\/[\w.-]+$/;

const composioKind = (slug: string): 'read' | 'change' => {
  const [, verb, ...later] = slug.split('_');
  return verb !== undefined && READ_VERBS.has(verb) && !later.some(word => CHANGE_WORDS.has(word)) ? 'read' : 'change';
};

type Gh = {kind: 'read' | 'change'; repo: string | null; known: boolean; action: string};
function parseGh(args: string): Gh {
  const tokens = args.split(/\s+/).filter(Boolean);
  const positional: string[] = [];
  let repo: string | null = null, method: string | null = null, body = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], next = tokens[i + 1];
    if (token === '-R' || token === '--repo') { if (next) { repo ??= next; i++; } continue; }
    if (token.startsWith('--repo=')) { repo ??= token.slice(7) || null; continue; }
    if (token.startsWith('-R') && token.length > 2) { repo ??= token.slice(2); continue; }
    if (token === '-X' || token === '--method') { if (next) { method = next.toUpperCase(); i++; } continue; }
    if (token.startsWith('--method=')) { method = token.slice(9).toUpperCase(); continue; }
    if (token.startsWith('-X') && token.length > 2) { method = token.slice(2).toUpperCase(); continue; }
    // gh api sends a body, and so defaults to POST, when given fields or an input file.
    if (/^(-f|-F|--field|--raw-field|--input)/.test(token)) { body = true; continue; }
    if (!token.startsWith('-')) positional.push(token);
  }
  const [group, sub] = positional;
  const known = group !== undefined && GH_GROUPS.has(group);
  repo = repo !== null && REPO.test(repo) ? repo : null;
  // Only the group and subcommand are kept, never a path, flag or value.
  if (group === 'api') {
    const graphql = sub === 'graphql';
    // A graphql body can arrive on stdin, so it is a read only when explicitly GET.
    const read = method === 'GET' || (method === null && !body && !graphql);
    return {kind: read ? 'read' : 'change', repo, known, action: graphql ? 'api graphql' : 'api'};
  }
  const action = known && sub !== undefined && /^[a-z][a-z-]*$/.test(sub) ? `${group} ${sub}` : group ?? 'gh';
  const read = group === 'search' || group === 'status' || (sub !== undefined && GH_READS.has(sub));
  return {kind: read ? 'read' : 'change', repo, known, action};
}

/**
 * Whether a call reads or changes something outside Nest. Anything uncertain is a change.
 * `text` is a connected-app action slug (GMAIL_FETCH_EMAILS), or else the arguments to gh.
 */
export function kindFor(_app: string, text: string): 'read' | 'change' {
  return /^[A-Z0-9_]+$/.test(text) ? composioKind(text) : parseGh(text).kind;
}

/** FNV-1a: pairs a tool.started with its result without keeping the command text. */
function fingerprint(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${text.length}:${hash.toString(36)}`;
}

/** Reads payload.tool and payload.args only. */
function commandOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as {tool?: unknown; args?: unknown};
  if (p.tool !== 'shell_run' || !p.args || typeof p.args !== 'object') return null;
  const args = p.args as {command?: unknown; cmd?: unknown};
  const text = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : null;
  return text && text.length <= 20_000 ? text : null;
}

/** Classifies one tool event, with the key that pairs it to its result. Null for anything that is not an app call. */
export function inspectToolEvent(event: ToolEvent, fallbackAt: number = Date.now()): Inspected | null {
  const phase = PHASES[event.type];
  const channelId = event.channelId;
  if (!phase || !channelId) return null;
  const raw = commandOf(event.payload);
  if (raw === null) return null;
  // Invocations are counted on the command as sent (quotes aside), before whitespace or newlines are collapsed.
  const unquoted = raw.replace(/["']/g, '');
  const command = unquoted.replace(/\s+/g, ' ').trim();
  const found: {index: number; app: string; appName: string; action: string; kind: 'read' | 'change'; label: string | null}[] = [];
  for (const match of unquoted.matchAll(CONNECTION)) {
    const slug = match[2], app = slug.split('_')[0].toLowerCase();
    found.push({index: match.index!, app, appName: connectionAppName(app), action: actionName({slug}, app), kind: composioKind(slug), label: null});
  }
  for (const match of unquoted.matchAll(GH)) {
    const gh = parseGh(match[1]);
    if (gh.known) found.push({index: match.index!, app: 'github', appName: connectionAppName('github'), action: gh.action, kind: gh.kind, label: gh.repo});
  }
  if (!found.length) return null;
  found.sort((a, b) => a.index - b.index);
  const first = found[0];
  // A read only if this is the one app invocation in the command, with no substitution that could hide another.
  const invocations = (unquoted.match(CONNECTION_TOKEN)?.length ?? 0) + (unquoted.match(GH_TOKEN)?.length ?? 0);
  const single = invocations === 1 && !SUBSTITUTION.test(unquoted) && !INDIRECT.some(pattern => pattern.test(raw) || pattern.test(unquoted));
  return {
    id: event.id, channelId, agent: event.source.replace(/^agent:/, ''), at: event.createdAt ?? fallbackAt,
    app: first.app, appName: first.appName, action: first.action,
    // One event can chain several calls; a change anywhere makes it a change.
    kind: single && found.every(call => call.kind === 'read') ? 'read' : 'change',
    label: found.find(call => call.label)?.label ?? null,
    phase, key: fingerprint(command),
  };
}

export function classifyToolEvent(event: ToolEvent, fallbackAt?: number): Classified | null {
  const inspected = inspectToolEvent(event, fallbackAt);
  if (!inspected) return null;
  const {key: _key, ...classified} = inspected;
  return classified;
}

/**
 * Pairs each tool.started with the next tool.executed or tool.failed from the same agent, chat and command
 * (first in, first out). An unpaired start is running for 10 minutes, then counted as failed.
 * `now` must be on the events' clock (the server's), not the browser's.
 */
export function foldInspected(items: Inspected[], now: number = Date.now()): AppCall[] {
  const order = {started: 0, executed: 1, failed: 1};
  const sorted = items.map((item, i) => ({item, i})).sort((a, b) => a.item.at - b.item.at || order[a.item.phase] - order[b.item.phase] || a.i - b.i);
  const calls: AppCall[] = [];
  const pending = new Map<string, AppCall[]>();
  for (const {item: {phase, key, ...rest}} of sorted) {
    const slot = `${rest.channelId}\0${rest.agent}\0${key}`;
    if (phase === 'started') {
      const call: AppCall = {...rest, state: 'running'};
      calls.push(call);
      const queue = pending.get(slot);
      if (queue) queue.push(call); else pending.set(slot, [call]);
      continue;
    }
    const state = phase === 'executed' ? 'done' : 'failed';
    const open = pending.get(slot)?.shift();
    if (open) open.state = state; else calls.push({...rest, state});
  }
  for (const call of calls) if (call.state === 'running' && now - call.at > RUNNING_MAX_MS) call.state = 'failed';
  return calls;
}

export function foldCalls(events: ToolEvent[], now: number = Date.now()): AppCall[] {
  return foldInspected(events.flatMap(event => inspectToolEvent(event, now) ?? []), now);
}

export function summarise(calls: AppCall[]): AppSummary {
  const apps = new Map<string, AppSummary['apps'][number]>();
  let reads = 0, changes = 0;
  for (const call of calls) {
    let row = apps.get(call.app);
    if (!row) apps.set(call.app, row = {app: call.app, appName: call.appName, reads: 0, changes: 0, running: false});
    if (call.kind === 'read') { row.reads++; reads++; } else { row.changes++; changes++; }
    if (call.state === 'running') row.running = true;
  }
  return {apps: [...apps.values()], reads, changes};
}
