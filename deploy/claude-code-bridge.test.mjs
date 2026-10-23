import {it, expect, vi, describe, afterEach} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, realpathSync, statSync, symlinkSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PERMISSION_PROFILES, createClaudeOutput, claudeArgs, claudeEnvironment, forwardedSecrets, isProtectedName, readBridgeConfig, runBridge} from './claude-code-bridge.mjs';
import {once} from 'node:events';
import {existsSync, chmodSync, mkdirSync} from 'node:fs';

const line = event => JSON.stringify(event)+'\n';
const assistant = (id, ...content) => ({type:'assistant', session_id:'s1', message:{id, content}});
const text = value => ({type:'text', text:value});
const toolUse = {type:'tool_use', id:'tool', name:'Bash', input:{command:'private tool input'}};
const toolResult = {type:'user', session_id:'s1', message:{content:[{type:'tool_result', tool_use_id:'tool', content:'private tool output'}]}};
const result = (overrides={}) => ({type:'result', subtype:'success', is_error:false, num_turns:2, result:'Tests pass.', session_id:'s1', ...overrides});

describe('stream-json output', () => {
  it('publishes interim assistant text before tools run and returns the final reply once', async () => {
    const updates = [];
    const output = createClaudeOutput({publishProgress: async item => { updates.push(item); }});
    const input = line({type:'system', subtype:'init', session_id:'s1'}) + line(assistant('m1', {type:'thinking', thinking:'private reasoning'})) + line(assistant('m1', text('Running the tests.')));
    output.write(input.slice(0, 31)); output.write(input.slice(31));
    output.write(line(assistant('m1', toolUse)));
    await vi.waitFor(() => expect(updates).toEqual([{id:'m1:0', text:'Running the tests.'}]));
    output.write(line(toolResult) + line(assistant('m2', text('Tests pass.'))));
    output.write(JSON.stringify(result()));
    expect(await output.finish()).toMatchObject({sessionId:'s1', finalText:'Tests pass.', failure:false, started:true});
    expect(updates).toHaveLength(1);
  });

  it('never forwards thinking, tool input or output, hook output or malformed lines', async () => {
    const updates = [];
    const output = createClaudeOutput({publishProgress: async item => { updates.push(item); }});
    output.write('not json\nnull\n');
    output.write(line({type:'system', subtype:'hook_response', session_id:'s1', stdout:'private hook output'}));
    output.write(line(assistant('m1', {type:'thinking', thinking:'private reasoning'}, toolUse)) + line(toolResult));
    output.write(line(assistant('m2', text('Done.'))) + line(result({result:'Done.'})));
    expect((await output.finish()).finalText).toBe('Done.');
    expect(updates).toEqual([]);
  });

  it('joins text blocks of one message and keeps separate identities for later segments', async () => {
    const updates = [];
    const output = createClaudeOutput({publishProgress: async item => { updates.push(item); }});
    output.write(line(assistant('m1', text('First part.'))) + line(assistant('m1', text('Second part.'))) + line(assistant('m1', toolUse)));
    output.write(line(toolResult) + line(assistant('m1', text('Same message, later text.'))) + line(assistant('m1', toolUse)));
    output.write(line(result()));
    await output.finish();
    expect(updates).toEqual([{id:'m1:0', text:'First part.\n\nSecond part.'}, {id:'m1:1', text:'Same message, later text.'}]);
  });

  it('keeps subagent narration and reports out of progress', async () => {
    const updates = [];
    const output = createClaudeOutput({publishProgress: async item => { updates.push(item); }});
    const sub = event => ({...event, parent_tool_use_id:'task'});
    output.write(line(assistant('m1', text('Delegating the review.'))) + line(assistant('m1', {type:'tool_use', id:'task', name:'Task', input:{prompt:'private brief'}})));
    output.write(line(sub(assistant('s1', text('Subagent narration.')))) + line(sub(assistant('s1', toolUse))) + line(sub(toolResult)));
    output.write(line(sub(assistant('s2', text('Subagent final report.')))));
    output.write(line({type:'user', session_id:'s1', message:{content:[{type:'tool_result', tool_use_id:'task', content:'Subagent final report.'}]}}));
    output.write(line(assistant('m2', text('Review done.'))) + line(result({result:'Review done.'})));
    expect((await output.finish()).finalText).toBe('Review done.');
    expect(updates).toEqual([{id:'m1:0', text:'Delegating the review.'}]);
  });

  it('does not let progress transport failure lose the final reply or expose the error', async () => {
    const error = vi.fn(), publish = vi.fn(async () => { throw Error('private credential/response'); });
    const output = createClaudeOutput({publishProgress:publish, onProgressError:error});
    for (const id of ['a', 'b']) output.write(line(assistant(id, text(`Step ${id}.`))) + line(assistant(id, toolUse)));
    output.write(line(result({result:'Finished.'})));
    expect(await output.finish()).toMatchObject({failure:false, finalText:'Finished.'});
    expect(publish).toHaveBeenCalledTimes(1); expect(error).toHaveBeenCalledExactlyOnceWith();
  });

  it('keeps failed-turn semantics instead of turning partial text into a reply', async () => {
    const updates = [];
    const output = createClaudeOutput({publishProgress: async item => { updates.push(item); }});
    output.write(line(assistant('m1', text('Working.'))) + line(result({subtype:'error_during_execution', is_error:true, result:undefined, api_error_status:429})));
    expect(await output.finish()).toMatchObject({failure:true, finalText:'', errorStatus:429});
    expect(updates).toEqual([]);
    const missing = createClaudeOutput({publishProgress: async () => {}});
    expect(await missing.finish()).toMatchObject({failure:true, started:false});
  });
});

describe('turn configuration', () => {
  const base = {ORGOPS_WRAPPED_SESSION_ID:'key', ORGOPS_WRAPPED_MESSAGE:'hello', ORGOPS_WRAPPED_WORKSPACE_PATH:'/w/Claude'};
  // Never the developer's checkout, which may hold a real product database.
  const nestRoot = '/nonexistent/nest';

  it('maps each permission profile to Claude Code flags and rejects unknown profiles', () => {
    expect(PERMISSION_PROFILES).toEqual(['workspace', 'full']);
    const args = profile => claudeArgs(readBridgeConfig({...base, NEST_CLAUDE_PERMISSIONS:profile}, {nestRoot}));
    expect(args('workspace')).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits', '--tools', 'Bash,Read,Edit,Write,Glob,Grep,NotebookEdit,Skill,Agent', '--settings', '--strict-mcp-config']));
    expect(args('full')).not.toContain('--tools');
    expect(args('full')).not.toContain('--settings');
    expect(args('full')).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
    expect(args('full')).not.toContain('--strict-mcp-config');
    expect(claudeArgs(readBridgeConfig(base, {nestRoot}))).toEqual(expect.arrayContaining(['acceptEdits']));
    for (const profile of ['anything', 'read-only']) {
      expect(() => readBridgeConfig({...base, NEST_CLAUDE_PERMISSIONS:profile})).toThrow('NEST_CLAUDE_PERMISSIONS must be one of workspace, full');
    }
  });

  it('sandboxes workspace shells: fail closed, Nest data and credentials unreadable, network opt-in', () => {
    const config = readBridgeConfig({...base, HOME:'/home/node', NEST_CLAUDE_ALLOWED_DOMAINS:'registry.npmjs.org, github.com'}, {nestRoot:'/app'});
    const args = claudeArgs(config);
    const {sandbox} = JSON.parse(args[args.indexOf('--settings') + 1]);
    expect(sandbox).toMatchObject({enabled:true, failIfUnavailable:true, autoAllowBashIfSandboxed:true, allowUnsandboxedCommands:false,
      network:{allowedDomains:['registry.npmjs.org', 'github.com']}});
    expect(sandbox.filesystem.allowRead.slice(0, 5)).toEqual(['/w/Claude', '/home/node/.gitconfig', '/home/node/.claude/skills', '/home/node/.claude/plugins/cache', '/home/node/.claude/plugins/marketplaces']);
    expect(sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(['/app', '/home/node']));
    const external = readBridgeConfig({...base, ORGOPS_PROJECT_ROOT:'/var/lib/nest/engine', NEST_PRODUCT_DB_PATH:'/srv/product/nest.sqlite'}, {nestRoot:'/app'});
    expect(external.denyRead).toEqual(expect.arrayContaining(['/var/lib/nest', '/var/lib/nest/engine/claude-code/sessions', '/srv/product']));
    expect(JSON.parse(claudeArgs(readBridgeConfig(base))[claudeArgs(readBridgeConfig(base)).indexOf('--settings') + 1]).sandbox.network.allowedDomains).toEqual([]);
  });

  it('denies HOME except git config, skills and listed toolchains, with an operator allowance', () => {
    const config = readBridgeConfig({...base, HOME:'/home/node', NEST_CLAUDE_ALLOW_READ:'/opt/extra, /home/node/.tool'});
    expect(config.denyRead).toContain('/home/node');
    expect(config.allowRead).toEqual(expect.arrayContaining(['/w/Claude', '/home/node/.gitconfig', '/home/node/.local/share/fnm', '/home/node/.nvm', '/opt/extra', '/home/node/.tool']));
    for (const secret of ['/home/node/.ssh', '/home/node/.codex', '/home/node/.config', '/home/node/.local/share', '/home/node/.zsh_history', '/home/node/.claude/plugins', '/home/node/.claude/plugins/data']) expect(config.allowRead).not.toContain(secret);
  });

  it('refuses workspaces overlapping protected paths in both directions', () => {
    const at = (workspace, extra = {}) => () => readBridgeConfig({...base, HOME:'/home/node', ORGOPS_WRAPPED_WORKSPACE_PATH:workspace, ...extra}, {nestRoot:'/home/node/nest'});
    const engine = {ORGOPS_PROJECT_ROOT:'/home/node/nest/.nest-data/engine'};
    // A workspace containing protected folders would let sandboxed reads reach them.
    for (const workspace of ['/home/node', '/', '/home', '/home/node/nest', '/home/node/nest/.nest-data/engine']) expect(at(workspace, engine)).toThrow(/workspace that does not contain/);
    expect(at('/home/node', {NEST_CLAUDE_PERMISSIONS:'full'})).not.toThrow();
    // A workspace inside them hands them to Claude Code in every profile.
    for (const permissions of ['workspace', 'full']) {
      for (const [workspace, extra] of [
        ['/home/node/nest/.nest-data/engine/claude-code/sessions/Claude', engine],
        ['/state/Claude', {NEST_CLAUDE_STATE_DIR:'/state'}],
        ['/home/node/nest/.nest-data/engine/Claude', engine],
        ['/home/node/nest/.nest-product/Claude', {}],
        ['/srv/product/Claude', {NEST_PRODUCT_DB_PATH:'/srv/product/nest.sqlite'}],
      ]) expect(at(workspace, {...extra, NEST_CLAUDE_PERMISSIONS:permissions})).toThrow(/workspace outside/);
      expect(at('/home/node/nest/.nest-data/workspaces/Claude', {...engine, NEST_CLAUDE_PERMISSIONS:permissions})).not.toThrow();
    }
  });

  it('compares real paths, as the runner reaches workspaces through the engine root link', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nest-claude-paths-')));
    try {
      // scripts/orgops-env.ts links <data>/engine/.nest-data to <data>; the runner resolves workspaces under it.
      mkdirSync(join(dir, 'data', 'engine'), {recursive:true});
      symlinkSync(join(dir, 'data'), join(dir, 'data', 'engine', '.nest-data'));
      mkdirSync(join(dir, 'data', 'workspaces', 'Claude'), {recursive:true});
      const at = workspace => () => readBridgeConfig({...base, ORGOPS_PROJECT_ROOT:join(dir, 'data', 'engine'), ORGOPS_WRAPPED_WORKSPACE_PATH:workspace, NEST_CLAUDE_PERMISSIONS:'full'}, {nestRoot:dir});
      expect(at(join(dir, 'data', 'engine', '.nest-data', 'workspaces', 'Claude'))).not.toThrow();
      expect(at(join(dir, 'data', 'engine', '.nest-data', 'engine', 'Claude'))).toThrow(/workspace outside/);
    } finally { rmSync(dir, {recursive:true, force:true}); }
  });

  it('refuses the full profile when Nest\'s product database is visible', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nest-claude-product-')));
    try {
      mkdirSync(join(dir, '.nest-product')); writeFileSync(join(dir, '.nest-product', 'nest.sqlite'), '');
      writeFileSync(join(dir, 'elsewhere.sqlite'), '');
      const config = (extra, root = dir) => () => readBridgeConfig({...base, ...extra}, {nestRoot:root});
      expect(config({NEST_CLAUDE_PERMISSIONS:'full'})).toThrow("NEST_CLAUDE_PERMISSIONS=full refuses to run next to Nest's data (product database found). Assign this agent to the agents runner.");
      expect(config({NEST_CLAUDE_PERMISSIONS:'full', NEST_PRODUCT_DB_PATH:join(dir, 'elsewhere.sqlite')}, '/nonexistent/nest')).toThrow(/Nest's data/);
      expect(config({NEST_CLAUDE_PERMISSIONS:'workspace'})).not.toThrow();
      expect(config({NEST_CLAUDE_PERMISSIONS:'full'}, '/nonexistent/nest')).not.toThrow();
    } finally { rmSync(dir, {recursive:true, force:true}); }
  });

  it('adds optional model, setting sources and resume flags', () => {
    const config = readBridgeConfig({...base, NEST_CLAUDE_MODEL:'sonnet', NEST_CLAUDE_SETTING_SOURCES:'project,local'});
    const args = claudeArgs(config, 'saved-session');
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'sonnet']);
    expect(args).toEqual(expect.arrayContaining(['--setting-sources', 'project,local', '--resume', 'saved-session']));
    expect(claudeArgs(readBridgeConfig(base))).not.toContain('--resume');
  });

  it('accepts legacy NEST_WRAPPED_* variables and keeps session state outside the workspace', () => {
    const config = readBridgeConfig({NEST_WRAPPED_SESSION_ID:'key', NEST_WRAPPED_MESSAGE:'hi', NEST_WRAPPED_WORKSPACE_PATH:'/w/Claude', ORGOPS_PROJECT_ROOT:'/data/engine'});
    expect(config).toMatchObject({sessionKey:'key', message:'hi', workspace:'/w/Claude', stateDir:'/data/engine/claude-code/sessions'});
  });

  it('forwards only host, proxy and Claude authentication variables', () => {
    const host = {
      PATH:'/bin', HOME:'/home/node', ANTHROPIC_BASE_URL:'https://gateway.example', NEST_ADMIN_PASS:'admin', NEST_MASTER_KEY:'key',
      NEST_RUNNER_TOKEN:'runner', ORGOPS_RUNNER_TOKEN:'runner', OPENAI_API_KEY:'sk-openai', ORGOPS_WRAPPED_MESSAGE:'hello',
    };
    // Without a credential secret Claude Code uses the host's own login and API URL.
    expect(claudeEnvironment(host)).toEqual({PATH:'/bin', HOME:'/home/node', ANTHROPIC_BASE_URL:'https://gateway.example', DISABLE_AUTOUPDATER:'1'});
    // With one, the credential never passes through and the proxy sets the URL.
    for (const credential of [{ANTHROPIC_API_KEY:'sk-ant'}, {CLAUDE_CODE_OAUTH_TOKEN:'oauth'}]) {
      expect(claudeEnvironment({...host, ...credential})).toEqual({PATH:'/bin', HOME:'/home/node', DISABLE_AUTOUPDATER:'1'});
    }
  });

  it('forwards listed tool secrets and refuses protected names', () => {
    const env = {PATH:'/bin', GH_TOKEN:'gh-secret', AWS_SECRET_ACCESS_KEY:'aws-unlisted', NEST_RUNNER_TOKEN:'runner', ORGOPS_X:'x',
      ANTHROPIC_API_KEY:'sk-ant', CLAUDE_CODE_OAUTH_TOKEN:'oauth'};
    const config = readBridgeConfig({...base, ...env, NEST_CLAUDE_SECRETS:'GH_TOKEN,NEST_RUNNER_TOKEN,ORGOPS_X,ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,PATH'}, {nestRoot});
    expect(forwardedSecrets(env, config.secrets)).toEqual({GH_TOKEN:'gh-secret'});
    expect(claudeEnvironment(env, config)).toEqual({PATH:'/bin', GH_TOKEN:'gh-secret', DISABLE_AUTOUPDATER:'1'});
    for (const name of ['NEST_RUNNER_TOKEN', 'ORGOPS_API_URL', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'PATH', 'HOME', 'DISABLE_AUTOUPDATER', 'nest_admin_pass']) expect(isProtectedName(name)).toBe(true);
    for (const name of ['GH_TOKEN', 'SSH_PRIVATE_KEY', 'AWS_SECRET_ACCESS_KEY']) expect(isProtectedName(name)).toBe(false);
  });
});

describe('bridge turns against a scripted Claude Code process', () => {
  const dirs = [];
  afterEach(() => { for (const dir of dirs.splice(0)) typeof dir === 'string' ? rmSync(dir, {recursive:true, force:true}) : dir.close(); });

  // The fake CLI replays one scripted scenario per call and records what it received.
  const fake = `
    const fs = require('node:fs');
    const {dir} = JSON.parse(process.env.FAKE);
    const calls = JSON.parse(fs.readFileSync(dir + '/calls.json', 'utf8'));
    const scenario = JSON.parse(fs.readFileSync(dir + '/scenarios.json', 'utf8'))[calls.length];
    let input = ''; process.stdin.on('data', c => input += c);
    process.stdin.on('end', async () => {
      const values = {...process.env}; delete values.FAKE;
      const call = {args: process.argv.slice(2), input, cwd: process.cwd(), env: Object.keys(values).sort(), values};
      if (scenario.request) {
        // What Claude Code does with ANTHROPIC_BASE_URL and its credential.
        const headers = values.CLAUDE_CODE_OAUTH_TOKEN ? {authorization: 'Bearer ' + values.CLAUDE_CODE_OAUTH_TOKEN} : {'x-api-key': values.ANTHROPIC_API_KEY};
        const res = await fetch(values.ANTHROPIC_BASE_URL + '/v1/messages?beta=true', {method: 'POST', headers, body: '{}'});
        call.upstreamStatus = res.status; await res.text();
      }
      calls.push(call);
      fs.writeFileSync(dir + '/calls.json', JSON.stringify(calls));
      for (const event of scenario.events) process.stdout.write(JSON.stringify(event) + '\\n');
      if (scenario.stderr) process.stderr.write(scenario.stderr);
      process.exitCode = scenario.code;
    });`;

  function setup(scenarios) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nest-claude-bridge-'))); dirs.push(dir);
    writeFileSync(join(dir, 'fake.cjs'), fake);
    writeFileSync(join(dir, 'calls.json'), '[]');
    writeFileSync(join(dir, 'scenarios.json'), JSON.stringify(scenarios));
    const env = {ORGOPS_WRAPPED_SESSION_ID:'Claude:room', ORGOPS_WRAPPED_MESSAGE:'Run the tests', ORGOPS_WRAPPED_WORKSPACE_PATH:join(dir, 'workspace'),
      NEST_CLAUDE_STATE_DIR:join(dir, 'state'), PATH:process.env.PATH, HOME:dir, NEST_ADMIN_PASS:'admin', ORGOPS_RUNNER_TOKEN:'runner'};
    const spawned = [];
    const spawnImpl = (_bin, args, options) => { spawned.push(options); return spawn(process.execPath, [join(dir, 'fake.cjs'), ...args], {...options, env:{...options.env, FAKE:JSON.stringify({dir})}}); };
    const turn = async (overrides = {}, {nestRoot = '/nonexistent/nest'} = {}) => {
      const out = [], err = [], updates = [];
      const code = await runBridge({env:{...env, ...overrides}, spawnImpl, nestRoot, publishProgress: async item => { updates.push(item); }, stdout: v => out.push(v), stderr: v => err.push(v)});
      return {code, out, err, updates};
    };
    const calls = () => JSON.parse(readFileSync(join(dir, 'calls.json'), 'utf8'));
    const state = () => readdirSync(join(dir, 'state')).map(file => JSON.parse(readFileSync(join(dir, 'state', file), 'utf8')));
    return {turn, calls, state, dir, spawned};
  }

  /** A local stand-in for api.anthropic.com; `status` sets its reply. */
  async function fakeUpstream() {
    const upstream = {seen:[], status:200};
    const server = createServer((req, res) => { req.resume(); upstream.seen.push(req.headers); res.writeHead(upstream.status, {'content-type':'application/json'}); res.end('{}'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    dirs.push({close: () => { server.closeAllConnections(); server.close(); }});
    upstream.url = `http://127.0.0.1:${server.address().port}`;
    return upstream;
  }
  const ok = (session, reply) => ({code:0, events:[{type:'system', subtype:'init', session_id:session}, assistant('m1', text(reply)), result({session_id:session, result:reply})]});

  it('starts a session, then resumes it for the same chat with the message on stdin', async () => {
    const t = setup([ok('first-session', 'Noted.'), ok('first-session', 'BLUE HERON')]);
    expect(await t.turn()).toMatchObject({code:0, out:['Noted.'], err:[]});
    expect(await t.turn({ORGOPS_WRAPPED_MESSAGE:'What was it?'})).toMatchObject({code:0, out:['BLUE HERON']});
    const [first, second] = t.calls();
    expect(first.args).not.toContain('--resume');
    expect(second.args.slice(second.args.indexOf('--resume'))).toEqual(['--resume', 'first-session']);
    expect([first.input, second.input]).toEqual(['Run the tests', 'What was it?']);
    expect(first.cwd).toBe(join(t.dir, 'workspace'));
    expect(first.env).not.toEqual(expect.arrayContaining(['NEST_ADMIN_PASS']));
    expect(first.env).not.toEqual(expect.arrayContaining(['ORGOPS_RUNNER_TOKEN']));
    expect(t.state()).toEqual([{sessionId:'first-session'}]);
  });

  it('starts the proxy for a credential secret and gives Claude Code only the dummy', async () => {
    const upstream = await fakeUpstream();
    const t = setup([{...ok('s', 'Done.'), request:true}, {...ok('s', 'Done.'), request:true}]);
    for (const [name, real, other] of [['CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-fake-real', 'ANTHROPIC_API_KEY'], ['ANTHROPIC_API_KEY', 'sk-ant-api03-fake-real', 'CLAUDE_CODE_OAUTH_TOKEN']]) {
      const finished = await t.turn({[name]:real, NEST_CLAUDE_UPSTREAM_URL:upstream.url});
      expect(finished).toMatchObject({code:0, out:['Done.'], err:[]});
      const call = t.calls().at(-1);
      expect(call.values[name]).toMatch(/^nest-proxy-[0-9a-f-]{36}$/);
      expect(call.values).not.toHaveProperty(other);
      expect(call.values.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(JSON.stringify(call)).not.toContain(real);
      expect(JSON.stringify(finished)).not.toContain(real);
      // The swap happened in the proxy, not in Claude Code's environment.
      expect(call.upstreamStatus).toBe(200);
      expect(upstream.seen.at(-1)).toMatchObject(name === 'ANTHROPIC_API_KEY' ? {'x-api-key':real} : {authorization:`Bearer ${real}`});
      await expect(fetch(`${call.values.ANTHROPIC_BASE_URL}/api/hello`, {method:'HEAD'})).rejects.toThrow();
    }
  });

  it('uses the account\'s own login without a credential secret', async () => {
    const t = setup([ok('s', 'Done.')]);
    expect((await t.turn()).code).toBe(0);
    const [call] = t.calls();
    for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) expect(call.values).not.toHaveProperty(name);
  });

  it('forwards listed tool secrets to the turn and nothing else', async () => {
    const t = setup([ok('s', 'Done.')]);
    await t.turn({NEST_CLAUDE_SECRETS:'GH_TOKEN,NEST_RUNNER_TOKEN', GH_TOKEN:'gh-fake', NEST_RUNNER_TOKEN:'runner', SSH_PRIVATE_KEY:'unlisted'});
    const [call] = t.calls();
    expect(call.values.GH_TOKEN).toBe('gh-fake');
    for (const name of ['NEST_RUNNER_TOKEN', 'SSH_PRIVATE_KEY', 'NEST_CLAUDE_SECRETS']) expect(call.values).not.toHaveProperty(name);
  });

  it('writes secret files under Claude\'s home with mode 600 in 700 folders', async () => {
    const t = setup([ok('s', 'One.'), ok('s', 'Two.'), ok('s', 'Three.')]);
    const home = join(t.dir, 'accounts', 'claude-home');
    const files = {NEST_CLAUDE_HOME:home, NEST_CLAUDE_SECRET_FILES:'SSH_PRIVATE_KEY:.ssh/id_ed25519, SSH_KNOWN_HOSTS:.ssh/known_hosts'};
    const mode = path => statSync(path).mode & 0o777;
    expect((await t.turn({...files, SSH_PRIVATE_KEY:'-----KEY ONE-----', SSH_KNOWN_HOSTS:'host ssh-ed25519 AAA\n'})).code).toBe(0);
    expect(readFileSync(join(home, '.ssh', 'id_ed25519'), 'utf8')).toBe('-----KEY ONE-----\n');
    expect(readFileSync(join(home, '.ssh', 'known_hosts'), 'utf8')).toBe('host ssh-ed25519 AAA\n');
    expect([mode(join(home, '.ssh', 'id_ed25519')), mode(join(home, '.ssh', 'known_hosts'))]).toEqual([0o600, 0o600]);
    expect([mode(home), mode(join(home, '.ssh'))]).toEqual([0o700, 0o700]);
    // Folders above Claude's home stay traversable for its account.
    expect(mode(join(t.dir, 'accounts'))).toBe(0o755);
    // File secrets are files only, never environment variables.
    expect(t.calls()[0].values).not.toHaveProperty('SSH_PRIVATE_KEY');
    await t.turn({...files, SSH_PRIVATE_KEY:'-----KEY TWO-----', SSH_KNOWN_HOSTS:'host ssh-ed25519 AAA\n'});
    expect(readFileSync(join(home, '.ssh', 'id_ed25519'), 'utf8')).toBe('-----KEY TWO-----\n');
    // A secret removed in Admin is removed from disk on the next turn.
    await t.turn({...files, SSH_PRIVATE_KEY:'-----KEY TWO-----'});
    expect(existsSync(join(home, '.ssh', 'known_hosts'))).toBe(false);
    expect(existsSync(join(home, '.ssh', 'id_ed25519'))).toBe(true);
  });

  it('refuses secret file paths outside Claude\'s home and protected names', async () => {
    const t = setup([]);
    const home = join(t.dir, 'claude-home');
    for (const mapping of ['SSH_KEY:../x', 'SSH_KEY:/etc/x', 'SSH_KEY:.ssh/../../x', 'NEST_RUNNER_TOKEN:.x', 'SSH_KEY', 'SSH_KEY:', ':.x']) {
      const failed = await t.turn({NEST_CLAUDE_HOME:home, NEST_CLAUDE_SECRET_FILES:mapping, SSH_KEY:'fake-key', NEST_RUNNER_TOKEN:'runner'});
      expect(failed).toMatchObject({code:1, out:[]});
      expect(failed.err).toEqual([expect.stringMatching(/^NEST_CLAUDE_SECRET_FILES /)]);
      expect(failed.err[0]).not.toMatch(/fake-key|runner\b/);
    }
    // Without its own home, a mapping would write into the runner account's real one.
    expect((await t.turn({NEST_CLAUDE_SECRET_FILES:'SSH_KEY:.ssh/id', SSH_KEY:'fake-key'})).err).toEqual([expect.stringMatching(/^NEST_CLAUDE_SECRET_FILES .*NEST_CLAUDE_HOME/)]);
    expect(t.calls()).toEqual([]);
    expect(existsSync(join(t.dir, 'x'))).toBe(false);
  });

  it('runs Claude Code with the configured account, home and config folder', async () => {
    const t = setup([ok('s', 'Done.')]);
    const home = join(t.dir, 'claude', 'home');
    // The current account, so no chown is needed.
    const finished = await t.turn({NEST_CLAUDE_PERMISSIONS:'full', NEST_CLAUDE_UID:String(process.getuid()), NEST_CLAUDE_GID:String(process.getgid()),
      NEST_CLAUDE_HOME:home, NEST_CLAUDE_CONFIG_DIR:join(home, '.claude')});
    expect(finished).toMatchObject({code:0, out:['Done.']});
    expect(t.spawned[0]).toMatchObject({uid:process.getuid(), gid:process.getgid(), detached:true});
    const [call] = t.calls();
    expect(call.values).toMatchObject({HOME:home, CLAUDE_CONFIG_DIR:join(home, '.claude')});
    expect(call.args).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
    for (const path of [home, join(home, '.claude'), join(t.dir, 'workspace')]) expect(statSync(path).isDirectory()).toBe(true);
  });

  it('refuses the full profile next to Nest\'s data before starting Claude Code', async () => {
    const t = setup([]);
    mkdirSync(join(t.dir, 'nest', '.nest-product'), {recursive:true}); writeFileSync(join(t.dir, 'nest', '.nest-product', 'nest.sqlite'), '');
    const failed = await t.turn({NEST_CLAUDE_PERMISSIONS:'full'}, {nestRoot:join(t.dir, 'nest')});
    expect(failed).toMatchObject({code:1, out:[], err:[expect.stringContaining("Nest's data")]});
    expect(t.calls()).toEqual([]);
  });

  it('starts a new session with a visible notice when saved history is gone', async () => {
    const t = setup([ok('old-session', 'Noted.'),
      {code:1, stderr:'No conversation found with session ID: old-session', events:[result({subtype:'error_during_execution', is_error:true, num_turns:0, result:undefined, session_id:'old-session'})]},
      ok('new-session', 'Fresh start.')]);
    await t.turn();
    const recovered = await t.turn();
    expect(recovered).toMatchObject({code:0, out:['Fresh start.']});
    expect(recovered.updates).toEqual([{id:'session-reset:old-session', text:expect.stringContaining('starts a new session')}]);
    expect(t.calls()[2].args).not.toContain('--resume');
    expect(t.state()).toEqual([{sessionId:'new-session'}]);
  });

  // Captured from Claude Code 2.1.309 without credentials: nothing on stderr, the failure is in the stream.
  const notSignedIn = session => ({code:1, events:[
    {type:'system', subtype:'init', session_id:session},
    {...assistant('m1', text('Not logged in · Please run /login')), error:'authentication_failed'},
    result({subtype:'success', is_error:true, num_turns:1, api_error_status:null, result:'Not logged in · Please run /login', session_id:session}),
  ]});

  it('reports a sign-in problem in one line and never posts the CLI text as the reply', async () => {
    const t = setup([ok('kept-session', 'Noted.'), notSignedIn('new-session')]);
    await t.turn();
    const failed = await t.turn();
    expect(failed).toMatchObject({code:1, out:[], updates:[]});
    expect(failed.err).toEqual(['Claude Code is not signed in. Add CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token) or ANTHROPIC_API_KEY as a private secret of this agent.']);
    expect(t.calls()).toHaveLength(2);
    expect(t.state()).toEqual([{sessionId:'kept-session'}]);
  });

  it('does not save a session for a turn that failed sign-in', async () => {
    // The real credential is rejected upstream; the proxy passes the 401 straight back.
    const upstream = await fakeUpstream(); upstream.status = 401;
    const t = setup([{...notSignedIn('fresh-session'), request:true}]);
    const started = Date.now();
    const failed = await t.turn({CLAUDE_CODE_OAUTH_TOKEN:'sk-ant-oat01-fake-revoked', NEST_CLAUDE_UPSTREAM_URL:upstream.url});
    expect(Date.now() - started).toBeLessThan(5000);
    expect(t.calls()[0].upstreamStatus).toBe(401);
    expect(failed).toMatchObject({code:1, out:[], err:[expect.stringContaining('not signed in')]});
    expect(t.state()).toEqual([]);
  });

  it('explains error_max_budget_usd', async () => {
    const t = setup([{code:1, events:[result({subtype:'error_max_budget_usd', is_error:true, num_turns:4, result:undefined, session_id:'spent'})]}]);
    expect((await t.turn()).err).toEqual(['Claude Code stopped after reaching its spending limit for this turn.']);
  });

  it('keeps the session of a turn that ran but failed, and explains a turn without a written reply', async () => {
    const t = setup([
      {code:1, events:[result({subtype:'error_during_execution', is_error:true, num_turns:3, result:undefined, session_id:'worked-session', errors:['usage limit reached']})]},
      {code:0, events:[result({session_id:'worked-session', result:''})]},
    ]);
    expect((await t.turn()).err).toEqual([expect.stringContaining('usage, rate or billing limit')]);
    expect(t.state()).toEqual([{sessionId:'worked-session'}]);
    expect(await t.turn()).toMatchObject({code:1, out:[], err:[expect.stringContaining('without a written reply')]});
    expect(t.calls()[1].args).toEqual(expect.arrayContaining(['--resume', 'worked-session']));
  });

  it('explains an unavailable sandbox instead of running shell commands unsandboxed', async () => {
    const t = setup([{code:1, stderr:'Error: sandbox required but unavailable: bubblewrap (bwrap) not installed', events:[]}]);
    const failed = await t.turn();
    expect(failed).toMatchObject({code:1, out:[]});
    expect(failed.err).toEqual([expect.stringContaining('sandbox is unavailable')]);
  });

  it('fails clearly when the Claude Code executable is missing', async () => {
    const t = setup([]), err = [];
    const code = await runBridge({env:{ORGOPS_WRAPPED_SESSION_ID:'k', ORGOPS_WRAPPED_MESSAGE:'hi', ORGOPS_WRAPPED_WORKSPACE_PATH:join(t.dir, 'w'),
      NEST_CLAUDE_STATE_DIR:join(t.dir, 'state'), NEST_CLAUDE_BIN:join(t.dir, 'missing-claude'), PATH:process.env.PATH},
      publishProgress:async()=>{}, stdout:()=>{}, stderr:v=>err.push(v)});
    expect(code).toBe(1);
    expect(err).toEqual([expect.stringContaining('Could not start Claude Code')]);
  });
});

describe('stopping a turn', () => {
  it('forwards SIGTERM to Claude Code and its tools, escalates to SIGKILL and exits with a short notice', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nest-claude-stop-')));
    try {
      const fake = join(dir, 'claude');
      // Ignores SIGTERM and leaves a background tool process in its group.
      writeFileSync(fake, `#!${process.execPath}
        const {spawn} = require('node:child_process'), fs = require('node:fs');
        process.on('SIGTERM', () => {});
        const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
        fs.writeFileSync(${JSON.stringify(join(dir, 'pids'))}, JSON.stringify([process.pid, tool.pid]));
        setInterval(() => {}, 1000);`);
      chmodSync(fake, 0o755);
      // A separate process, as under the runner, with a short grace period.
      const bridgeUrl = new URL('./claude-code-bridge.mjs', import.meta.url).href;
      const bridge = spawn(process.execPath, ['--input-type=module', '-e', `const {runBridge} = await import(${JSON.stringify(bridgeUrl)}); process.exitCode = await runBridge({killGraceMs: 200});`], {
        env: {PATH: process.env.PATH, HOME: dir, ORGOPS_WRAPPED_SESSION_ID: 'k', ORGOPS_WRAPPED_MESSAGE: 'hi', ORGOPS_WRAPPED_WORKSPACE_PATH: join(dir, 'w'),
          NEST_CLAUDE_STATE_DIR: join(dir, 'state'), NEST_CLAUDE_BIN: fake},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = ''; bridge.stderr.on('data', chunk => { stderr += chunk; });
      await vi.waitFor(() => expect(existsSync(join(dir, 'pids'))).toBe(true), {timeout: 5000});
      const pids = JSON.parse(readFileSync(join(dir, 'pids'), 'utf8'));
      bridge.kill('SIGTERM');
      const [code] = await once(bridge, 'exit');
      expect(code).toBe(1);
      expect(stderr.trim()).toBe('Claude Code was stopped before it finished.');
      const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
      await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), {timeout: 2000});
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });

  it('reports a stop when Claude Code exits 143 on SIGTERM, as the real CLI does', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nest-claude-stop-')));
    try {
      const fake = join(dir, 'claude');
      writeFileSync(fake, `#!${process.execPath}
        require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'started'))}, '');
        process.on('SIGTERM', () => process.exit(143));
        setInterval(() => {}, 1000);`);
      chmodSync(fake, 0o755);
      const bridge = spawn(process.execPath, [new URL('./claude-code-bridge.mjs', import.meta.url).pathname], {
        env: {PATH: process.env.PATH, HOME: dir, ORGOPS_WRAPPED_SESSION_ID: 'k', ORGOPS_WRAPPED_MESSAGE: 'hi', ORGOPS_WRAPPED_WORKSPACE_PATH: join(dir, 'w'),
          NEST_CLAUDE_STATE_DIR: join(dir, 'state'), NEST_CLAUDE_BIN: fake},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = ''; bridge.stderr.on('data', chunk => { stderr += chunk; });
      await vi.waitFor(() => expect(existsSync(join(dir, 'started'))).toBe(true), {timeout: 5000});
      bridge.kill('SIGTERM');
      expect((await once(bridge, 'exit'))[0]).toBe(1);
      expect(stderr.trim()).toBe('Claude Code was stopped before it finished.');
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });

  it('reports invalid configuration in one line instead of a stack trace', async () => {
    const bridge = spawn(process.execPath, [new URL('./claude-code-bridge.mjs', import.meta.url).pathname], {
      env: {PATH: process.env.PATH, NEST_CLAUDE_PERMISSIONS: 'everything'}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = ''; bridge.stderr.on('data', chunk => { stderr += chunk; });
    expect((await once(bridge, 'exit'))[0]).toBe(1);
    expect(stderr.trim()).toBe('NEST_CLAUDE_PERMISSIONS must be one of workspace, full');
  });
});
