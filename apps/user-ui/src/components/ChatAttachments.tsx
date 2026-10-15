import {formatAttachmentSize,type PendingAttachment} from '../attachments';

export function ChatAttachments({items,error,disabled=false,onRemove}:{items:PendingAttachment[];error:string|null;disabled?:boolean;onRemove:(id:string)=>void}){
  return <>
    {error&&<p className="composer-attachment-error" role="alert">{error}</p>}
    {items.length>0&&<div className="composer-attachments" aria-label="Attached files">{items.map(item=><article key={item.localId}>
      <div><strong>{item.name}</strong><span role={item.status==='error'?'alert':undefined}>{item.status==='ready'?`Ready${formatAttachmentSize(item.size)?` • ${formatAttachmentSize(item.size)}`:''}`:item.status==='uploading'?'Uploading…':item.error||'Upload failed'}</span></div>
      <button type="button" className="composer-attachment-remove" disabled={disabled} aria-label={`Remove ${item.name}`} onClick={()=>onRemove(item.localId)}>Remove</button>
    </article>)}</div>}
  </>;
}
