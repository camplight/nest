import {it, expect} from 'vitest';
import {copyFileSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDb, migrate} from '@orgops/db';

it('upgrades the previous engine schema without losing instructions, identities or runtime configuration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nest-engine-upgrade-'));
  const migrations = fileURLToPath(new URL('../vendor/orgops/packages/db/migrations/', import.meta.url));
  const db = openDb(':memory:');
  try {
    for (const file of readdirSync(migrations).filter(file => file.endsWith('.sql') && file < '039')) {
      copyFileSync(join(migrations, file), join(directory, file));
    }
    migrate(db, directory);
    const wrappedConfig = JSON.stringify({kind:'codex',runtime:{command:'node bridge.mjs'},setup:{command:'node install.mjs'}});
    db.prepare('INSERT INTO humans (id,username,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)').run('owner-id','owner','fixture-hash',1,1);
    db.prepare('INSERT INTO runner_nodes (id,display_name,created_at,updated_at,last_seen_at) VALUES (?,?,?,?,?)').run('runner-id','Existing runner',1,1,1);
    const insert = db.prepare(`INSERT INTO agents (id,name,model_id,system_instructions,soul_contents,soul_path,workspace_path,mode,wrapped_config_json,assigned_runner_id,owner_human_id,visibility,enabled_skills_json,additional_skill_roots_json,allow_owner_human_secrets,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const [name, instructions, soul] of [['combined','Instructions','Existing soul'],['instructions','Instructions',''],['soul','','Existing soul']]) {
      insert.run(`${name}-id`,name,'wrapped:none',instructions,soul,'/existing/soul.md',`/existing/${name}`,'WRAPPED',wrappedConfig,'runner-id','owner-id','PRIVATE','["nest-connections"]','["/existing/skills"]',0,1,1);
    }
    db.prepare('INSERT INTO channels (id,name,created_at,visibility,owner_human_id) VALUES (?,?,?,?,?)').run('channel-id','private-chat',1,'PRIVATE','owner-id');
    db.prepare('INSERT INTO channel_subscriptions VALUES (?,?,?)').run('channel-id','AGENT','combined');
    db.prepare('INSERT INTO secrets (id,name,scope_type,scope_id,ciphertext_b64,created_at) VALUES (?,?,?,?,?,?)').run('secret-id','FIXTURE','private','combined','fixture-encrypted-value',1);
    const preserved = ['humans','runner_nodes','channels','channel_subscriptions','secrets'];
    const before = preserved.map(table => db.prepare(`SELECT * FROM ${table}`).all());

    migrate(db);

    expect(preserved.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(db.prepare('SELECT name,soul_contents FROM agents ORDER BY name').all()).toEqual([
      {name:'combined',soul_contents:'Instructions\n\nExisting soul'},
      {name:'instructions',soul_contents:'Instructions'},
      {name:'soul',soul_contents:'Existing soul'},
    ]);
    expect(db.prepare('SELECT * FROM agents WHERE name=?').get('combined')).toMatchObject({
      id:'combined-id',workspace_path:'/existing/combined',mode:'WRAPPED',wrapped_config_json:wrappedConfig,
      assigned_runner_id:'runner-id',owner_human_id:'owner-id',visibility:'PRIVATE',enabled_skills_json:'["nest-connections"]',
      additional_skill_roots_json:'["/existing/skills"]',allow_owner_human_secrets:0,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const count = db.prepare('SELECT COUNT(*) AS count FROM migrations').get();
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS count FROM migrations').get()).toEqual(count);
  } finally { db.close(); rmSync(directory, {recursive:true, force:true}); }
});
