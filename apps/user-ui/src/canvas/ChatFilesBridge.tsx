import {useEffect,type MutableRefObject} from 'react';
import {useComposerSessionContext} from '../chat/ChatComposer';

export type CanvasChatFiles={channelId:string;files:File[]}|null;

/**
 * Runs inside ComposerSessionProvider so App never re-renders on keystrokes. Files dropped on a canvas card wait
 * until that chat is the active one and its draft is loaded, then queue and send themselves. It also hands the
 * canvas the session's cancelRequestChanges.
 */
export function CanvasChatFilesBridge({chatFiles,clear,canvasChannelId,inCanvas,activeChannelId,canPost,archived,onError,cancelRef}:{
  chatFiles:CanvasChatFiles;clear():void;canvasChannelId:string|null;inCanvas:boolean;activeChannelId:string|null;canPost:boolean;archived:boolean;
  onError(message:string):void;cancelRef:MutableRefObject<(()=>void)|null>;
}){
  const session=useComposerSessionContext();
  cancelRef.current=session?.cancelRequestChanges??null;
  const ready=Boolean(session?.ready),sending=Boolean(session?.sending);
  useEffect(()=>{
    if(!chatFiles||!session)return;
    if(!inCanvas||canvasChannelId!==chatFiles.channelId){clear();return;}
    if(activeChannelId!==chatFiles.channelId||!ready||sending)return;
    clear();
    if(!canPost||archived){onError(archived?'Restore this conversation before attaching files.':'This conversation is read-only.');return;}
    session.uploadFiles(chatFiles.files,{autoSend:true});
  },[chatFiles,inCanvas,canvasChannelId,activeChannelId,ready,sending]);
  return null;
}
