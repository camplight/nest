import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateProductData, compatibleRecipe } from './migrate-product-data';
import { DEFAULT_BRANDING } from '../packages/schemas/src/branding';
import { openProductDb } from '../packages/db/src/index';

it('migrates branding and wrapped recipes with a restorable snapshot and idempotent retries', async () => {
  const dir = mkdtempSync(join(tmpdir(),'nest-migrate-'));
  const engine = join(dir,'engine.sqlite'), product = join(dir,'product.sqlite');
  const db = new Database(engine);
  db.exec("CREATE TABLE instance_settings (key TEXT PRIMARY KEY,value_json TEXT); CREATE TABLE agents(name TEXT,mode TEXT,wrapped_config_json TEXT); CREATE TABLE migrations(id TEXT);");
  db.prepare('INSERT INTO instance_settings VALUES (?,?)').run('branding',JSON.stringify({...DEFAULT_BRANDING,displayName:'Camplight'}));
  db.prepare('INSERT INTO agents VALUES (?,?,?)').run('NestSystem','WRAPPED',JSON.stringify({runtime:{command:'node bridge.mjs'}}));
  db.prepare('INSERT INTO migrations VALUES (?)').run('036_instance_branding.sql');
  db.close();
  try {
    expect((await migrateProductData(engine,product)).dryRun).toBe(true);
    const result = await migrateProductData(engine,product,join(dir,'backup'));
    expect(result.wrappedAgents).toEqual(['NestSystem']);
    const store = openProductDb(product);
    expect(store.branding().displayName).toBe('Camplight');store.saveBranding({...DEFAULT_BRANDING,displayName:'Edited'},'owner');store.close();
    const repeat = await migrateProductData(engine,product,join(dir,'backup2'));
    expect(repeat.wrappedAgents).toEqual([]);
    const verify = openProductDb(product);expect(verify.branding().displayName).toBe('Edited');verify.close();
    const original = new Database(join(dir,'backup/engine.sqlite'),{readonly:true});
    expect(original.prepare('SELECT * FROM instance_settings').all()).toHaveLength(1);original.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it('does not overwrite commands or add the compatibility prefix twice', () => {
  const command='node -e \'console.log(process.env.NEST_WRAPPED_MESSAGE)\'';
  const value=compatibleRecipe({runtime:{command},setup:{command:'echo setup'},sidecars:[{command:'echo sidecar'}]});
  expect(value.runtime.command).toContain('export NEST_WRAPPED_MESSAGE="${ORGOPS_WRAPPED_MESSAGE:-}"');
  expect(value.runtime.command.endsWith(command)).toBe(true);
  expect(compatibleRecipe(value)).toEqual(value);
});

it('executes a migrated Nest recipe in the unchanged OrgOps harness', async () => {
  const {runWrappedAgentTurn} = await import('../vendor/orgops/apps/agent-runner/src/wrapped-runtime');
  const workspacePath = mkdtempSync(join(tmpdir(),'nest-wrapped-compat-'));
  const emitted: any[] = [];
  try {
    await runWrappedAgentTurn({projectRoot:workspacePath, api:{
      emitEvent:async (event:unknown) => {emitted.push(event);},
      getPackageSecretsEnv:async () => ({}),
    }}, {
      name:'legacy-nest-agent', systemInstructions:'', soulPath:'', workspacePath,
      modelId:'wrapped:none', desiredState:'RUNNING', runtimeState:'RUNNING', mode:'WRAPPED',
      wrappedConfig:compatibleRecipe({kind:'test',runtime:{
        command:'node -e "process.stdout.write(JSON.stringify({payloads:[{text:process.env.NEST_WRAPPED_MESSAGE}]}))"',
        parse:'json-payloads',
      }}),
    }, [{id:'compat-event',type:'message.created',payload:{text:'Nest recipe works'},source:'human:owner',channelId:'channel',createdAt:Date.now()}]);
    expect(emitted.some(event => event.type === 'message.created' && event.payload.text === 'Nest recipe works')).toBe(true);
  } finally { rmSync(workspacePath,{recursive:true,force:true}); }
}, 15000);


it('rejects two paths pointing at the same database before changing it', async () => {
  const dir = mkdtempSync(join(tmpdir(),'nest-db-alias-'));
  const engine = join(dir,'engine.sqlite'), alias = join(dir,'product.sqlite');
  const db = new Database(engine); db.exec('CREATE TABLE original (id INTEGER)'); db.close();
  try {
    linkSync(engine,alias);
    await expect(migrateProductData(engine,alias,join(dir,'backup'))).rejects.toThrow('must be separate');
    const verify = new Database(engine,{readonly:true});
    try { expect(verify.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{name:'original'}]); }
    finally { verify.close(); }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
