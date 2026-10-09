#!/usr/bin/env node
import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(condition,message)=>{if(!condition)throw new Error(message);};
const slug=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const keys=['name','title','description','version','category','license','tags','runtimes'];
function normalizeManifest(value){
  fail(value&&typeof value==='object','Missing manifest');
  const m=Object.fromEntries(keys.map(key=>[key,value[key]]));
  fail(typeof m.name==='string'&&m.name.length<=63&&slug.test(m.name),'Invalid skill name');
  fail(typeof m.title==='string'&&m.title.length>0&&m.title.length<=100&&typeof m.description==='string'&&m.description.length>=10&&m.description.length<=500,'Invalid title or description');
  fail(typeof m.version==='string'&&m.version.length<=30&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(m.version),'Invalid version');
  fail(['skill','automation','use-case'].includes(m.category)&&['MIT','Apache-2.0','CC-BY-4.0','Proprietary'].includes(m.license),'Invalid category or license');
  fail(Array.isArray(m.tags)&&m.tags.length<=8&&m.tags.every(t=>typeof t==='string'&&t.length<=30&&slug.test(t)),'Invalid tags');
  fail(Array.isArray(m.runtimes)&&m.runtimes.length>0&&m.runtimes.length<=3&&m.runtimes.every(r=>['generic','codex','orgops'].includes(r)),'Invalid runtimes');
  return m;
}
function validPath(path){return typeof path==='string'&&path.length<=200&&/^[a-zA-Z0-9_./-]+$/.test(path)&&!path.startsWith('/')&&!path.split('/').some(p=>!p||p.startsWith('.'))&&(path==='SKILL.md'||/^event-shapes\.(ts|js)$/.test(path)||/^(scripts|references|assets|agents)\//.test(path));}
export function verifyPackage(value,{requireDigest=true}={}){
  fail(value?.schemaVersion===1&&Array.isArray(value.files)&&value.files.length>0&&value.files.length<=64,'Unsupported skill package');
  const manifest=normalizeManifest(value.manifest);const seen=new Set();let size=0;
  const files=value.files.map(file=>{
    fail(validPath(file.path)&&!seen.has(file.path.toLowerCase()),'Unsafe or duplicate file path');seen.add(file.path.toLowerCase());
    fail(typeof file.content==='string'&&file.content.length<=180000&&['utf8','base64'].includes(file.encoding??'utf8')&&typeof (file.executable??false)==='boolean','Invalid file contents');
    const encoding=file.encoding??'utf8';const bytes=Buffer.from(file.content,encoding==='base64'?'base64':'utf8');size+=bytes.byteLength;
    fail(bytes.byteLength<=128*1024&&size<=512*1024,'Package exceeds size limit');
    fail(encoding!=='base64'||bytes.toString('base64')===file.content,'Invalid base64 file');
    const sha256=hash(bytes);
    if(file.sha256!==undefined)fail(file.sha256===sha256&&file.bytes===bytes.byteLength,'File integrity mismatch');
    return {path:file.path,content:file.content,encoding,executable:file.executable??false,bytes:bytes.byteLength,sha256};
  }).sort((a,b)=>a.path<b.path?-1:1);
  fail(files.some(f=>f.path==='SKILL.md'&&f.encoding==='utf8'&&f.bytes<=65536),'A UTF-8 SKILL.md under 64 KB is required');
  for(const file of files)fail(!files.some(other=>other.path!==file.path&&other.path.toLowerCase().startsWith(file.path.toLowerCase()+'/')),'File and directory paths overlap');
  const digest=hash(JSON.stringify({manifest,files:files.map(({content,...f})=>f)}));
  if(requireDigest||value.digest!==undefined)fail(digest===value.digest,'Package integrity mismatch');
  return {schemaVersion:1,manifest,files,digest};
}
function readPackage(path){fail(lstatSync(path).size<=1024*1024,'Package exceeds 1 MB');return JSON.parse(readFileSync(path,'utf8'));}
export function pack(directory){
  const root=realpathSync(directory);const manifest=normalizeManifest(JSON.parse(readFileSync(join(root,'skill.json'),'utf8')));const files=[];
  function visit(relative=''){
    for(const entry of readdirSync(join(root,relative),{withFileTypes:true})){
      const path=relative?`${relative}/${entry.name}`:entry.name;if(path==='skill.json')continue;
      fail(!entry.isSymbolicLink(),'Symlinks are not allowed');
      if(entry.isDirectory()){fail(/^(scripts|references|assets|agents)(\/|$)/.test(path)&&!path.split('/').some(p=>p.startsWith('.')),'Unsupported directory');visit(path);}
      else {fail(entry.isFile()&&validPath(path),'Unsupported file');const source=join(root,path),stat=lstatSync(source);fail(stat.size<=128*1024,'File exceeds 128 KB');const content=readFileSync(source);const utf8=content.toString('utf8');const encoding=Buffer.from(utf8).equals(content)?'utf8':'base64';files.push({path,content:encoding==='utf8'?utf8:content.toString('base64'),encoding,executable:Boolean(stat.mode&0o111)});}
    }
  }
  visit();return verifyPackage({schemaVersion:1,manifest,files},{requireDigest:false});
}
export function install(bundle,destination){
  const value=verifyPackage(bundle);fail(destination,'Supply an explicit skills directory with --dest');
  const base=resolve(destination);mkdirSync(base,{recursive:true});const root=realpathSync(base);const target=join(root,value.manifest.name);
  fail(!lstatSync(target,{throwIfNoEntry:false}),'Skill already installed. Move or remove the existing copy explicitly before upgrading');
  const stage=mkdtempSync(join(root,`.nest-install-${randomUUID()}-`));
  try{
    for(const file of value.files){const dest=join(stage,file.path);mkdirSync(resolve(dest,'..'),{recursive:true});writeFileSync(dest,Buffer.from(file.content,file.encoding==='base64'?'base64':'utf8'),{flag:'wx',mode:file.executable?0o755:0o644});}
    const lock=join(root,`.nest-lock-${value.manifest.name}`);mkdirSync(lock);
    try{fail(!lstatSync(target,{throwIfNoEntry:false}),'Skill already installed');renameSync(stage,target);}
    finally{rmSync(lock,{recursive:true,force:true});}
  }finally{rmSync(stage,{recursive:true,force:true});}
  return {name:value.manifest.name,version:value.manifest.version,path:target,digest:value.digest};
}
async function request(path,body){
  const origin=new URL(process.env.NEST_COMMUNITY_URL??'');
  fail(!origin.username&&!origin.password&&origin.pathname==='/'&&!origin.search&&!origin.hash&&(origin.protocol==='https:'||(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname))),'Set NEST_COMMUNITY_URL to your tenant HTTPS origin');
  const token=process.env.NEST_COMMUNITY_TOKEN;fail(token&&/^nest_community_[a-f0-9]{64}$/.test(token),'Set NEST_COMMUNITY_TOKEN to a community publishing token');
  const response=await fetch(new URL(path,origin),{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(15000)});
  fail(response.ok,`Community request failed (${response.status}); check permissions, token expiry and package validation`);
  const reader=response.body.getReader();let size=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;fail(size<=2*1024*1024,'Response exceeds size limit');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function main(){
  const [command,...args]=process.argv.slice(2);const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  if(command==='install'){fail(args[0]&&option('--dest'),'Usage: install <package.json> --dest <skills-directory>');console.log(JSON.stringify(install(readPackage(resolve(args[0])),option('--dest')),null,2));}
  else if(command==='pack'){fail(args[0]&&option('--out'),'Usage: pack <skill-directory> --out <package.json>');const value=pack(resolve(args[0]));writeFileSync(resolve(option('--out')),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});console.log(`Packed ${value.manifest.name} ${value.manifest.version}`);}
  else if(command==='publish'){fail(args[0],'Supply a package JSON file');const value=verifyPackage(readPackage(resolve(args[0])),{requireDigest:false});const result=await request('/api/community/skills',{schemaVersion:1,manifest:value.manifest,files:value.files.map(({sha256,bytes,...file})=>file)});console.log(JSON.stringify({name:result.skill.name,version:result.skill.version,digest:result.skill.digest},null,2));}
  else if(command==='search'){const result=await request(`/api/community/skills?${new URLSearchParams({q:args[0]??'',offset:option('--offset')??'0'})}`);console.log(JSON.stringify(result,null,2));}
  else if(command==='show'||command==='download'){fail(args[0]&&slug.test(args[0]),'Supply a skill name');const version=option('--version');const result=await request(`/api/community/skills/${args[0]}${command==='download'?'/download':''}${version?`?version=${encodeURIComponent(version)}`:''}`);
    if(command==='download'){fail(option('--out'),'Supply --out <file>');verifyPackage(result);writeFileSync(resolve(option('--out')),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(`Downloaded ${result.manifest.name} ${result.manifest.version}`);}else console.log(JSON.stringify(result,null,2));
  }else throw new Error('Commands: search <term> [--offset n], show <name>, pack <directory> --out <file>, publish <file>, download <name> [--version x.y.z] --out <file>, install <file> --dest <directory>');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
