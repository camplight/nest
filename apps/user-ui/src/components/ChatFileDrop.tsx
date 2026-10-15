import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import './chat-file-drop.css';

function carriesFiles(event:DragEvent){
  return !!event.dataTransfer&&(Array.from(event.dataTransfer.types).includes('Files')||Array.from(event.dataTransfer.items).some(item=>item.kind==='file'));
}

/** Mounted only on chat screens; the window target includes navigation and panels. */
export function ChatFileDrop({scope,onFiles,disabledReason}:{scope:string;onFiles:(files:File[])=>void;disabledReason?:string}){
  const latest=useRef({onFiles,disabledReason});latest.current={onFiles,disabledReason};
  const [dragging,setDragging]=useState(false),[notice,setNotice]=useState<string|null>(null);
  useEffect(()=>{
    let depth=0;setDragging(false);setNotice(null);
    const reset=()=>{depth=0;setDragging(false);};
    function enter(event:DragEvent){if(!carriesFiles(event))return;event.preventDefault();depth++;setDragging(true);}
    function over(event:DragEvent){if(!carriesFiles(event))return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect=latest.current.disabledReason?'none':'copy';setDragging(true);}
    function leave(event:DragEvent){if(!carriesFiles(event))return;depth=Math.max(0,depth-1);if(depth===0)reset();}
    function drop(event:DragEvent){
      if(!carriesFiles(event))return;
      event.preventDefault();event.stopPropagation();reset();
      if(latest.current.disabledReason){setNotice(latest.current.disabledReason);return;}
      const entries=Array.from(event.dataTransfer!.items).filter(item=>item.kind==='file');
      let folders=false;
      const files=entries.length?entries.flatMap(item=>{
        if(item.webkitGetAsEntry?.()?.isDirectory){folders=true;return [];}
        const file=item.getAsFile();return file?[file]:[];
      }):Array.from(event.dataTransfer!.files);
      setNotice(folders?'Folders can’t be attached directly. Drop individual files or a ZIP archive.':files.length?null:'These items could not be read as files. Try Attach files.');
      if(files.length)latest.current.onFiles(files);
    }
    function escape(event:KeyboardEvent){if(event.key==='Escape')reset();}
    window.addEventListener('dragenter',enter,true);window.addEventListener('dragover',over,true);window.addEventListener('dragleave',leave,true);window.addEventListener('drop',drop,true);
    window.addEventListener('dragend',reset);window.addEventListener('blur',reset);window.addEventListener('keydown',escape);
    return()=>{window.removeEventListener('dragenter',enter,true);window.removeEventListener('dragover',over,true);window.removeEventListener('dragleave',leave,true);window.removeEventListener('drop',drop,true);window.removeEventListener('dragend',reset);window.removeEventListener('blur',reset);window.removeEventListener('keydown',escape);};
  },[scope]);
  return createPortal(<>
    {dragging&&<div className={`chat-file-drop${disabledReason?' is-disabled':''}`} role="status"><div><span className="chat-file-drop-icon" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg></span><strong>{disabledReason||'Drop files to attach'}</strong>{!disabledReason&&<p>Drop anywhere on this screen. Send them when you’re ready.</p>}</div></div>}
    {notice&&<div className="chat-file-drop-notice" role="alert"><span>{notice}</span><button type="button" aria-label="Dismiss attachment notice" onClick={()=>setNotice(null)}>Dismiss</button></div>}
  </>,document.body);
}
