import {z} from 'zod';
import {SelectedMentionSchema,MessageAttachmentSchema} from '@nest/schemas';

const schema=z.object({
  text:z.string().max(32000),mentions:SelectedMentionSchema.array().max(30),
  attachments:MessageAttachmentSchema.array().max(20),
  request:z.object({id:z.string().uuid(),fingerprint:z.string().max(100000)}).optional(),
  replyTo:z.object({eventId:z.string().min(1).max(200),author:z.string().max(200),excerpt:z.string().max(500)}).optional(),
});
export type ChatDraft=z.infer<typeof schema>;
const prefix=(owner:string)=>`nest:draft:${encodeURIComponent(owner)}:`;
const key=(owner:string,channel:string)=>prefix(owner)+encodeURIComponent(channel);
export const projectDraftKey=(owner:string)=>`nest:project-draft:${encodeURIComponent(owner)}`;
const recentKey=(owner:string)=>`nest:recent-project:${encodeURIComponent(owner)}`;
export function loadChatDraft(owner:string,channel:string):ChatDraft {
  try{const parsed=schema.safeParse(JSON.parse(localStorage.getItem(key(owner,channel))??'null'));if(parsed.success)return parsed.data;}catch{}
  return {text:'',mentions:[],attachments:[]};
}
export function saveChatDraft(owner:string,channel:string,value:ChatDraft) {
  try{
    if(!value.text&&!value.attachments.length&&!value.request)localStorage.removeItem(key(owner,channel));
    else localStorage.setItem(key(owner,channel),JSON.stringify(schema.parse(value)));
    return true;
  }catch{return false;}
}
export function clearSentDraft(owner:string,channel:string,expected:ChatDraft) {
  // A late send response must not remove a newer draft from another tab.
  try{if(JSON.stringify(loadChatDraft(owner,channel))===JSON.stringify(schema.parse(expected)))localStorage.removeItem(key(owner,channel));}catch{}
}
export function rememberProject(owner:string,project:string){try{localStorage.setItem(recentKey(owner),project);}catch{}}
export function recentProject(owner:string){try{return localStorage.getItem(recentKey(owner));}catch{return null;}}
export function clearOwnerDrafts(owner:string) {
  try{
    for(let i=localStorage.length-1;i>=0;i--){const name=localStorage.key(i);if(name?.startsWith(prefix(owner)))localStorage.removeItem(name);}
    localStorage.removeItem(projectDraftKey(owner));localStorage.removeItem(recentKey(owner));
  }catch{}
}
