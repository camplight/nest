import type Database from 'better-sqlite3';
import type { Project, Task, Deliverable, Review } from '../../schemas/src/projects';

export function createProjectStore(db: Database.Database) {
  const projectColumns = 'id, owner_id AS ownerId, channel_id AS channelId, name, description, created_at AS createdAt';
  function project(id: string) { return db.prepare(`SELECT ${projectColumns} FROM product_projects WHERE id=?`).get(id) as Project | undefined; }
  function projects(ownerId: string) { return db.prepare(`SELECT ${projectColumns} FROM product_projects WHERE owner_id=? ORDER BY created_at DESC`).all(ownerId) as Project[]; }
  function task(id: string) {
    const row = db.prepare('SELECT data_json FROM product_tasks WHERE id=?').get(id) as {data_json: string} | undefined;
    return row ? JSON.parse(row.data_json) as Task : undefined;
  }
  function audit(type: string, actor: string, payload: unknown) {
    db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES (?,?,?,?)').run(type,actor,JSON.stringify(payload),Date.now());
  }
  function createProject(value: Project) {
    db.transaction(() => {
      db.prepare('INSERT INTO product_projects VALUES (?,?,?,?,?,?)').run(value.id,value.ownerId,value.channelId,value.name,value.description,value.createdAt);
      audit('audit.project.created',value.ownerId,{projectId:value.id});
    })();
    return value;
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
  function detail(value: Project) {
    const tasks = (db.prepare('SELECT data_json FROM product_tasks WHERE project_id=? ORDER BY rowid').all(value.id) as {data_json:string}[]).map(row => JSON.parse(row.data_json) as Task);
    const deliverables = db.prepare('SELECT d.id,d.task_id AS taskId,d.attempt,d.event_id AS eventId,d.text,d.submitted_by AS submittedBy,d.created_at AS createdAt FROM product_deliverables d JOIN product_tasks t ON t.id=d.task_id WHERE t.project_id=? ORDER BY d.created_at').all(value.id) as Deliverable[];
    const reviews = db.prepare('SELECT r.id,r.task_id AS taskId,r.deliverable_id AS deliverableId,r.decision,r.feedback,r.reviewer_id AS reviewerId,r.created_at AS createdAt FROM product_reviews r JOIN product_tasks t ON t.id=r.task_id WHERE t.project_id=? ORDER BY r.created_at').all(value.id) as Review[];
    return {...value,tasks,deliverables,reviews};
  }
  return {project,projects,task,createProject,createTask,changeTask,detail};
}
