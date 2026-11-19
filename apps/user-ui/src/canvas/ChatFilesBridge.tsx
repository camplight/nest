import {useEffect,type MutableRefObject} from 'react';
import {useComposerSessionContext} from '../chat/ChatComposer';

/** `autoSend`: a card drop sends itself; a drop on a chat window only attaches to that chat's message box. */
export type CanvasChatFiles={channelId:string;files:File[];autoSend:boolean}|null;

/** More files for the chat already waiting join it; the result sends itself only if every drop in it asked to. */
export const mergeChatFiles=(current:CanvasChatFiles,channelId:string,files:File[],autoSend:boolean):NonNullable<CanvasChatFiles>=>
  current?.channelId===channelId?{channelId,files:[...current.files,...files],autoSend:current.autoSend&&autoSend}:{channelId,files,autoSend};

/**
 * Runs inside ComposerSessionProvider so App never re-renders on keystrokes. Files dropped on a canvas card or chat window wait
 * until that chat is the active one and its draft is loaded, then queue (and, for a card, send themselves). It also hands the
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
    session.uploadFiles(chatFiles.files,{autoSend:chatFiles.autoSend});
  },[chatFiles,inCanvas,canvasChannelId,activeChannelId,ready,sending]);
  return null;
}
