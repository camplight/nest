import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
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
        expect(store.db.prepare('SELECT * FROM product_migrations').all()).toEqual([{name:'001_projects'},{name:'002_project_chats'},{name:'003_community'},{name:'004_personal_agents'},{name:'005_integrations'},{name:'006_mentions'},{name:'007_agent_requests'},{name:'008_project_collaboration'}]);
        expect(store.db.prepare('SELECT type,created_at FROM product_audit').all()).toEqual([{type:'audit.branding.updated',created_at:123}]);
        expect(store.projects.projects('owner')).toEqual([]);
      } finally {store.close();}
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it('keeps existing project history private when adding team collaboration',()=>{
  const dir=mkdtempSync(join(tmpdir(),'nest-project-privacy-upgrade-'));
  const path=join(dir,'product.sqlite');
  const legacy=new Database(path);
  legacy.exec(readFileSync(new URL('../migrations/001_projects.sql',import.meta.url),'utf8'));
  legacy.exec('CREATE TABLE product_migrations(name TEXT PRIMARY KEY)');
  legacy.prepare('INSERT INTO product_migrations VALUES (?)').run('001_projects');
  legacy.prepare('INSERT INTO product_projects VALUES (?,?,?,?,?,?)').run('legacy','owner','shared-chat','Private project','Original brief',123);
  const task={id:'old-task',projectId:'legacy',instructions:'Private historical instructions'};
  legacy.prepare('INSERT INTO product_tasks VALUES (?,?,?,?)').run(task.id,'legacy',0,JSON.stringify(task));
  legacy.close();
  try {
    const store=openProductDb(path);
    try{
      expect(store.projects.project('legacy')).toMatchObject({collaboration:'private',name:'Private project',description:'Original brief',createdAt:123});
      expect(store.projects.task(task.id)).toEqual(task);
      expect(store.projects.projects('teammate',['shared-chat'])).toEqual([]);
    }finally{store.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
