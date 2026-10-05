import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openProductDb } from './index';
import { DEFAULT_BRANDING } from '../../schemas/src/branding';

it('upgrades an existing branding-only database once without changing its records',()=>{
  const dir=mkdtempSync(join(tmpdir(),'nest-product-upgrade-'));
  const path=join(dir,'product.sqlite');
  const legacy=new Database(path);
  legacy.exec('CREATE TABLE product_settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL); CREATE TABLE product_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,actor_id TEXT NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL)');
  const branding={...DEFAULT_BRANDING,displayName:'Existing instance'};
  legacy.prepare('INSERT INTO product_settings VALUES (?,?)').run('branding',JSON.stringify(branding));
  legacy.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES (?,?,?,?)').run('audit.branding.updated','owner','{}',123);
  legacy.close();
  try {
    for(let i=0;i<2;i++){
      const store=openProductDb(path);
      try {
        expect(store.branding()).toEqual(branding);
        expect(store.db.prepare('SELECT * FROM product_migrations').all()).toEqual([{name:'001_projects'},{name:'002_project_chats'}]);
        expect(store.db.prepare('SELECT type,created_at FROM product_audit').all()).toEqual([{type:'audit.branding.updated',created_at:123}]);
        expect(store.projects.projects('owner')).toEqual([]);
      } finally {store.close();}
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
