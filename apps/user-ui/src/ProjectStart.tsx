import {useAttachments,restoreAttachments} from './attachments';
import {ChatAttachments} from './components/ChatAttachments';
import {ChatFileDrop} from './components/ChatFileDrop';
import {projectDraftKey} from './drafts';
import {useEffect,useMemo,useRef,useState,type ChangeEvent,type FormEvent,type KeyboardEvent} from 'react';
import {NewProjectSchema,SelectedMentionSchema,MessageAttachmentSchema,MAX_MESSAGE_ATTACHMENTS,type SendMessage,type Project,ruleText,type SelectedMention,type ProjectMemberOption} from '@nest/schemas';
import {apiJson,getApiHeaders} from './api';
import {browserZone,ruleKey,typedSchedule,type TypedSchedule} from './dock-schedule';
import {ProjectCreateForm} from './ProjectCreateForm';
import {useMentionPicker} from './components/useMentionPicker';
import {reconcileMentions} from './mentions';
import {useVoiceNote} from './voice/useVoiceNote';
import {voiceCapError} from './voice/voice-note';
import {VoiceButton,VoiceStatus} from './voice/VoiceButton';

type Draft={id:string;messageId:string;ownerId:string;text:string;mentions:SelectedMention[];submitted:boolean;attachments?:SendMessage['attachments'];metadata?:{name:string;description:string};channelId?:string;assistant?:string|null;assistantDismissed?:boolean;scheduleDismissed?:string};
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
      return {attachments:files.success?files.data:[],id:saved.id,messageId:saved.messageId,ownerId,text:saved.text,mentions,metadata,assistantDismissed:saved.assistantDismissed===true,scheduleDismissed:typeof saved.scheduleDismissed==='string'?saved.scheduleDismissed.slice(0,200):undefined,assistant:typeof saved.assistant==='string'?saved.assistant:saved.assistant===null?null:undefined,channelId:typeof saved.channelId==='string'?saved.channelId:undefined,submitted:saved.submitted===true};
    }
  }catch{}
  return {id:crypto.randomUUID(),messageId:crypto.randomUUID(),ownerId,text:'',mentions:[],submitted:false};
}
function pendingLegacy(ownerId:string) {
  try{const saved=JSON.parse(sessionStorage.getItem('nest-new-project')??'null');return saved&&(!saved.ownerId||saved.ownerId===ownerId)&&(saved.submitted===true||!saved.ownerId)&&NewProjectSchema.shape.id.safeParse(saved.id).success;}catch{return false;}
}
function message(error:unknown){const text=error instanceof Error?error.message:'Could not start your project. Retry to finish.';try{return JSON.parse(text).error??text;}catch{return text;}}
export function ProjectStart(props:{ownerId:string;onCreated:(project:Project)=>void;onCancel:()=>void;voice?:boolean}) {
  const [legacy]=useState(()=>pendingLegacy(props.ownerId));
  return legacy?<><p className="notice">Finish your previous project setup before starting another.</p><ProjectCreateForm {...props}/></>:<StartChat {...props}/>;
}
/**
 * Chat-first project creation. `page` is the Projects page composer. `dock` is the canvas bottom box: one row
 * with no intro or Cancel. It shares the page's draft, and its parent decides what happens after `onCreated`.
 * `fileDrop={false}` leaves window-wide file drops to another target, such as a chat open on the canvas.
 * `fileDropOverlay={false}` hides the drop overlay (the canvas shows its own hint); `onFilesDropped` hears of each accepted drop.
 * `voice` shows voice notes (Phase 2, canvas flag); without it there is no mic.
 * `schedules` (dock, flows on) shows a chip for a repeating rule typed in the message, such as `every Monday at 9 …`;
 * after a successful send `onCreated` gets it as `typed.schedule` for the canvas to save. ✕ drops it until the text
 * asks for a different rule.
 */
export function StartChat({ownerId,onCreated,onCancel,variant='page',fileDrop=true,fileDropAccept,fileDropOverlay=true,onFilesDropped,voice:voiceOn=false,schedules=false}:{ownerId:string;onCreated:(project:Project,typed?:{schedule?:TypedSchedule})=>void;onCancel?:()=>void;variant?:'page'|'dock';fileDrop?:boolean;fileDropAccept?:(target:EventTarget|null)=>boolean;fileDropOverlay?:boolean;onFilesDropped?:(count:number)=>void;voice?:boolean;schedules?:boolean}) {
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
  const attachmentsRef=useRef(attachments);attachmentsRef.current=attachments;
  const locked=busy||draft.submitted;
  // The transcript is appended to the text like typed words; the audio joins the attached files.
  const voice=useVoiceNote({
    onTranscript:text=>setDraft(current=>{const next=current.text+(current.text?'\n\n':'')+text;return {...current,text:next,mentions:reconcileMentions(current.text,next,current.mentions)};}),
    attachRoom:()=>attachmentsRef.current.length>=MAX_MESSAGE_ATTACHMENTS?{ok:false,error:voiceCapError(MAX_MESSAGE_ATTACHMENTS)}:{ok:true},
    onDiscard:fileId=>setAttachments(items=>items.filter(item=>item.localId!==fileId)),
    onAudio:audio=>setAttachments(items=>[...items,{localId:audio.fileId,name:audio.name,mime:audio.mime,size:audio.size,status:'ready',uploaded:{...audio,localId:audio.fileId}}])
  });
  const scheduling=schedules&&variant==='dock';
  const typed=useMemo(()=>scheduling?typedSchedule({text:draft.text,mentions:draft.mentions,assistant:draft.assistant,now:Date.now(),tz:browserZone()}):null,[scheduling,draft.text,draft.mentions,draft.assistant]);
  const typedKey=typed?ruleKey(typed.rule):null,typedRule=typedKey!==null&&typedKey!==draft.scheduleDismissed?typed:null;
  // ✕ holds only while the text asks for that same rule: once it reads as another rule, or none, the chip can come back.
  useEffect(()=>{if(scheduling&&draft.scheduleDismissed&&typedKey!==draft.scheduleDismissed&&!draft.submitted)setDraft(current=>({...current,scheduleDismissed:undefined}));},[scheduling,typedKey,draft.scheduleDismissed,draft.submitted]);
  const recipients=[...new Map(draft.mentions.map(mention=>[mention.kind+':'+mention.name,mention])).values()];
  const picker=useMentionPicker({value:draft.text,onChange:text=>setDraft(current=>({...current,text,mentions:reconcileMentions(current.text,text,current.mentions)})),onChoose:(text,mention)=>setDraft(current=>({...current,text,mentions:[...reconcileMentions(current.text,text,current.mentions),mention]})),textareaRef,candidates:roster.map(member=>({id:member.subscriberType+':'+member.subscriberId,name:member.subscriberId,kind:member.subscriberType==='AGENT'?'Agent':'Person',inConversation:false})),channelId:'new-project',disabled:locked,projectDraft:true,variant:variant==='dock'?'chat':'default'});
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
      // A typed repeat is saved by the canvas only now, once the chat exists and the message is in it.
      const schedule=scheduling?typedSchedule({text:next.text,mentions:next.mentions,assistant:next.assistant,dismissed:next.scheduleDismissed,now:Date.now(),tz:browserZone()})??undefined:undefined;
      if(mounted.current)onCreated(project,schedule?{schedule}:undefined);
    }catch(reason){if(mounted.current)setError(message(reason));}finally{if(mounted.current)setBusy(false);}
  }
  const canSend=!busy&&!uploading&&!failed&&(!!draft.text.trim()||readyFiles.length>0)&&(rosterReady||draft.submitted);
  const fileInput=<input className="composer-file-input" ref={fileInputRef} type="file" multiple disabled={locked} onChange={event=>{if(!locked)uploadFiles(Array.from(event.currentTarget.files??[]));event.currentTarget.value='';}}/>;
  const notices=<>
    {!stored&&<p role="status">Draft storage is unavailable. Keep this tab open until you send.</p>}
    {rosterError&&<p role="alert">We couldn’t load your team. You can still start on your own. <button type="button" className="project-inline-action" disabled={locked} onClick={()=>setRefresh(n=>n+1)}>Try again</button></p>}
    {voiceOn&&<VoiceStatus voice={voice}/>}
    <ChatAttachments items={attachments} error={attachmentError} disabled={locked} onRemove={id=>setAttachments(items=>items.filter(item=>item.localId!==id))}/>
    {failed&&<p role="alert">Remove failed uploads before sending. You can attach them again to retry.</p>}
  </>;
  const onTextChange=(event:ChangeEvent<HTMLTextAreaElement>)=>{const text=event.target.value;setDraft(current=>({...current,text,mentions:reconcileMentions(current.text,text,current.mentions)}));picker.sync(event.target);};
  const onTextKey=(event:KeyboardEvent<HTMLTextAreaElement>)=>{if(picker.onKeyDown(event))return;if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.keyCode!==229){event.preventDefault();event.currentTarget.form?.requestSubmit();}};
  const errorNotice=error&&<div className="notice error" role="alert">{error}<p>Your message is saved. Retry unchanged to finish this project.</p></div>;
  const dropFiles=<ChatFileDrop scope={ownerId+':'+draft.id} enabled={fileDrop} accept={fileDropAccept} overlay={fileDropOverlay} disabledReason={locked?'Finish sending this project before attaching more files.':undefined} onFiles={files=>{if(locked)return;uploadFiles(files);textareaRef.current?.focus({preventScroll:true});onFilesDropped?.(files.length);}}/>;
  const dismissSchedule=()=>{if(!typedRule)return;const dismissed=ruleKey(typedRule.rule);setDraft(current=>({...current,scheduleDismissed:dismissed}));textareaRef.current?.focus({preventScroll:true});};
  // The mock's `.pchip.sch2`, first among the box's chips. A status region reads the rule out as it appears or changes.
  const scheduleChip=scheduling&&<>
    <span className="canvas-visually-hidden" role="status">{typedRule?`Will repeat: ${ruleText(typedRule.rule)}`:''}</span>
    {typedRule&&<span className="project-start-dock-chips"><span className="pchip sch2" title="Will repeat. You can change it in the chat.">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>
      <span>{ruleText(typedRule.rule)}</span>
      <button type="button" aria-label="Don't repeat" disabled={locked} onClick={dismissSchedule}>✕</button>
    </span></span>}
  </>;
  if(variant==='dock')return <section className="project-start-dock" aria-label="Start a chat">
    {dropFiles}
    <form className="project-start-dock-form" onSubmit={submit}>
      {notices}
      {errorNotice}
      {draft.assistant&&<div className="project-start-assistant is-compact"><span><strong>{draft.assistant}</strong> will join and help you get started.</span><button type="button" className="project-inline-action" disabled={locked} onClick={()=>setDraft(current=>({...current,assistant:null,assistantDismissed:true}))}>Start without my agent</button>{draft.text.trim()&&<small>Your agent can use its granted apps here, including when you are absent. Other participants may request actions and see results.</small>}</div>}
      {recipients.length>0&&<p className="project-start-recipients">Joining: {recipients.map(m=>m.name).join(', ')}</p>}
      {fileInput}
      <div className="project-start-dock-row">
        <button type="button" className="project-start-dock-attach" aria-label="Attach files" title="Attach files" disabled={locked} onClick={()=>fileInputRef.current?.click()}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/></svg></button>
        {voiceOn&&<VoiceButton voice={voice} variant="dock" disabled={locked}/>}
        {scheduleChip}
        <div className="mention-input">{picker.popup}<textarea ref={textareaRef} {...picker.textareaProps} aria-label="Message" placeholder="Start a new chat. Type @ to bring someone in." value={draft.text} maxLength={32000} rows={1} disabled={locked} onChange={onTextChange} onKeyDown={onTextKey}/></div>
        <button className="canvas-button project-start-dock-send" disabled={!canSend}>{busy?'Starting…':draft.submitted?'Retry send':'Send'}</button>
      </div>
    </form>
  </section>;
  return <section className="project-start-chat" aria-label="Start a project in chat">
    {dropFiles}
    <div className="project-start-intro"><h2>What are we working on?</h2><p>Send a message to start your project. We’ll suggest a name and description with AI in the background. You can change them later.</p></div>
    <form className="dashboard-card project-start-composer" onSubmit={submit}>
      {fileInput}
      {notices}
      <div className="mention-input">{picker.popup}<textarea ref={textareaRef} {...picker.textareaProps} aria-label="Message" placeholder="Tell us what you want to work on. Type @ to bring someone in." value={draft.text} autoFocus maxLength={32000} rows={4} disabled={locked} onChange={onTextChange} onKeyDown={onTextKey}/></div>
      {draft.assistant&&<div className="project-start-assistant"><span><strong>{draft.assistant}</strong> will join and help you get started.</span><button type="button" className="project-inline-action" disabled={locked} onClick={()=>setDraft(current=>({...current,assistant:null,assistantDismissed:true}))}>Start without my agent</button><small>Your agent can use its granted apps here, including when you are absent. Other participants may request actions and see results.</small></div>}
      {recipients.length>0&&<p className="project-start-recipients">Joining: {recipients.map(m=>m.name).join(', ')}</p>}
      {errorNotice}
      <div className="project-start-footer"><span>Type @ to add people or agents.</span><div><button type="button" className="dashboard-action" disabled={locked} onClick={()=>fileInputRef.current?.click()}>Attach files</button>{voiceOn&&<VoiceButton voice={voice} variant="page" disabled={locked}/>}{onCancel&&<button type="button" className="dashboard-action" disabled={busy} onClick={onCancel}>Cancel</button>}<button className="dashboard-action project-primary" disabled={!canSend}>{busy?'Starting…':draft.submitted?'Retry send':'Send'}</button></div></div>
    </form>
  </section>;
}
