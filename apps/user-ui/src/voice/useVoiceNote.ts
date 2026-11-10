import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {apiJson,getApiHeaders} from '../api';
import {postFile} from '../attachments';
import type {VoiceConfig} from '../huddle/session';
import {createVoiceNote,type VoiceAudio,type VoiceDeps} from './voice-note';

/** The browser can record: the button is hidden otherwise. */
export const canRecordVoice=()=>typeof MediaRecorder!=='undefined'&&typeof navigator!=='undefined'&&Boolean(navigator.mediaDevices?.getUserMedia);

/**
 * Records a voice note for a composer. The audio goes through POST /api/files and POST /api/voice/transcribe only.
 * `onAudio` adds it to the composer's attachment list; `onTranscript` puts the text into the draft, where it can be edited.
 */
export function useVoiceNote({onTranscript,onAudio}:{onTranscript(text:string):void;onAudio(audio:VoiceAudio):void}){
  const latest=useRef({onTranscript,onAudio});latest.current={onTranscript,onAudio};
  const [note]=useState(()=>createVoiceNote({
    getUserMedia:()=>navigator.mediaDevices.getUserMedia({audio:true}),
    Recorder:(typeof MediaRecorder!=='undefined'?MediaRecorder:undefined) as unknown as VoiceDeps['Recorder'],
    upload:async file=>{const body=new FormData();body.append('file',file,file.name);return (await postFile(body,()=>undefined)).id;},
    transcriptionEnabled:async()=>(await apiJson<VoiceConfig>('/api/voice/config')).transcription.enabled,
    transcribe:async fileId=>(await apiJson<{text:string}>('/api/voice/transcribe',{method:'POST',headers:getApiHeaders(),body:JSON.stringify({fileId})})).text,
    onAudio:audio=>latest.current.onAudio(audio),
    onTranscript:text=>latest.current.onTranscript(text),
  }));
  const snapshot=useSyncExternalStore(note.subscribe,note.snapshot);
  useEffect(()=>()=>note.destroy(),[note]);
  return {...snapshot,start:note.start,stop:note.stop,cancel:note.cancel};
}
export type VoiceNoteHook=ReturnType<typeof useVoiceNote>;
