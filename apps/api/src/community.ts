import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {parse as parseYaml} from 'yaml';
import {CommunitySubmission,CommunityName,type CommunityFile} from '@nest/schemas';
import type {ProductDb} from '@nest/db';
import type {OrgOpsClient,Human} from '@nest/orgops-client';
import type {CommunityActor} from '../../../packages/db/src/community';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function registerCommunityRoutes(app:Hono,{store,orgops}:{store:ProductDb;orgops:OrgOpsClient}){
  const routes=new Hono<{Variables:{actor:CommunityActor;human:Human|null}}>();
  routes.onError((_error,c)=>c.json({error:'Community service unavailable. Your published versions are retained.'},503));
  routes.use('/api/community/*',bodyLimit({maxSize:1024*1024,onError:c=>c.json({error:'Skill package exceeds 1 MB'},413)}));
  routes.use('/api/community/*',async(c,next)=>{
    c.header('Cache-Control','no-store');
    if(c.req.method==='POST'&&!c.req.header('content-type')?.toLowerCase().startsWith('application/json'))return c.json({error:'Use application/json'},415);
    const authorization=c.req.header('authorization');
    if(authorization){
      if(!/^Bearer nest_community_[a-f0-9]{64}$/.test(authorization))return c.json({error:'Invalid community token'},401);
      const token=store.community.token(hash(authorization.slice(7)));
      if(!token)return c.json({error:'Community token is expired or revoked'},401);
      c.set('actor',{kind:'agent',id:token.agentId,name:token.agentName,ownerId:token.ownerId});c.set('human',null);
    } else {
      const human=await orgops.currentHuman(c.req.raw.headers);
      if(!human)return c.json({error:'Sign in to access your tenant community'},401);
      if(human.mustChangePassword)return c.json({error:'Complete password setup first'},403);
      c.set('actor',{kind:'human',id:human.id,name:human.username,ownerId:human.id});c.set('human',human);
    }
    await next();
  });
  routes.get('/api/community/skills',c=>{
    const category=c.req.query('category')??'';const query=c.req.query('q')??'';
    const offset=Number(c.req.query('offset')??0),limit=Number(c.req.query('limit')??30);
    if(query.length>200||!['','skill','automation','use-case'].includes(category)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)return c.json({error:'Invalid catalog filters'},400);
    return c.json(store.community.list(c.get('actor'),{query,category,offset,limit}));
  });
  routes.get('/api/community/skills/:name',c=>{
    if(!CommunityName.safeParse(c.req.param('name')).success)return c.json({error:'Invalid skill name'},400);
    const value=store.community.detail(c.req.param('name'),c.get('actor'),c.req.query('version'));
    return value?c.json(value):c.json({error:'Skill version not found'},404);
  });
  routes.get('/api/community/skills/:name/download',c=>{
    const detail=store.community.detail(c.req.param('name'),c.get('actor'),c.req.query('version'));
    if(!detail)return c.json({error:'Skill version not found'},404);
    const {author,ownerId,digest,createdAt,updatedAt,versionCount,fileCount,canPublish,...manifest}=detail.skill;
    c.header('Content-Disposition',`attachment; filename="${manifest.name}-${manifest.version}.nest-skill.json"`);c.header('X-Content-Type-Options','nosniff');
    return c.json({schemaVersion:1,manifest,files:detail.files,digest});
  });
  routes.post('/api/community/skills',async c=>{
    const parsed=CommunitySubmission.safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)return c.json({error:parsed.error.issues.map(issue=>issue.message).join('; ')},400);
    const value=parsed.data;
    const files:CommunityFile[]=[];let total=0;
    for(const file of [...value.files].sort((a,b)=>a.path<b.path?-1:1)){
      if(value.files.some(other=>other.path!==file.path&&other.path.toLowerCase().startsWith(file.path.toLowerCase()+'/')))return c.json({error:'File and directory paths overlap'},400);
      const bytes=Buffer.from(file.content,file.encoding==='base64'?'base64':'utf8');total+=bytes.byteLength;
      if(file.encoding==='base64'&&bytes.toString('base64')!==file.content)return c.json({error:'Invalid base64 file'},400);
      if(bytes.byteLength>128*1024||total>512*1024)return c.json({error:'Files exceed the package size limit'},400);
      files.push({...file,bytes:bytes.byteLength,sha256:hash(bytes)});
    }
    const markdown=files.find(f=>f.path==='SKILL.md')!;
    if(markdown.bytes>65536)return c.json({error:'SKILL.md exceeds 64 KB'},400);
    const match=markdown.content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/);
    try {
      if(!match||match[2].trim().length<40)throw new Error();
      const meta=parseYaml(match[1],{maxAliasCount:0});
      if(meta?.name!==value.manifest.name||meta?.description!==value.manifest.description||meta?.license!==value.manifest.license)throw new Error();
    }catch{return c.json({error:'SKILL.md must include matching name, description and license frontmatter plus useful instructions'},400);}
    const digest=hash(JSON.stringify({manifest:value.manifest,files:files.map(({content,...file})=>file)}));
    const result=store.community.publish(value,files,digest,c.get('actor'));
    return 'error' in result?c.json({error:result.error},result.status):c.json(result.detail,result.created?201:200);
  });
  routes.get('/api/community/tokens',c=>{const human=c.get('human');return human?c.json(store.community.tokens(human.id)):c.json({error:'Human sign-in required'},403);});
  routes.post('/api/community/tokens',async c=>{
    const human=c.get('human');if(!human)return c.json({error:'Only people can authorize publishing agents'},403);
    const body=await c.req.json().catch(()=>null);
    if(!body||typeof body.agentName!=='string'||!body.agentName.trim()||body.agentName.length>200)return c.json({error:'Choose an existing agent'},400);
    const response=await orgops.request(`/api/agents/${encodeURIComponent(body.agentName)}`,{headers:{cookie:c.req.header('cookie')??''}});
    if(!response.ok)return c.json({error:'Agent not available'},404);
    const agent=await response.json() as {id?:string;name:string;ownerHumanId?:string|null};
    if(agent.ownerHumanId!==human.id&&!await orgops.isOwner(human,c.req.raw.headers))return c.json({error:'Only the agent owner or instance owner can issue its community token'},403);
    const secret=`nest_community_${randomBytes(32).toString('hex')}`;const time=Date.now();const id=randomUUID();const expiresAt=time+30*24*60*60*1000;
    store.community.issueToken({id,ownerId:human.id,agentId:agent.id??agent.name,agentName:agent.name,hash:hash(secret),createdAt:time,expiresAt});
    return c.json({id,agentName:agent.name,token:secret,expiresAt},201);
  });
  routes.delete('/api/community/tokens/:id',c=>{
    const human=c.get('human');if(!human)return c.json({error:'Human sign-in required'},403);
    return store.community.revoke(c.req.param('id'),human.id)?c.json({ok:true}):c.json({error:'Token not found or already revoked'},404);
  });
  routes.all('/api/community/*',c=>c.json({error:'Not found'},404));
  app.route('/',routes);
}
