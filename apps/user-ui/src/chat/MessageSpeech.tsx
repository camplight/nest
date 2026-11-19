import {useEffect,useRef,useState} from 'react';
import {apiFetch} from '../api';

export function MessageSpeech({eventId}:{eventId:string}) {
  const [url,setUrl]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const current=useRef<{abort:AbortController;url?:string}|null>(null);
  const audio=useRef<HTMLAudioElement>(null);
  function dispose() {
    current.current?.abort.abort();
    if(current.current?.url)URL.revokeObjectURL(current.current.url);
    current.current=null;
  }
  useEffect(()=>()=>dispose(),[eventId]);
  function close(){audio.current?.pause();dispose();setUrl('');setBusy(false);setError('');}
  async function listen() {
    dispose();const request={abort:new AbortController(),url:''};current.current=request;
    setBusy(true);setError('');
    try {
      const response=await apiFetch('/api/speech/messages/'+encodeURIComponent(eventId),{method:'POST',signal:request.abort.signal});
      const blob=await response.blob();
      if(current.current!==request)return;
      request.url=URL.createObjectURL(blob);setUrl(request.url);
    } catch(reason) {
      if(request.abort.signal.aborted)return;
      let message='Could not load speech. Try again.';
      if(reason instanceof Error){try {const parsed=JSON.parse(reason.message);if(typeof parsed.error==='string')message=parsed.error;}catch{/* Keep a friendly fallback. */}}
      setError(message);
    } finally {if(current.current===request)setBusy(false);}
  }
  return <div className="message-speech" data-aui-quote-selectable="false">
    {!url&&<button type="button" className="message-speech-button" disabled={busy} onClick={()=>void listen()} aria-label="Listen to message">{busy?'Generating speech…':'Listen'}</button>}
    {(busy||url)&&<button type="button" className="message-speech-button" onClick={close}>{busy?'Cancel':'Close audio'}</button>}
    {url&&<audio ref={audio} controls src={url} aria-label="Spoken message" onError={()=>setError('This audio could not be played. Close it and try again.')}/>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
