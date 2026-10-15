import {useEffect,useRef,useState,type SetStateAction} from 'react';
import {MAX_MESSAGE_ATTACHMENTS,type SendMessage} from '@nest/schemas';
import {apiFetch,apiJson} from './api';

export type UploadedAttachment={localId:string;fileId:string;name:string;mime:string;size:number;sha256?:string};
export type PendingAttachment={localId:string;name:string;mime:string;size:number;status:'uploading'|'ready'|'error';uploaded?:UploadedAttachment;error?:string};
export function restoreAttachments(files:SendMessage['attachments']):PendingAttachment[]{
  return files.map(file=>({localId:file.fileId,name:file.name,mime:file.mime??'application/octet-stream',size:file.size??0,status:'ready',uploaded:{...file,localId:file.fileId,mime:file.mime??'application/octet-stream',size:file.size??0}}));
}
export function formatAttachmentSize(size?:number){
  if(typeof size!=='number'||!Number.isFinite(size)||size<=0)return null;
  if(size<1024)return `${size} B`;
  const kb=size/1024;if(kb<1024)return `${kb.toFixed(kb>=100?0:1)} KB`;
  const mb=kb/1024;return `${mb.toFixed(mb>=100?0:1)} MB`;
}

/** One upload path for picker, paste and drops; results stay in their original draft. */
export function useAttachments(scope:string,initial:PendingAttachment[]=[]){
  type State={scope:string;items:PendingAttachment[];error:string|null};
  const [state,setState]=useState<State>(()=>({scope,items:initial,error:null}));
  const current=state.scope===scope?state:{scope,items:initial,error:null};
  const latest=useRef(current);latest.current=current;
  const currentScope=useRef(scope);currentScope.current=scope;
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  function update(change:(value:State)=>State){
    if(!mounted.current||currentScope.current!==scope)return;
    const next=change(latest.current);latest.current=next;setState(next);
  }
  function setAttachments(change:SetStateAction<PendingAttachment[]>){
    update(value=>{const items=typeof change==='function'?change(value.items):change;return {...value,items,error:items.length?value.error:null};});
  }
  async function upload(file:File,localId:string){
    try{
      const body=new FormData();body.append('file',file,file.name);
      const response=await apiFetch('/api/files',{method:'POST',body});
      const payload=await response.json() as {id:string};
      const meta=await apiJson<{original_name?:string;mime?:string;size?:number;sha256?:string}>(`/api/files/${encodeURIComponent(payload.id)}/meta`);
      const uploaded:UploadedAttachment={localId,fileId:payload.id,name:meta.original_name||file.name||'upload',mime:meta.mime||file.type||'application/octet-stream',size:typeof meta.size==='number'?meta.size:file.size,...(meta.sha256?{sha256:meta.sha256}:{})};
      setAttachments(items=>items.map(item=>item.localId===localId?{...item,name:uploaded.name,mime:uploaded.mime,size:uploaded.size,status:'ready',uploaded,error:undefined}:item));
    }catch(reason){
      let error=reason instanceof Error?reason.message:'Upload failed';try{error=JSON.parse(error).error??error;}catch{}
      setAttachments(items=>items.map(item=>item.localId===localId?{...item,status:'error',error}:item));
    }
  }
  function uploadFiles(files:File[]){
    const accepted=files.slice(0,Math.max(0,MAX_MESSAGE_ATTACHMENTS-latest.current.items.length));
    const items=accepted.map(file=>({localId:crypto.randomUUID(),name:file.name||'upload',mime:file.type||'application/octet-stream',size:file.size,status:'uploading' as const}));
    update(value=>({...value,items:[...value.items,...items],error:files.length>accepted.length?`You can attach up to ${MAX_MESSAGE_ATTACHMENTS} files. ${files.length-accepted.length} ${files.length-accepted.length===1?'file was':'files were'} not added.`:null}));
    accepted.forEach((file,index)=>{void upload(file,items[index].localId);});
  }
  return {attachments:current.items,setAttachments,uploadFiles,error:current.error};
}
