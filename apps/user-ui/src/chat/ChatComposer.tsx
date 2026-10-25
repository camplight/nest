// The Nest composer (spec 6.8 to 6.12, 7.4), moved out of App.tsx unchanged in behaviour: drafts, the idempotent
// send path, uploads and the mention picker. Both chats render it; App.tsx drives it through ChatComposerHandle.
import {
  forwardRef,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import type {SelectedMention} from '@nest/schemas';
import {useAttachments,restoreAttachments,type UploadedAttachment} from '../attachments';
import {ChatAttachments} from '../components/ChatAttachments';
import {useMentionPicker} from "../components/useMentionPicker";
import {loadChatDraft,saveChatDraft,clearSentDraft,type ChatDraft} from '../drafts';
import {reconcileMentions,type MentionCandidate} from "../mentions";
import {CornerUpLeftIcon,XIcon} from 'lucide-react';
import {apiFetch,getApiHeaders} from "../api";
import type {Channel} from "../types";
import {quoteMarkdown,replyExcerpt} from './quote';
import type {ReplyTarget} from './quote-types';
import type {CommandContext} from './commands';

export type ChatComposerHandle={insertText(text:string):void;enqueueFiles(files:File[]):void;setReplyTarget(target:ReplyTarget|null,quotedText?:string):void;focus():void};
export type ComposerSessionOptions={
  userId:string|null;channel:Channel|null;canPost:boolean;
  // onSent may return a promise; the send stays in progress until it settles (the classic post-send refresh).
  onStateChange(state:{sending:boolean}):void;onSent():void|Promise<void>;onError(message:string):void;
  // The mention picker lives here too, so an invite in flight survives the remount like a send does.
  mentionCandidates:MentionCandidate[];canInvite:boolean;
  onInvite(candidate:MentionCandidate):Promise<void>;onAskAssistant(name:string,brief:string):void;
};
// The quote block quoteMarkdown put at the top of the text, while it still opens the text.
function stripQuote(text:string,author:string):string{
  const head=`> **${author}** wrote:\n`;
  if(!text.startsWith(head))return text;
  const match=/^(?:>[^\n]*\n)*\n?/.exec(text.slice(head.length));
  return text.slice(head.length+(match?.[0].length??0));
}
export type ComposerSession=ReturnType<typeof useComposerSession>;
export type ChatComposerProps={
  session:ComposerSession;conversationName:string;isConversationEmpty:boolean;
  // inProject, openInvite and openFiles reach the picker's slash commands through session.bindCommands. mentionCandidates,
  // canInvite, onInvite and onAskAssistant drive the picker through the session (ComposerSessionOptions); the form does not read them.
  inProject:boolean;mentionCandidates:MentionCandidate[];canInvite:boolean;
  onInvite(candidate:MentionCandidate):Promise<void>;onAskAssistant(name:string,brief:string):void;
  openInvite():void;openFiles():void;
};

/**
 * The composer's state: draft, send request, `sending`, uploads and the mention picker (with its in-flight invite). The caller holds it above any view that
 * unmounts the form (a project's Files tab), so a send or upload in flight survives the remount, as it did in App.tsx.
 */
export function useComposerSession(options:ComposerSessionOptions){
  const {userId,channel:activeChannel,canPost:activeChannelCanPost}=options;
  const activeChannelId=activeChannel?.id??null;
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeChannelIdRef = useRef<string | null>(null);
  const [draftState,setDraftState]=useState<{text:string;mentions:SelectedMention[]}>({text:'',mentions:[]});
  const [draftScope,setDraftScope]=useState<{owner:string;channel:string}|null>(null);
  const [draftStored,setDraftStored]=useState(true);
  const draft=draftState.text;
  function setDraft(text:string){setDraftState(current=>({text,mentions:reconcileMentions(current.text,text,current.mentions)}));}
  function chooseMention(text:string,mention:SelectedMention){setDraftState(current=>({text,mentions:[...reconcileMentions(current.text,text,current.mentions),mention]}));}
  // The quote-reply target (spec 7.3): stored with the draft, sent as replyTo and part of the send fingerprint.
  const [replyTo,setReplyTo]=useState<ReplyTarget|null>(null);
  const sendRequestRef=useRef<{fingerprint:string;id:string}|null>(null);
  const [sending, setSendingState] = useState(false);
  function setSending(value:boolean){setSendingState(value);options.onStateChange({sending:value});}
  const {attachments:pendingAttachments,setAttachments:setPendingAttachments,uploadFiles:enqueueFiles,error:attachmentError}=useAttachments(`${userId??''}:${activeChannelId??''}`);
  const uploadingAttachmentCount = pendingAttachments.filter((item) => item.status === "uploading").length;
  const readyAttachments = pendingAttachments
    .filter((item) => item.status === "ready" && item.uploaded)
    .map((item) => item.uploaded as UploadedAttachment);
  const hasAttachmentErrors = pendingAttachments.some((item) => item.status === "error");
  const disabled=!activeChannel || Boolean(activeChannel.archivedAt) || !activeChannelCanPost || sending;
  // Slash commands (spec 7.4.2): canInvite comes with the session options, the rest from the mounted form (bindCommands).
  const [commandsInProject,setCommandsInProject]=useState(false);
  const commandsInProjectRef=useRef(false);
  const commandActions=useRef({openInvite(){},openFiles(){}});
  const commands:CommandContext={canInvite:options.canInvite,inProject:commandsInProject,openInvite:()=>commandActions.current.openInvite(),openFiles:()=>commandActions.current.openFiles()};
  // The form binds on every commit. Set state only on a change: an unconditional setState in that layout effect re-renders
  // synchronously while other updates are pending, and during the next chat's first loads it hit React's nested-update limit.
  function bindCommands(source:{inProject:boolean;openInvite():void;openFiles():void}){
    commandActions.current={openInvite:source.openInvite,openFiles:source.openFiles};
    if(commandsInProjectRef.current!==source.inProject){commandsInProjectRef.current=source.inProject;setCommandsInProject(source.inProject);}
  }
  const mentions = useMentionPicker({value:draft, onChange:setDraft, onChoose:chooseMention, onAskAssistant:options.onAskAssistant, targeted:true, onInvite:options.canInvite?options.onInvite:undefined, textareaRef:composerTextareaRef, candidates:options.mentionCandidates, channelId:activeChannelId, disabled, variant:'chat', commands});

  useEffect(() => {
    activeChannelIdRef.current = activeChannelId;
    const saved=userId&&activeChannelId?loadChatDraft(userId,activeChannelId):null;
    setPendingAttachments(restoreAttachments(saved?.attachments??[]));
    setDraftState(saved?{text:saved.text,mentions:saved.mentions}:{text:'',mentions:[]});sendRequestRef.current=saved?.request??null;
    setReplyTo(saved?.replyTo??null);
    setDraftScope(userId&&activeChannelId?{owner:userId,channel:activeChannelId}:null);
  }, [activeChannelId,userId]);

  useEffect(()=>{
    if(!userId||!activeChannelId||draftScope?.owner!==userId||draftScope.channel!==activeChannelId)return;
    setDraftStored(saveChatDraft(userId,activeChannelId,{...draftState,attachments:readyAttachments.map(({fileId,name,mime,size})=>({fileId,name,mime,size})),...(sendRequestRef.current?{request:sendRequestRef.current}:{}),...(replyTo?{replyTo}:{})}));
  },[draftState,replyTo,pendingAttachments,draftScope,userId,activeChannelId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeChannelId || activeChannel?.archivedAt || !activeChannelCanPost) return;
    if (uploadingAttachmentCount > 0 || hasAttachmentErrors || mentions.inviting || sending) return;
    const trimmedText = draft.trim();
    if (!trimmedText && readyAttachments.length === 0) return;

    setSending(true);
    try {
      const effectiveText =
        trimmedText ||
        `Attached ${readyAttachments.length} file${readyAttachments.length === 1 ? "" : "s"} for reference.`;
      const leading=draft.length-draft.trimStart().length;
      const selected=draftState.mentions.map(m=>({...m,start:m.start-leading,end:m.end-leading}));
      const message={channelId:activeChannelId,text:effectiveText,mentions:selected,attachments:readyAttachments.map(({fileId,name,mime,size})=>({fileId,name,mime,size})),...(replyTo?{replyTo:replyTo.eventId}:{})};
      const fingerprint=JSON.stringify(message);
      if(sendRequestRef.current?.fingerprint!==fingerprint)sendRequestRef.current={fingerprint,id:crypto.randomUUID()};
      const request=sendRequestRef.current;
      const saved:ChatDraft={...draftState,attachments:message.attachments,request,...(replyTo?{replyTo}:{})};
      if(userId)setDraftStored(saveChatDraft(userId,activeChannelId,saved));
      await apiFetch('/api/messages',{method:'POST',headers:getApiHeaders(),body:JSON.stringify({id:request.id,...message})});
      if(userId)clearSentDraft(userId,activeChannelId,saved);
      if(activeChannelIdRef.current!==activeChannelId)return;
      if(activeChannelIdRef.current===activeChannelId){
        if(sendRequestRef.current?.id===request.id)sendRequestRef.current=null;
        setDraftState({text:'',mentions:[]});setPendingAttachments([]);setReplyTo(null);
      }
      await options.onSent();
      window.requestAnimationFrame(() => {
        composerTextareaRef.current?.scrollIntoView({ block: "nearest" });
      });
    } catch (sendError) {
      options.onError(sendError instanceof Error ? sendError.message : "Unable to send message");
    } finally {
      setSending(false);
    }
  }

  function uploadFiles(files: File[]) {
    if(!activeChannel || activeChannel.archivedAt || !activeChannelCanPost || sending)return;
    enqueueFiles(files);
  }

  // Appended after a blank line when the draft has text (the demo panel's "Request changes").
  function insertText(text:string){setDraftState(current=>{const next=current.text+(current.text?'\n\n':'')+text;return {text:next,mentions:reconcileMentions(current.text,next,current.mentions)};});}

  // Quote-reply (spec 7.3): the quote goes on top of the text, replacing an earlier one; null cancels and removes the
  // inserted quote while it is still there. The excerpt is cut before it is stored; the reply never adds a mention.
  function setReplyTarget(target:ReplyTarget|null,quotedText?:string){
    setDraftState(current=>{
      let next=replyTo?stripQuote(current.text,replyTo.author):current.text;
      if(target)next=quoteMarkdown(target.author,quotedText??target.excerpt)+next;
      return {text:next,mentions:reconcileMentions(current.text,next,current.mentions)};
    });
    setReplyTo(target?{eventId:target.eventId,author:target.author,excerpt:replyExcerpt(target.excerpt)}:null);
    if(target)window.requestAnimationFrame(()=>{const area=composerTextareaRef.current;area?.setSelectionRange(area.value.length,area.value.length);});
  }

  return {
    channel:activeChannel,channelId:activeChannelId,canPost:activeChannelCanPost,composerTextareaRef,
    draft,draftState,draftStored,setDraft,chooseMention,sending,disabled,mentions,
    pendingAttachments,setPendingAttachments,attachmentError,uploadingAttachmentCount,readyAttachments,hasAttachmentErrors,
    handleSubmit,uploadFiles,insertText,bindCommands,replyTo,setReplyTarget,
  };
}

export const ChatComposer=forwardRef<ChatComposerHandle,ChatComposerProps>(function ChatComposer(props,ref){
  const {session,conversationName:activeConversationName,isConversationEmpty}=props;
  const {channel:activeChannel,channelId:activeChannelId,canPost:activeChannelCanPost,composerTextareaRef,draft,draftState,draftStored,setDraft,sending,
    pendingAttachments,setPendingAttachments,attachmentError,uploadingAttachmentCount,readyAttachments,hasAttachmentErrors,uploadFiles,mentions}=session;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(()=>{session.bindCommands({inProject:props.inProject,openInvite:props.openInvite,openFiles:props.openFiles});});
  const draftRecipients=[...new Map(draftState.mentions.map(m=>[m.kind+':'+m.name,m])).values()];

  function handlePickFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    uploadFiles(files);
    event.currentTarget.value = "";
  }

  function resizeComposerTextarea(textarea?: HTMLTextAreaElement | null) {
    const target = textarea ?? composerTextareaRef.current;
    if (!target) return;
    // Starts at one line in every chat and grows with the text, up to a third of the viewport.
    const viewportMax = Math.max(120, Math.floor(window.innerHeight / 3));
    const minHeight = 34;
    target.style.maxHeight = `${viewportMax}px`;
    target.style.height = "auto";
    const nextHeight = Math.min(target.scrollHeight, viewportMax);
    target.style.height = `${Math.max(minHeight, nextHeight)}px`;
    target.style.overflowY = target.scrollHeight > viewportMax ? "auto" : "hidden";
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(event.clipboardData.items ?? []);
    const imageFiles = items
      .map((item) => {
        if (!item.type.startsWith("image/")) return null;
        return item.getAsFile();
      })
      .filter((file): file is File => Boolean(file));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    const filesToUpload = imageFiles.map((image) => {
      const ext = image.type.includes("/") ? image.type.split("/")[1] : "png";
      const safeExt = ext.replace(/[^a-zA-Z0-9]/g, "") || "png";
      const filename = `pasted-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${safeExt}`;
      return new File([image], filename, { type: image.type || "image/png" });
    });
    uploadFiles(filesToUpload);
  }

  useEffect(() => {
    resizeComposerTextarea();
  }, [draft, isConversationEmpty, activeChannelId]);

  useEffect(() => {
    function handleWindowResize() {
      resizeComposerTextarea();
    }
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, []);

  useImperativeHandle(ref,()=>({
    insertText:session.insertText,
    enqueueFiles:uploadFiles,
    setReplyTarget:session.setReplyTarget,
    focus(){composerTextareaRef.current?.focus();},
  }));

  // .nest-chat-composer is the scope for assistant-ui's composer look (spec 7.4); the rules are plain CSS in styles.css,
  // so both chats get the same look whether or not chat.css is loaded.
  return <div className="nest-chat-composer">
  <form className={`composer${isConversationEmpty ? " composer-compact" : ""}`} onSubmit={session.handleSubmit}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="composer-file-input"
            onChange={handlePickFiles}
          />
          {session.replyTo&&<div data-slot="reply-chip" className="mx-2 mb-1 flex min-w-0 items-center gap-2 rounded-lg bg-muted py-1 ps-2.5 pe-1 text-xs text-muted-foreground animate-in fade-in duration-150">
            <CornerUpLeftIcon aria-hidden="true" className="size-3.5 shrink-0"/>
            <span className="min-w-0 flex-1 truncate">Replying to {session.replyTo.author}</span>
            <button type="button" aria-label="Cancel reply" title="Cancel reply" disabled={sending} onClick={()=>session.setReplyTarget(null)}
              className="grid size-6 shrink-0 place-items-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
              <XIcon aria-hidden="true" className="size-3.5"/>
            </button>
          </div>}
          <ChatAttachments items={pendingAttachments} error={attachmentError} disabled={sending} onRemove={id=>setPendingAttachments(items=>items.filter(item=>item.localId!==id))}/>
          <div className="mention-input">
          {mentions.popup}
          <textarea
            {...mentions.textareaProps}
            aria-label="Message"
            ref={composerTextareaRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              mentions.sync(event.currentTarget);
              resizeComposerTextarea(event.currentTarget);
            }}
            onPaste={handleComposerPaste}
            onKeyDown={(event) => {
              if (mentions.onKeyDown(event)) return;
              if (event.keyCode === 229) return;
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={
              activeChannel?.archivedAt
                ? "Restore this channel to send messages"
                : activeChannel && !activeChannelCanPost
                  ? "This channel is shared with you as read-only"
                : activeChannel
                  ? `Message to ${activeConversationName}`
                  : "Select a channel first"
            }
            disabled={!activeChannel || Boolean(activeChannel.archivedAt) || !activeChannelCanPost || sending}
            rows={1}
          />
          </div>
          {draftRecipients.length>0&&<div className="mention-delivery" aria-label="Message recipients">{draftRecipients.map(m=><span key={m.kind+':'+m.name}>{m.kind==='AGENT'?'Ask':'Notify'} @{m.name}<button type="button" aria-label={'Remove mention @'+m.name} onClick={()=>{const spans=draftState.mentions.filter(x=>x.kind===m.kind&&x.name===m.name).sort((a,b)=>b.start-a.start);let next=draft;for(const span of spans)next=next.slice(0,span.start)+next.slice(span.end);setDraft(next);}}>×</button></span>)}</div>}
          <p className="mention-delivery-hint"><span>{draftRecipients.some(m=>m.kind==='AGENT')?'The selected agents receive this request.':'Select an @mention to direct a request or notify a person.'}</span>{draft.trim()&&<span className="draft-storage-status" role="status">{draftStored?'Draft saved on this device':'Draft storage is unavailable. Keep this tab open until you send.'}</span>}</p>
          <div className="composer-actions">
            <button
              type="button"
              className="composer-secondary"
              disabled={!activeChannel || Boolean(activeChannel.archivedAt) || !activeChannelCanPost || sending}
              onClick={() => fileInputRef.current?.click()}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>
              Attach files
            </button>
            <button
              className="composer-send"
              disabled={
                !activeChannel ||
                Boolean(activeChannel.archivedAt) ||
                !activeChannelCanPost ||
                sending || Boolean(mentions.inviting) || hasAttachmentErrors ||
                uploadingAttachmentCount > 0 ||
                (!draft.trim() && readyAttachments.length === 0)
              }
            >
              {uploadingAttachmentCount > 0
                ? `Uploading ${uploadingAttachmentCount}...`
                : sending
                  ? "Sending..."
                  : "Send"}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>
            </button>
          </div>
          {hasAttachmentErrors ? (
            <p className="composer-attachment-error">
              Remove failed uploads before sending. You can attach them again to retry.
            </p>
          ) : null}
          </form>
  </div>;
});
