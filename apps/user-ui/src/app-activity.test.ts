import {describe,expect,it} from 'vitest';
import {classifyToolEvent,foldCalls,kindFor,summarise,type AppCall} from './app-activity';

const conn = (slug: string) => `node scripts/connections.mjs execute c1 ${slug} < args.json`;
let n = 0;
const ev = (command: string, type = 'tool.started', extra: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  id: `e${++n}`, type, source: 'agent:Pip', channelId: 'ch1', createdAt: 1_000, payload: {tool: 'shell_run', args: {command}, ...extra}, ...over,
});
const kind = (command: string) => classifyToolEvent(ev(command))?.kind;

describe('classifyToolEvent: connected apps', () => {
  it('reads and changes by exact verb', () => {
    expect(kind(conn('GMAIL_FETCH_EMAILS'))).toBe('read');
    expect(kind(conn('GMAIL_SEND_EMAIL'))).toBe('change');
  });
  it('names the app and the action only', () => {
    const call = classifyToolEvent(ev(conn('GMAIL_SEND_EMAIL')))!;
    expect(call).toMatchObject({app: 'gmail', appName: 'Gmail', action: 'Send email', label: null, phase: 'started', agent: 'Pip', channelId: 'ch1', at: 1_000, id: expect.any(String)});
  });
  it('treats a misleading or unknown name as a change', () => {
    expect(kind(conn('GMAIL_LIST_AND_DELETE'))).toBe('change');
    expect(kind(conn('NOTION_UPDATE_PAGE'))).toBe('change');
    expect(kind(conn('TRELLO_FROBNICATE_BOARD'))).toBe('change');
    expect(kind(conn('GMAIL_FETCHES'))).toBe('change');
    expect(kind(conn('SLACK'))).toBe('change');
  });
  it('accepts every read verb', () => {
    for (const verb of ['GET', 'LIST', 'FETCH', 'SEARCH', 'FIND', 'READ', 'QUERY', 'DOWNLOAD', 'EXPORT', 'VIEW']) expect(kindFor('x', `X_${verb}_THING`)).toBe('read');
  });
  it('turns a read into a change on any later change word', () => {
    for (const word of ['CREATE', 'ADD', 'SEND', 'POST', 'UPDATE', 'PATCH', 'DELETE', 'REMOVE', 'MOVE', 'ARCHIVE', 'REPLY', 'FORWARD', 'UPLOAD', 'SET', 'MERGE', 'CLOSE']) expect(kindFor('x', `X_GET_AND_${word}`)).toBe('change');
  });
  it('still parses with quotes, extra spaces and args.cmd', () => {
    expect(classifyToolEvent(ev('  node   scripts/connections.mjs   execute   "c1"   GMAIL_FETCH_EMAILS   < a.json'))?.app).toBe('gmail');
    expect(classifyToolEvent({...ev(''), payload: {tool: 'shell_run', args: {cmd: conn('SLACK_LIST_CHANNELS')}}})).toMatchObject({app: 'slack', kind: 'read'});
    expect(classifyToolEvent(ev(`cd /w && node scripts/connections.mjs execute 'c1' "GMAIL_SEND_EMAIL" < a.json`))?.kind).toBe('change');
  });
  it('does not match other connections subcommands', () => {
    expect(classifyToolEvent(ev('node scripts/connections.mjs list'))).toBeNull();
  });
});

describe('classifyToolEvent: gh', () => {
  it('reads view/list/status/diff/checks/search and labels the repo', () => {
    expect(classifyToolEvent(ev('gh pr view 5 -R acme/web'))).toMatchObject({app: 'github', appName: 'GitHub', kind: 'read', label: 'acme/web'});
    expect(classifyToolEvent(ev('gh issue list --repo acme/web'))).toMatchObject({kind: 'read', label: 'acme/web'});
    expect(classifyToolEvent(ev('gh pr list --repo=acme/web'))).toMatchObject({kind: 'read', label: 'acme/web'});
    expect(kind('gh pr checks 5')).toBe('read');
    expect(kind('gh pr diff 5')).toBe('read');
    expect(kind('gh search issues foo')).toBe('read');
    expect(kind('gh pr status')).toBe('read');
    expect(classifyToolEvent(ev('gh pr view 5'))?.label).toBeNull();
  });
  it('treats everything else as a change', () => {
    expect(kind('gh pr merge 5')).toBe('change');
    expect(kind('gh pr create --title x')).toBe('change');
    expect(kind('gh pr frobnicate')).toBe('change');
    expect(kind('gh pr')).toBe('change');
    expect(kind('GH_TOKEN=x gh pr merge 5')).toBe('change');
    expect(kind('bash -c "cd w && gh pr merge 5"')).toBe('change');
  });
  it('is not fooled by words that merely contain gh', () => {
    expect(classifyToolEvent(ev('gh'))).toBeNull();
    expect(classifyToolEvent(ev('gh frobnicate'))).toBeNull();
    expect(classifyToolEvent(ev('ls ghost pr'))).toBeNull();
  });
  it('gh api: reads only with no method or GET', () => {
    expect(kind('gh api repos/x/y/issues')).toBe('read');
    expect(kind('gh api -X GET repos/x/y/issues')).toBe('read');
    expect(kind('gh api --method GET repos/x/y')).toBe('read');
    expect(kind('gh api -X POST repos/x/y/issues')).toBe('change');
    expect(kind('gh api --method=POST repos/x/y/issues')).toBe('change');
    expect(kind('gh api --method POST repos/x/y/issues')).toBe('change');
    expect(kind('gh api -XPOST repos/x/y/issues')).toBe('change');
    expect(kind('gh api repos/x/y/issues -f title=hi')).toBe('change');
    expect(kind('gh api repos/x/y/issues --input body.json')).toBe('change');
  });
  it('a chained change is not hidden behind a read', () => {
    expect(kind('gh pr view 5 && gh pr merge 5')).toBe('change');
  });
});

describe('classifyToolEvent: chains are changes (R14)', () => {
  const merge = 'gh pr merge 1';
  it('a second invocation or any substitution makes it a change', () => {
    for (const command of [
      'gh pr view 1\ngh pr merge 1',
      'gh pr view 1\r\ngh pr merge 1',
      'gh pr view 1 `gh pr merge 1`',
      'gh pr view 1 $(gh pr merge 1)',
      'gh pr view 1 <(gh pr merge 1)',
      'gh issue list --repo a/b\ngh issue close 3',
      `${conn('GMAIL_FETCH_EMAILS')}\n${merge}`,
      `${merge}\n${conn('GMAIL_FETCH_EMAILS')}`,
      `${conn('GMAIL_FETCH_EMAILS')} && ${conn('GMAIL_FETCH_EMAILS')}`,
      'gh pr view 1 $(echo hi)',
      'gh pr view 1 && /usr/bin/gh pr merge 1',
      'gh pr view 1; /usr/local/bin/gh pr merge 1',
      'gh pr view 1 | sh',
      'gh pr view 1 --jq .x | bash',
      'gh pr view 1 | /bin/zsh',
      'gh pr view 1 | xargs -n1 echo',
      'gh pr view 1 | eval',
      'gh pr view 1; $X pr merge 1',
      'gh pr view 1 ${X}',
    ]) expect(kind(command), command).toBe('change');
  });
  it('a lone read stays a read', () => {
    expect(kind('gh pr view 1')).toBe('read');
    expect(kind('gh pr list --json x | jq .')).toBe('read');
    expect(kind('gh pr view 1 | grep -i shell')).toBe('read');
    expect(kind('/usr/bin/gh pr merge 1')).toBe('change');
    expect(kind('/usr/bin/gh pr view 1')).toBe('read');
    expect(kind(`cd w && ${conn('GMAIL_FETCH_EMAILS')}`)).toBe('read');
  });
});

describe('classifyToolEvent: gh api', () => {
  it('stores only api, never a path, flag or value', () => {
    const call = classifyToolEvent(ev('gh api repos/x/y/issues --jq .token -R acme/web'))!;
    expect(call.action).toBe('api');
    expect(JSON.stringify(call)).not.toMatch(/repos\/|\.token/);
    expect(call.label).toBe('acme/web');
    expect(classifyToolEvent(ev('gh api repos/x/y/issues --jq .token'))!.label).toBeNull();
  });
  it('graphql is a change unless GET', () => {
    expect(classifyToolEvent(ev('gh api graphql'))).toMatchObject({kind: 'change', action: 'api graphql'});
    expect(kind('gh api graphql -X GET')).toBe('read');
  });
  it('keeps no odd label', () => {
    expect(classifyToolEvent(ev('gh pr view 1 -R $TOKEN'))!.label).toBeNull();
  });
});

describe('classifyToolEvent: everything else', () => {
  it('ignores non-app commands and other tools', () => {
    expect(classifyToolEvent(ev('ls -la'))).toBeNull();
    expect(classifyToolEvent(ev('echo ghost'))).toBeNull();
    expect(classifyToolEvent({...ev(conn('GMAIL_SEND_EMAIL')), payload: {tool: 'fs_read', args: {command: conn('GMAIL_SEND_EMAIL')}}})).toBeNull();
    expect(classifyToolEvent(ev(conn('GMAIL_SEND_EMAIL'), 'message.created'))).toBeNull();
    expect(classifyToolEvent({...ev(''), payload: undefined})).toBeNull();
    expect(classifyToolEvent({...ev(''), payload: {tool: 'shell_run'}})).toBeNull();
  });
  it('maps the three tool phases', () => {
    expect(classifyToolEvent(ev(conn('GMAIL_FETCH_EMAILS'), 'tool.executed'))?.phase).toBe('executed');
    expect(classifyToolEvent(ev(conn('GMAIL_FETCH_EMAILS'), 'tool.failed'))?.phase).toBe('failed');
  });
  it('never reads or keeps the output', () => {
    const secret = 'Dear Alice, the wire password is hunter2';
    const call = classifyToolEvent(ev(conn('GMAIL_FETCH_EMAILS'), 'tool.executed', {output: secret}));
    expect(JSON.stringify(call)).not.toContain('hunter2');
    expect(JSON.stringify(call)).not.toContain('args.json');
    // Even an output that looks like an app call is not read.
    const sneaky = classifyToolEvent({...ev('ls'), payload: {tool: 'shell_run', args: {command: 'ls'}, output: conn('GMAIL_SEND_EMAIL')}});
    expect(sneaky).toBeNull();
    // Reading `output` at all would throw here.
    const trap = {tool: 'shell_run', args: {command: conn('GMAIL_FETCH_EMAILS')}, get output(): never { throw new Error('read output'); }};
    expect(() => classifyToolEvent({...ev(''), payload: trap})).not.toThrow();
  });
});

describe('foldCalls', () => {
  const MIN = 60_000;
  const send = conn('GMAIL_SEND_EMAIL');
  it('pairs started with the next executed from the same agent, chat and command', () => {
    const calls = foldCalls([ev(send, 'tool.started', {}, {createdAt: 1}), ev(send, 'tool.executed', {output: 'x'}, {createdAt: 2})], 3);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({state: 'done', app: 'gmail'});
  });
  it('marks a failed call', () => {
    expect(foldCalls([ev(send, 'tool.started', {}, {createdAt: 1}), ev(send, 'tool.failed', {}, {createdAt: 2})], 3)[0].state).toBe('failed');
  });
  it('an unpaired started: running under 10 minutes, failed after', () => {
    const now = 20 * MIN;
    expect(foldCalls([ev(send, 'tool.started', {}, {createdAt: now - 2 * MIN})], now)[0].state).toBe('running');
    expect(foldCalls([ev(send, 'tool.started', {}, {createdAt: now - 11 * MIN})], now)[0].state).toBe('failed');
  });
  it('pairs interleaved calls by command, agent and chat', () => {
    const fetch = conn('GMAIL_FETCH_EMAILS');
    const calls = foldCalls([
      ev(send, 'tool.started', {}, {createdAt: 1}),
      ev(fetch, 'tool.started', {}, {createdAt: 2}),
      ev(fetch, 'tool.executed', {}, {createdAt: 3}),
      ev(send, 'tool.started', {}, {createdAt: 4, source: 'agent:Pom'}),
      ev(send, 'tool.started', {}, {createdAt: 5, channelId: 'ch2'}),
      ev(send, 'tool.executed', {}, {createdAt: 6, source: 'agent:Pom'}),
    ], 7);
    const by = (agent: string, channelId: string, action: string) => calls.filter(c => c.agent === agent && c.channelId === channelId && c.action === action).map(c => c.state);
    expect(by('Pip', 'ch1', 'Send email')).toEqual(['running']);
    expect(by('Pip', 'ch1', 'Fetch emails')).toEqual(['done']);
    expect(by('Pom', 'ch1', 'Send email')).toEqual(['done']);
    expect(by('Pip', 'ch2', 'Send email')).toEqual(['running']);
  });
  it('pairs repeated identical commands first-in first-out', () => {
    const calls = foldCalls([
      ev(send, 'tool.started', {}, {createdAt: 1}), ev(send, 'tool.started', {}, {createdAt: 2}),
      ev(send, 'tool.executed', {}, {createdAt: 3}),
    ], 4);
    expect(calls.map(c => c.state).sort()).toEqual(['done', 'running']);
  });
  it('keeps an executed whose started was not seen, and ignores non-app events', () => {
    const calls = foldCalls([ev(send, 'tool.executed', {}, {createdAt: 1}), ev('ls', 'tool.started', {}, {createdAt: 2})], 3);
    expect(calls).toHaveLength(1);
    expect(calls[0].state).toBe('done');
  });
  it('is independent of input order', () => {
    const list = [ev(send, 'tool.executed', {}, {createdAt: 2}), ev(send, 'tool.started', {}, {createdAt: 1})];
    expect(foldCalls(list, 3)[0].state).toBe('done');
  });
  it('keeps no command text or output', () => {
    const calls = foldCalls([ev(send, 'tool.started', {}, {createdAt: 1}), ev(send, 'tool.executed', {output: 'SECRET-BODY'}, {createdAt: 2})], 3);
    expect(JSON.stringify(calls)).not.toMatch(/SECRET-BODY|args\.json|connections\.mjs/);
  });
});

describe('foldCalls clocks', () => {
  const send = conn('GMAIL_SEND_EMAIL');
  it('a missing createdAt counts as the reference time, not epoch', () => {
    const e = {...ev(send, 'tool.started'), createdAt: undefined};
    expect(foldCalls([e], 5_000_000)[0]).toMatchObject({state: 'running', at: 5_000_000});
  });
});

describe('summarise', () => {
  const call = (app: string, appName: string, kind: 'read' | 'change', state: AppCall['state'] = 'done'): AppCall =>
    ({id: String(n++), channelId: 'c', agent: 'a', at: 1, app, appName, action: 'x', kind, label: null, state});
  it('counts per app, in first-seen order, and flags running', () => {
    const result = summarise([call('gmail', 'Gmail', 'read'), call('github', 'GitHub', 'change'), call('gmail', 'Gmail', 'change', 'running')]);
    expect(result).toEqual({
      apps: [{app: 'gmail', appName: 'Gmail', reads: 1, changes: 1, running: true}, {app: 'github', appName: 'GitHub', reads: 0, changes: 1, running: false}],
      reads: 1, changes: 2,
    });
  });
  it('is empty for no calls', () => {
    expect(summarise([])).toEqual({apps: [], reads: 0, changes: 0});
  });
});
