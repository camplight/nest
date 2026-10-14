import type Database from 'better-sqlite3';
import type { Project, Task, Deliverable, Review } from '../../schemas/src/projects';

export function createProjectStore(db: Database.Database) {
  const projectColumns = 'id, owner_id AS ownerId, channel_id AS channelId, name, description, created_at AS createdAt, collaboration';
  function project(id: string) { return db.prepare(`SELECT ${projectColumns} FROM product_projects WHERE id=?`).get(id) as Project | undefined; }
  function projects(ownerId: string, teamChannels:string[]=[]) {
    const shared=teamChannels.length?` OR (collaboration='team' AND channel_id IN (${teamChannels.map(()=>'?').join(',')}))`:'';
    return db.prepare(`SELECT ${projectColumns} FROM product_projects WHERE owner_id=?${shared} ORDER BY created_at DESC`).all(ownerId,...teamChannels) as Project[];
  }
  function task(id: string) {
    const row = db.prepare('SELECT data_json FROM product_tasks WHERE id=?').get(id) as {data_json: string} | undefined;
    return row ? JSON.parse(row.data_json) as Task : undefined;
  }
  function audit(type: string, actor: string, payload: unknown) {
    db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES (?,?,?,?)').run(type,actor,JSON.stringify(payload),Date.now());
  }
  function createProject(value: Project) {
    db.transaction(() => {
      db.prepare('INSERT INTO product_projects(id,owner_id,channel_id,name,description,created_at,collaboration) VALUES (?,?,?,?,?,?,?)').run(value.id,value.ownerId,value.channelId,value.name,value.description,value.createdAt,value.collaboration??'private');
      audit('audit.project.created',value.ownerId,{projectId:value.id});
    })();
    return value;
  }
  function canNameProject(id:string) {
    return !db.prepare("SELECT 1 FROM product_audit WHERE type IN ('audit.project.updated','audit.project.naming.applied') AND json_extract(payload_json,'$.projectId')=? LIMIT 1").get(id);
  }
  function openingMessage(project:Project,requestId:string) {
    return db.prepare('SELECT event_id AS eventId FROM product_message_requests WHERE id=? AND sender_id=? AND channel_id=? AND delivered_at IS NOT NULL').get(requestId,project.ownerId,project.channelId) as {eventId:string}|undefined;
  }
  function updateProject(id:string,ownerId:string,value:{name:string;description:string},expected:{name:string;description:string},source:'human'|'ai'='human') {
    return db.transaction(()=>{
      if(source==='ai'&&!canNameProject(id))return null;
      const changed=db.prepare('UPDATE product_projects SET name=?,description=? WHERE id=? AND owner_id=? AND name=? AND description=?').run(value.name,value.description,id,ownerId,expected.name,expected.description).changes;
      if(!changed)return null;
      audit(source==='ai'?'audit.project.naming.applied':'audit.project.updated',ownerId,{projectId:id});
      return project(id)!;
    })();
  }
  function createTask(value: Task, actor: string) {
    db.transaction(() => {
      db.prepare('INSERT INTO product_tasks VALUES (?,?,?,?)').run(value.id,value.projectId,value.version,JSON.stringify(value));
      audit('audit.task.created',actor,{taskId:value.id,projectId:value.projectId});
    })();
    return value;
  }
  // Async engine calls finish before this transaction. Compare-and-swap rejects
  // stale submissions/reviews and preserves an immutable audit trail.
  function changeTask(previous: Task, next: Task, actor: string, extra?: {deliverable?: Deliverable; review?: Review}) {
    return db.transaction(() => {
      const result = db.prepare('UPDATE product_tasks SET version=?,data_json=? WHERE id=? AND version=?')
        .run(next.version,JSON.stringify(next),previous.id,previous.version);
      if (!result.changes) return false;
      const d = extra?.deliverable;
      if (d) db.prepare('INSERT INTO product_deliverables VALUES (?,?,?,?,?,?,?)').run(d.id,d.taskId,d.attempt,d.eventId,d.text,d.submittedBy,d.createdAt);
      const r = extra?.review;
      if (r) db.prepare('INSERT INTO product_reviews VALUES (?,?,?,?,?,?,?)').run(r.id,r.taskId,r.deliverableId,r.decision,r.feedback,r.reviewerId,r.createdAt);
      audit(`audit.task.${next.status}`,actor,{taskId:next.id,attempt:next.attempt,version:next.version});
      return true;
    })();
  }
  function tasks(projectId: string) {
    return (db.prepare('SELECT data_json FROM product_tasks WHERE project_id=? ORDER BY rowid').all(projectId) as {data_json:string}[]).map(row => JSON.parse(row.data_json) as Task);
  }
  function detail(value: Project) {
    const deliverables = db.prepare('SELECT d.id,d.task_id AS taskId,d.attempt,d.event_id AS eventId,d.text,d.submitted_by AS submittedBy,d.created_at AS createdAt FROM product_deliverables d JOIN product_tasks t ON t.id=d.task_id WHERE t.project_id=? ORDER BY d.created_at').all(value.id) as Deliverable[];
    const reviews = db.prepare('SELECT r.id,r.task_id AS taskId,r.deliverable_id AS deliverableId,r.decision,r.feedback,r.reviewer_id AS reviewerId,r.created_at AS createdAt FROM product_reviews r JOIN product_tasks t ON t.id=r.task_id WHERE t.project_id=? ORDER BY r.created_at').all(value.id) as Review[];
    return {...value,tasks:tasks(value.id),deliverables,reviews};
  }
  return {project,projects,task,tasks,createProject,updateProject,canNameProject,openingMessage,createTask,changeTask,detail};
}
