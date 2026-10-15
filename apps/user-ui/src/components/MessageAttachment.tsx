import {useState} from 'react';
import {formatAttachmentSize} from '../attachments';

const previewTypes=new Set(['image/png','image/jpeg','image/gif','image/webp']);
export function MessageAttachment({attachment}:{attachment:{fileId:string;name:string;mime?:string;size?:number}}) {
  const [failed,setFailed]=useState(false);
  const url=`/api/files/${encodeURIComponent(attachment.fileId)}`;
  const size=formatAttachmentSize(attachment.size);
  return <li className="message-attachment">
    {previewTypes.has(attachment.mime??'')&&!failed&&<a className="message-image-link" href={url} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.name}`}>
      <img src={url} alt={attachment.name} loading="lazy" onError={()=>setFailed(true)}/>
    </a>}
    <a href={url} target="_blank" rel="noreferrer">{attachment.name}</a>
    {(attachment.mime||size)&&<span>{[attachment.mime,size].filter(Boolean).join(' • ')}</span>}
    {failed&&<span>Preview unavailable. Open the file using the link above.</span>}
  </li>;
}
