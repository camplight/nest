import {MicIcon,SquareIcon,XIcon} from 'lucide-react';
import {canRecordVoice,type VoiceNoteHook} from './useVoiceNote';
import './voice.css';

const clock=(seconds:number)=>`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;

/**
 * The mic and, while recording, a stop button (with the time) and Cancel. `variant` only picks the surrounding look:
 * `composer` is the reply box's icon-only mic (coral and pulsing while it records), `dock` the bottom box's round icon button, `page` the Projects page footer.
 */
export function VoiceButton({voice,disabled=false,variant}:{voice:VoiceNoteHook;disabled?:boolean;variant:'composer'|'dock'|'page'}){
  if(!canRecordVoice())return null;
  const className=variant==='dock'?'project-start-dock-attach':variant==='page'?'dashboard-action':'composer-secondary';
  const busy=voice.state==='uploading'||voice.state==='transcribing';
  // The reply box (like the mock's composer) shows one icon-only mic that turns coral and becomes the stop button.
  const iconOnly=variant!=='page';
  const mic=variant==='composer'?' voice-note-mic':'';
  if(voice.state==='recording')return <span className="voice-note-group is-recording">
    <button type="button" className={`${className} voice-note-button${mic} is-recording`} aria-label={`Stop recording (${clock(voice.seconds)})`} title="Stop and transcribe" onClick={voice.stop}>
      {variant==='composer'?<MicIcon size={16} aria-hidden="true"/>:<SquareIcon size={14} aria-hidden="true" fill="currentColor"/>}{!iconOnly&&<span aria-hidden="true">{clock(voice.seconds)}</span>}
    </button>
    <button type="button" className={`${className} voice-note-button${mic}`} aria-label="Cancel recording" title="Cancel recording" onClick={voice.cancel}><XIcon size={16} aria-hidden="true"/>{!iconOnly&&'Cancel'}</button>
  </span>;
  return <span className="voice-note-group">
    <button type="button" className={`${className} voice-note-button${mic}`} aria-label="Record a voice note" title={iconOnly?'Speak instead of typing':'Record a voice note'} disabled={disabled||busy} onClick={()=>void voice.start()}>
      <MicIcon size={variant==='dock'?18:16} aria-hidden="true"/>{!iconOnly&&'Voice note'}
    </button>
    {busy&&<button type="button" className={`${className} voice-note-button${mic}`} aria-label="Cancel voice note" title="Cancel voice note" onClick={voice.cancel}><XIcon size={16} aria-hidden="true"/></button>}
  </span>;
}

/** The spoken status (a polite live region that is always present) and a visible error. */
export function VoiceStatus({voice}:{voice:VoiceNoteHook}){
  if(!canRecordVoice())return null;
  const recording=voice.state==='recording';
  const text=recording?'Listening…':voice.state==='uploading'?'Uploading the voice note…':voice.state==='transcribing'?'Transcribing the voice note…':'';
  return <>
    <p className={`voice-note-status${recording?' is-recording':''}`} role="status" aria-live="polite">
      {recording&&<span className="voice-note-wave" aria-hidden="true">{Array.from({length:9},(_,i)=><span key={i} className="voice-note-bar"/>)}</span>}
      {text}
      {recording&&<span className="voice-note-time" aria-hidden="true">{clock(voice.seconds)}</span>}
    </p>
    {voice.error&&<p className="voice-note-error" role="alert">{voice.error}</p>}
  </>;
}
