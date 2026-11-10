import {MicIcon,SquareIcon,XIcon} from 'lucide-react';
import {canRecordVoice,type VoiceNoteHook} from './useVoiceNote';
import './voice.css';

const clock=(seconds:number)=>`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;

/**
 * The mic and, while recording, a stop button (with the time) and Cancel. `variant` only picks the surrounding look:
 * `composer` matches the reply box's action buttons, `dock` the bottom box's round icon button, `page` the Projects page footer.
 */
export function VoiceButton({voice,disabled=false,variant}:{voice:VoiceNoteHook;disabled?:boolean;variant:'composer'|'dock'|'page'}){
  if(!canRecordVoice())return null;
  const className=variant==='dock'?'project-start-dock-attach':variant==='page'?'dashboard-action':'composer-secondary';
  const busy=voice.state==='uploading'||voice.state==='transcribing';
  if(voice.state==='recording')return <span className="voice-note-group is-recording">
    <button type="button" className={`${className} voice-note-button is-recording`} aria-label={`Stop recording (${clock(voice.seconds)})`} title="Stop recording" onClick={voice.stop}>
      <SquareIcon size={14} aria-hidden="true" fill="currentColor"/>{variant!=='dock'&&<span aria-hidden="true">{clock(voice.seconds)}</span>}
    </button>
    <button type="button" className={`${className} voice-note-button`} aria-label="Cancel recording" title="Cancel recording" onClick={voice.cancel}><XIcon size={16} aria-hidden="true"/>{variant!=='dock'&&'Cancel'}</button>
  </span>;
  return <span className="voice-note-group">
    <button type="button" className={`${className} voice-note-button`} aria-label="Record a voice note" title="Record a voice note" disabled={disabled||busy} onClick={()=>void voice.start()}>
      <MicIcon size={variant==='dock'?18:16} aria-hidden="true"/>{variant!=='dock'&&'Voice note'}
    </button>
    {busy&&<button type="button" className={`${className} voice-note-button`} aria-label="Cancel voice note" title="Cancel voice note" onClick={voice.cancel}><XIcon size={16} aria-hidden="true"/></button>}
  </span>;
}

/** The spoken status (a polite live region that is always present) and a visible error. */
export function VoiceStatus({voice}:{voice:VoiceNoteHook}){
  if(!canRecordVoice())return null;
  const text=voice.state==='recording'?'Recording a voice note':voice.state==='uploading'?'Uploading the voice note…':voice.state==='transcribing'?'Transcribing the voice note…':'';
  return <>
    <p className={`voice-note-status${voice.state==='recording'?' is-recording':''}`} role="status" aria-live="polite">{text}{voice.state==='recording'&&<span aria-hidden="true"> {clock(voice.seconds)}</span>}</p>
    {voice.error&&<p className="voice-note-error" role="alert">{voice.error}</p>}
  </>;
}
