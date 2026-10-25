import {useEffect,useRef,useState} from 'react';
import {formatAttachmentSize,type PendingAttachment} from '../attachments';

/** Object URLs for image chips that still hold their File; revoked when the chip goes and on unmount. */
function useThumbnails(items:PendingAttachment[]){
  const owned=useRef(new Map<string,{file:File;url:string}>());
  const [urls,setUrls]=useState<Record<string,string>>({});
  useEffect(()=>{
    const map=owned.current;let changed=false;
    const live=new Map(items.filter(item=>item.file&&item.mime.startsWith('image/')).map(item=>[item.localId,item.file!]));
    for(const [id,entry] of map)if(live.get(id)!==entry.file){URL.revokeObjectURL(entry.url);map.delete(id);changed=true;}
    for(const [id,file] of live)if(!map.has(id)){map.set(id,{file,url:URL.createObjectURL(file)});changed=true;}
    if(changed)setUrls(Object.fromEntries([...map].map(([id,entry])=>[id,entry.url])));
  },[items]);
  useEffect(()=>()=>{for(const entry of owned.current.values())URL.revokeObjectURL(entry.url);owned.current.clear();},[]);
  return urls;
}

function FileIcon(){
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/></svg>;
}

export function ChatAttachments({items,error,disabled=false,onRemove}:{items:PendingAttachment[];error:string|null;disabled?:boolean;onRemove:(id:string)=>void}){
  const thumbnails=useThumbnails(items);
  const [broken,setBroken]=useState<Record<string,boolean>>({});
  return <>
    {error&&<p className="composer-attachment-error" role="alert">{error}</p>}
    {items.length>0&&<div className="composer-attachments" aria-label="Attached files">{items.map(item=>{
      const thumbnail=!broken[item.localId]?thumbnails[item.localId]:undefined;
      const percent=Math.round(Math.max(0,Math.min(1,item.progress??0))*100);
      return <article key={item.localId} className={`composer-attachment is-${item.status}`}>
        <span className="composer-attachment-preview" aria-hidden={thumbnail?undefined:true}>
          {thumbnail?<img src={thumbnail} alt="" onError={()=>setBroken(value=>({...value,[item.localId]:true}))}/>:<FileIcon/>}
        </span>
        <div><strong>{item.name}</strong><span role={item.status==='error'?'alert':undefined}>{item.status==='ready'?`Ready${formatAttachmentSize(item.size)?` • ${formatAttachmentSize(item.size)}`:''}`:item.status==='uploading'?'Uploading…':item.error||'Upload failed'}</span>
          {item.status==='uploading'&&<span className="composer-attachment-progress" role="progressbar" aria-label={`Uploading ${item.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{width:`${percent}%`}}/></span>}
        </div>
        <button type="button" className="composer-attachment-remove" disabled={disabled} aria-label={`Remove ${item.name}`} onClick={()=>onRemove(item.localId)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </article>;
    })}</div>}
  </>;
}
