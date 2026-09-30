import Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProductDb } from '../packages/db/src/index';
import { BrandingSchema } from '../packages/schemas/src/branding';

const wrappedKeys = ['AGENT_NAME','KIND','WORKSPACE_PATH','CHANNEL_ID','SESSION_ID','MESSAGE','TRIGGER_EVENT_ID','SOURCE_DIR'];
const prefix = '# nest-orgops-env-v1\n' + wrappedKeys.map(key => `export NEST_WRAPPED_${key}="\${ORGOPS_WRAPPED_${key}:-}"`).join('\n') + '\n';
export function compatibleRecipe(input: unknown): any {
  if (!input || typeof input !== 'object') return input;
  const config = structuredClone(input) as any;
  const commands = [config.setup, config.runtime, ...(Array.isArray(config.sidecars) ? config.sidecars : [])];
  for (const item of commands) {
    if (!item || typeof item !== 'object') continue;
    for (const key of ['command','checkCommand']) {
      if (typeof item[key] === 'string' && item[key] && !item[key].startsWith('# nest-orgops-env-v1\n')) item[key] = prefix + item[key];
    }
  }
  return config;
}

export async function migrateProductData(enginePath: string, productPath: string, backupDir?: string) {
  if (resolve(enginePath) === resolve(productPath)) throw new Error('Product and engine databases must be separate');
  if (!existsSync(enginePath)) throw new Error('Engine database does not exist');
  if (existsSync(productPath)) {
    const engineFile = statSync(enginePath);
    const productFile = statSync(productPath);
    if (engineFile.dev === productFile.dev && engineFile.ino === productFile.ino) {
      throw new Error('Product and engine databases must be separate');
    }
  }
  const source = new Database(enginePath, {readonly: !backupDir, fileMustExist: true});
  let product: ReturnType<typeof openProductDb> | undefined;
  try {
    const table = source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='instance_settings'").get();
    const row = table ? source.prepare("SELECT value_json FROM instance_settings WHERE key='branding'").get() as {value_json:string} | undefined : undefined;
    const branding = row ? BrandingSchema.parse(JSON.parse(row.value_json)) : undefined;
    const agents = source.prepare("SELECT name, wrapped_config_json FROM agents WHERE mode='WRAPPED'").all() as {name:string;wrapped_config_json:string}[];
    const updates = agents.map(agent => ({...agent, config: JSON.stringify(compatibleRecipe(JSON.parse(agent.wrapped_config_json)))})).filter(agent => agent.config !== agent.wrapped_config_json);
    if (!backupDir) return {dryRun:true, branding: Boolean(branding), wrappedAgents: updates.map(x=>x.name)};
    mkdirSync(backupDir, {recursive:true, mode:0o700});
    const engineBackup = resolve(backupDir,'engine.sqlite');
    if (existsSync(engineBackup) || existsSync(resolve(backupDir,'product.sqlite'))) throw new Error('Backup already exists; use a new backup directory');
    await source.backup(engineBackup);
    if (existsSync(productPath)) {
      const existing = new Database(productPath, {readonly:true});
      try { await existing.backup(resolve(backupDir,'product.sqlite')); } finally { existing.close(); }
    }
    product = openProductDb(productPath);
    // Repeated migrations must not overwrite branding edited in the product UI.
    if (branding && !product.db.prepare("SELECT 1 FROM product_settings WHERE key='branding'").get()) product.saveBranding(branding,'migration');
    source.transaction(() => {
      for (const agent of updates) source.prepare('UPDATE agents SET wrapped_config_json=? WHERE name=?').run(agent.config,agent.name);
      if (table) {
        source.prepare("DELETE FROM instance_settings WHERE key='branding'").run();
        const remaining = source.prepare('SELECT COUNT(*) AS count FROM instance_settings').get() as {count:number};
        if (!remaining.count) source.exec('DROP TABLE instance_settings');
      }
      source.prepare("DELETE FROM migrations WHERE id='036_instance_branding.sql'").run();
    })();
    return {dryRun:false, branding:Boolean(branding), wrappedAgents:updates.map(x=>x.name), backupDir};
  } finally { product?.close(); source.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [engine, product, ...flags] = process.argv.slice(2);
  if (!engine || !product) throw new Error('Usage: migrate-product-data.ts ENGINE_DB PRODUCT_DB [--apply --services-stopped BACKUP_DIR]');
  const apply = flags.includes('--apply');
  if (apply && (flags[0] !== '--apply' || flags[1] !== '--services-stopped' || !flags[2] || flags.length !== 3)) throw new Error('Stop API and runner first; provide --apply --services-stopped BACKUP_DIR');
  console.log(JSON.stringify(await migrateProductData(engine, product, apply ? flags[2] : undefined), null, 2));
}
