import type Database from 'better-sqlite3';
import type {CommunityPackage,CommunityFile,CommunitySkill,CommunityToken} from '../../schemas/src/community';
export type CommunityActor={kind:'human'|'agent';id:string;name:string;ownerId:string};
type Row={name:string;owner_id:string;author_kind:'human'|'agent';author_id:string;author_name:string;latest_version:string;created_at:number;updated_at:number};
type Version={version:string;manifest_json:string;files_json:string;digest:string;created_at:number};
export function createCommunityStore(db:Database.Database){
  const audit=db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES (?,?,?,?)');
  function row(name:string){return db.prepare('SELECT * FROM community_skills WHERE name=?').get(name) as Row|undefined;}
  function canPublish(value:Row,actor:CommunityActor){return actor.kind==='human' ? value.owner_id===actor.id : value.author_kind==='agent'&&value.author_id===actor.id&&value.owner_id===actor.ownerId;}
  function version(name:string,version:string){return db.prepare('SELECT * FROM community_versions WHERE skill_name=? AND version=?').get(name,version) as Version|undefined;}
  function summary(value:Row,actor:CommunityActor,release=version(value.name,value.latest_version)!):CommunitySkill{
    const manifest=JSON.parse(release.manifest_json) as CommunityPackage['manifest'];
    const count=db.prepare('SELECT COUNT(*) AS count FROM community_versions WHERE skill_name=?').get(value.name) as {count:number};
    return {...manifest,author:{kind:value.author_kind,name:value.author_name},ownerId:value.owner_id,digest:release.digest,createdAt:value.created_at,updatedAt:release.created_at,versionCount:count.count,fileCount:(JSON.parse(release.files_json) as CommunityFile[]).length,canPublish:canPublish(value,actor)};
  }
  function detail(name:string,actor:CommunityActor,releaseVersion?:string){
    const value=row(name);if(!value)return null;const release=version(name,releaseVersion??value.latest_version);if(!release)return null;
    return {skill:summary(value,actor,release),files:JSON.parse(release.files_json) as CommunityFile[],versions:db.prepare('SELECT version,created_at AS createdAt,digest FROM community_versions WHERE skill_name=? ORDER BY created_at DESC,rowid DESC').all(name) as {version:string;createdAt:number;digest:string}[]};
  }
  function list(actor:CommunityActor,{query='',category='',offset=0,limit=30}:{query?:string;category?:string;offset?:number;limit?:number}){
    const search=`%${query.replace(/[\\%_]/g,'\\$&').toLowerCase()}%`;
    const where=`FROM community_skills s JOIN community_versions v ON v.skill_name=s.name AND v.version=s.latest_version WHERE (?='' OR json_extract(v.manifest_json,'$.category')=?) AND lower(s.name||' '||s.author_name||' '||json_extract(v.manifest_json,'$.title')||' '||json_extract(v.manifest_json,'$.description')||' '||json_extract(v.manifest_json,'$.tags')) LIKE ? ESCAPE '\\'`;
    const params=[category,category,search];
    const total=(db.prepare(`SELECT COUNT(*) AS count ${where}`).get(...params) as {count:number}).count;
    const rows=db.prepare(`SELECT s.* ${where} ORDER BY s.updated_at DESC,s.name LIMIT ? OFFSET ?`).all(...params,limit,offset) as Row[];
    return {skills:rows.map(value=>summary(value,actor)),total,offset,limit};
  }
  const publish=db.transaction((submission:CommunityPackage,files:CommunityFile[],digest:string,actor:CommunityActor)=>{
    const m=submission.manifest;const existing=row(m.name);
    if(existing&&!canPublish(existing,actor))return {error:'Only the publisher or their human owner can publish new versions',status:403 as const};
    const previous=version(m.name,m.version);
    if(previous)return previous.digest===digest?{detail:detail(m.name,actor,m.version),created:false}:{error:'This version already exists with different contents',status:409 as const};
    if(existing){const before=existing.latest_version.split('.').map(BigInt),after=m.version.split('.').map(BigInt);const diff=after.findIndex((n,i)=>n!==before[i]);if(diff<0||after[diff]<=before[diff])return {error:'Use a version higher than the current version',status:409 as const};}
    const time=Date.now();
    if(!existing)db.prepare('INSERT INTO community_skills VALUES (?,?,?,?,?,?,?,?)').run(m.name,actor.ownerId,actor.kind,actor.id,actor.name,m.version,time,time);
    db.prepare('INSERT INTO community_versions VALUES (?,?,?,?,?,?)').run(m.name,m.version,JSON.stringify(m),JSON.stringify(files),digest,time);
    db.prepare('UPDATE community_skills SET latest_version=?,updated_at=? WHERE name=?').run(m.version,time,m.name);
    audit.run('audit.community.published',`${actor.kind}:${actor.id}`,JSON.stringify({name:m.name,version:m.version,digest}),time);
    return {detail:detail(m.name,actor,m.version),created:true};
  });
  function issueToken(value:{id:string;ownerId:string;agentId:string;agentName:string;hash:string;createdAt:number;expiresAt:number}){
    db.transaction(()=>{db.prepare('INSERT INTO community_tokens VALUES (?,?,?,?,?,?,?,NULL)').run(value.id,value.ownerId,value.agentId,value.agentName,value.hash,value.createdAt,value.expiresAt);audit.run('audit.community.token.created',value.ownerId,JSON.stringify({id:value.id,agentName:value.agentName}),value.createdAt);})();
  }
  function token(hash:string){return db.prepare('SELECT id,owner_id AS ownerId,agent_id AS agentId,agent_name AS agentName FROM community_tokens WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').get(hash,Date.now()) as {id:string;ownerId:string;agentId:string;agentName:string}|undefined;}
  function tokens(owner:string){return db.prepare('SELECT id,agent_name AS agentName,created_at AS createdAt,expires_at AS expiresAt,revoked_at AS revokedAt FROM community_tokens WHERE owner_id=? ORDER BY created_at DESC').all(owner) as CommunityToken[];}
  function revoke(id:string,owner:string){return db.transaction(()=>{const result=db.prepare('UPDATE community_tokens SET revoked_at=? WHERE id=? AND owner_id=? AND revoked_at IS NULL').run(Date.now(),id,owner);if(result.changes)audit.run('audit.community.token.revoked',owner,JSON.stringify({id}),Date.now());return Boolean(result.changes);})();}
  return {list,detail,publish,issueToken,token,tokens,revoke};
}
