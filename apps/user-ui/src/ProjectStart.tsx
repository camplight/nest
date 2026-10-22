import {useAttachments,restoreAttachments} from './attachments';
import {ChatAttachments} from './components/ChatAttachments';
import {ChatFileDrop} from './components/ChatFileDrop';
import {projectDraftKey} from './drafts';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {NewProjectSchema,SelectedMentionSchema,MessageAttachmentSchema,MAX_MESSAGE_ATTACHMENTS,type SendMessage,type Project,type SelectedMention,type ProjectMemberOption} from '@nest/schemas';
import {apiJson,getApiHeaders} from './api';
import {ProjectCreateForm} from './ProjectCreateForm';
import {useMentionPicker} from './components/useMentionPicker';
import {reconcileMentions} from './mentions';

type Draft={id:string;messageId:string;ownerId:string;text:string;mentions:SelectedMention[];submitted:boolean;attachments?:SendMessage['attachments'];metadata?:{name:string;description:string};channelId?:string;assistant?:string|null;assistantDismissed?:boolean};
const legacyStorageKey='nest-new-project-chat';
function readDraft(owner:string){try{const saved=localStorage.getItem(projectDraftKey(owner));if(saved)return saved;}catch{}try{return sessionStorage.getItem(legacyStorageKey);}catch{return null;}}
function writeDraft(owner:string,value:Draft){
  try{localStorage.setItem(projectDraftKey(owner),JSON.stringify(value));return true;}catch{try{sessionStorage.setItem(legacyStorageKey,JSON.stringify(value));}catch{}return false;}
}
export function projectMetadata(text:string,mentions:SelectedMention[]) {
  let plain=text;
  for(const mention of [...mentions].sort((a,b)=>b.start-a.start))if(text.slice(mention.start,mention.end)==='@'+mention.name)plain=plain.slice(0,mention.start)+plain.slice(mention.end);
  const lines=plain.trim().split(/\n+/).map(line=>line.replace(/^\s*[#>]+\s*/,'').trim()).filter(Boolean);
  const title=(lines[0]??'New project').replace(/\s+/g,' ');
  return {name:title.length>120?title.slice(0,117).trimEnd()+'…':title,description:lines.join('\n').slice(0,4000)};
}
function restore(ownerId:string):Draft {
  try{
    const saved=JSON.parse(readDraft(ownerId)??'null');
    if(saved?.ownerId===ownerId&&NewProjectSchema.shape.id.safeParse(saved.id).success&&NewProjectSchema.shape.id.safeParse(saved.messageId).success&&typeof saved.text==='string'&&saved.text.length<=32000){
      const mentions=SelectedMentionSchema.array().max(30).parse(saved.mentions);
      const metadata=saved.metadata?NewProjectSchema.pick({name:true,description:true}).parse(saved.metadata):undefined;
      const files=MessageAttachmentSchema.array().max(MAX_MESSAGE_ATTACHMENTS).safeParse(saved.attachments??[]);
      return {attachments:files.success?files.data:[],id:saved.id,messageId:saved.messageId,ownerId,text:saved.text,mentions,metadata,assistantDismissed:saved.assistantDismissed===true,assistant:typeof saved.assistant==='string'?saved.assistant:saved.assistant===null?null:undefined,channelId:typeof saved.channelId==='string'?saved.channelId:undefined,submitted:saved.submitted===true};
    }
  }catch{}
  return {id:crypto.randomUUID(),messageId:crypto.randomUUID(),ownerId,text:'',mentions:[],submitted:false};
}
function pendingLegacy(ownerId:string) {
  try{const saved=JSON.parse(sessionStorage.getItem('nest-new-project')??'null');return saved&&(!saved.ownerId||saved.ownerId===ownerId)&&(saved.submitted===true||!saved.ownerId)&&NewProjectSchema.shape.id.safeParse(saved.id).success;}catch{return false;}
}
function message(error:unknown){const text=error instanceof Error?error.message:'Could not start your project. Retry to finish.';try{return JSON.parse(text).error??text;}catch{return text;}}
export function ProjectStart(props:{ownerId:string;onCreated:(project:Project)=>void;onCancel:()=>void}) {
  const [legacy]=useState(()=>pendingLegacy(props.ownerId));
  return legacy?<><p className="notice">Finish your previous project setup before starting another.</p><ProjectCreateForm {...props}/></>:<StartChat {...props}/>;
}
function StartChat({ownerId,onCreated,onCancel}:{ownerId:string;onCreated:(project:Project)=>void;onCancel:()=>void}) {
  const [draft,setDraft]=useState(()=>restore(ownerId));
  const {attachments,setAttachments,uploadFiles,error:attachmentError}=useAttachments(ownerId+':'+draft.id,restoreAttachments(draft.attachments??[]));
  const readyFiles=attachments.flatMap(item=>item.uploaded&&item.status==='ready'?[{fileId:item.uploaded.fileId,name:item.uploaded.name,mime:item.uploaded.mime,size:item.uploaded.size}]:[]);
  const readyFingerprint=JSON.stringify(readyFiles);
  const uploading=attachments.some(item=>item.status==='uploading'),failed=attachments.some(item=>item.status==='error');
  const fileInputRef=useRef<HTMLInputElement>(null);
  const [stored,setStored]=useState(true);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [rosterReady,setRosterReady]=useState(false);
  const [roster,setRoster]=useState<ProjectMemberOption[]>([]),[rosterError,setRosterError]=useState(false),[refresh,setRefresh]=useState(0);
  const textareaRef=useRef<HTMLTextAreaElement>(null),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{setStored(writeDraft(ownerId,draft.submitted?draft:{...draft,attachments:readyFiles}));},[draft,ownerId,readyFingerprint]);
  useEffect(()=>{
    const controller=new AbortController();setRosterError(false);
    void apiJson<{members:ProjectMemberOption[];personalAgent:ProjectMemberOption|null}>('/api/projects/members',{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){setRoster(value.members);setDraft(current=>current.submitted||current.assistantDismissed||!!current.assistant?current:{...current,assistant:value.personalAgent?.subscriberId??null});}}).catch(()=>{if(!controller.signal.aborted)setRosterError(true);}).finally(()=>{if(!controller.signal.aborted)setRosterReady(true);});
    return()=>controller.abort();
  },[refresh]);
  const locked=busy||draft.submitted;
  const recipients=[...new Map(draft.mentions.map(mention=>[mention.kind+':'+mention.name,mention])).values()];
  const picker=useMentionPicker({value:draft.text,onChange:text=>setDraft(current=>({...current,text,mentions:reconcileMentions(current.text,text,current.mentions)})),onChoose:(text,mention)=>setDraft(current=>({...current,text,mentions:[...reconcileMentions(current.text,text,current.mentions),mention]})),textareaRef,candidates:roster.map(member=>({id:member.subscriberType+':'+member.subscriberId,name:member.subscriberId,kind:member.subscriberType==='AGENT'?'Agent':'Person',inConversation:false})),channelId:'new-project',disabled:locked,projectDraft:true});
  async function submit(event:FormEvent) {
    event.preventDefault();if(busy||uploading||failed||(!draft.text.trim()&&!readyFiles.length)||(!rosterReady&&!draft.submitted))return;
    setBusy(true);setError(null);
    const text=draft.text.trim()?draft.text:`Attached files for reference: ${readyFiles.map(file=>file.name).join(', ')}`;
    const next={...draft,text,attachments:draft.submitted?draft.attachments??[]:readyFiles,submitted:true,metadata:draft.metadata??projectMetadata(text,draft.mentions)};
    setDraft(next);setStored(writeDraft(ownerId,next));
    try{
      const members=recipients.map(mention=>({subscriberType:mention.kind,subscriberId:mention.name}));
      if(next.assistant&&!members.some(m=>m.subscriberType==='AGENT'&&m.subscriberId===next.assistant))members.push({subscriberType:'AGENT',subscriberId:next.assistant});
      const project=next.channelId?await apiJson<Project>(`/api/projects/${next.id}`):await apiJson<Project>('/api/projects',{method:'POST',headers:getApiHeaders(),body:JSON.stringify({id:next.id,...next.metadata,members,collaboration:'team'})});
      if(project.ownerId!==ownerId||(next.channelId&&project.channelId!==next.channelId))throw Error('Project access changed. Your message is saved.');
      const sending={...next,channelId:project.channelId};setDraft(sending);try{if(JSON.parse(readDraft(ownerId)??'null')?.id===next.id)setStored(writeDraft(ownerId,sending));}catch{}
      await apiJson('/api/messages',{method:'POST',headers:getApiHeaders(),body:JSON.stringify({id:next.messageId,channelId:project.channelId,text:next.text,mentions:next.mentions,attachments:next.attachments,...(next.assistant&&!recipients.some(m=>m.kind==='AGENT')?{targetAgentName:next.assistant}:{})})});
      try{if(JSON.parse(readDraft(ownerId)??'null')?.id===next.id){localStorage.removeItem(projectDraftKey(ownerId));sessionStorage.removeItem(legacyStorageKey);};}catch{}
      void apiJson(`/api/projects/${project.id}/suggest-details`,{method:'POST',headers:getApiHeaders(),body:JSON.stringify({messageRequestId:next.messageId,expected:{name:project.name,description:project.description}})}).catch(()=>{});
      if(mounted.current)onCreated(project);
    }catch(reason){if(mounted.current)setError(message(reason));}finally{if(mounted.current)setBusy(false);}
  }
  return <section className="project-start-chat" aria-label="Start a project in chat">
    <ChatFileDrop scope={ownerId+':'+draft.id} disabledReason={locked?'Finish sending this project before attaching more files.':undefined} onFiles={files=>{if(!locked)uploadFiles(files);}}/>
    <div className="project-start-intro"><h2>What are we working on?</h2><p>Send a message to start your project. We’ll suggest a name and description with AI in the background. You can change them later.</p></div>
    <form className="dashboard-card project-start-composer" onSubmit={submit}>
      {!stored&&<p role="status">Draft storage is unavailable. Keep this tab open until you send.</p>}
      {rosterError&&<p role="alert">We couldn’t load your team. You can still start on your own. <button type="button" className="project-inline-action" disabled={locked} onClick={()=>setRefresh(n=>n+1)}>Try again</button></p>}
      <input className="composer-file-input" ref={fileInputRef} type="file" multiple disabled={locked} onChange={event=>{if(!locked)uploadFiles(Array.from(event.currentTarget.files??[]));event.currentTarget.value='';}}/>
      <ChatAttachments items={attachments} error={attachmentError} disabled={locked} onRemove={id=>setAttachments(items=>items.filter(item=>item.localId!==id))}/>
      {failed&&<p role="alert">Remove failed uploads before sending. You can attach them again to retry.</p>}
      <div className="mention-input">{picker.popup}<textarea ref={textareaRef} {...picker.textareaProps} aria-label="Message" placeholder="Tell us what you want to work on. Type @ to bring someone in." value={draft.text} autoFocus maxLength={32000} rows={4} disabled={locked} onChange={event=>{const text=event.target.value;setDraft(current=>({...current,text,mentions:reconcileMentions(current.text,text,current.mentions)}));picker.sync(event.target);}} onKeyDown={event=>{if(picker.onKeyDown(event))return;if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.keyCode!==229){event.preventDefault();event.currentTarget.form?.requestSubmit();}}}/></div>
      {draft.assistant&&<div className="project-start-assistant"><span><strong>{draft.assistant}</strong> will join and help you get started.</span><button type="button" className="project-inline-action" disabled={locked} onClick={()=>setDraft(current=>({...current,assistant:null,assistantDismissed:true}))}>Start without my agent</button><small>Your agent can use its granted apps here, including when you are absent. Other participants may request actions and see results.</small></div>}
      {recipients.length>0&&<p className="project-start-recipients">Joining: {recipients.map(m=>m.name).join(', ')}</p>}
      {error&&<div className="notice error" role="alert">{error}<p>Your message is saved. Retry unchanged to finish this project.</p></div>}
      <div className="project-start-footer"><span>Type @ to add people or agents.</span><div><button type="button" className="dashboard-action" disabled={locked} onClick={()=>fileInputRef.current?.click()}>Attach files</button><button type="button" className="dashboard-action" disabled={busy} onClick={onCancel}>Cancel</button><button className="dashboard-action project-primary" disabled={busy||uploading||failed||(!draft.text.trim()&&!readyFiles.length)||(!rosterReady&&!draft.submitted)}>{busy?'Starting…':draft.submitted?'Retry send':'Send'}</button></div></div>
    </form>
  </section>;
}
