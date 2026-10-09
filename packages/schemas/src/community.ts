import {z} from 'zod';
export const CommunityName=z.string().min(1).max(63).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const CommunityManifest=z.object({
  name:CommunityName,title:z.string().trim().min(1).max(100),description:z.string().trim().min(10).max(500),
  version:z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/).max(30),category:z.enum(['skill','automation','use-case']),
  license:z.enum(['MIT','Apache-2.0','CC-BY-4.0','Proprietary']),tags:z.array(z.string().min(1).max(30).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).max(8),
  runtimes:z.array(z.enum(['generic','codex','orgops'])).min(1).max(3),
}).strict();
export const CommunityFileSchema=z.object({
  path:z.string().min(1).max(200).regex(/^[a-zA-Z0-9_./-]+$/).refine(p=>!p.startsWith('/')&&!p.split('/').some(part=>!part||part.startsWith('.'))).refine(p=>p==='SKILL.md'||p==='event-shapes.ts'||p==='event-shapes.js'||/^(scripts|references|assets|agents)\//.test(p),'Use SKILL.md or a supported resource directory'),
  content:z.string().max(180000),encoding:z.enum(['utf8','base64']).default('utf8'),executable:z.boolean().default(false),
}).strict();
export const CommunitySubmission=z.object({schemaVersion:z.literal(1),manifest:CommunityManifest,files:z.array(CommunityFileSchema).min(1).max(64)}).strict()
  .refine(s=>s.files.some(f=>f.path==='SKILL.md'&&f.encoding==='utf8'),'SKILL.md in UTF-8 is required')
  .refine(s=>new Set(s.files.map(f=>f.path.toLowerCase())).size===s.files.length,'File paths must be unique, including case');
export type CommunityPackage=z.infer<typeof CommunitySubmission>;
export type CommunityFile=z.infer<typeof CommunityFileSchema>&{bytes:number;sha256:string};
export type CommunitySkill=z.infer<typeof CommunityManifest>&{author:{kind:'human'|'agent';name:string};ownerId:string;digest:string;createdAt:number;updatedAt:number;versionCount:number;fileCount:number;canPublish:boolean};
export type CommunityCatalog={skills:CommunitySkill[];total:number;offset:number;limit:number};
export type CommunityDetail={skill:CommunitySkill;files:CommunityFile[];versions:{version:string;createdAt:number;digest:string}[]};
export type CommunityToken={id:string;agentName:string;createdAt:number;expiresAt:number;revokedAt:number|null};
