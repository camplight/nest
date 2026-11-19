import {useEffect,useRef,useState} from 'react';
import {apiJson} from '../api';
import {apiUrl} from '../config';

export function MessageSpeech({eventId}:{eventId:string}) {
  const [url,setUrl]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const current=useRef<AbortController|null>(null);
  const audio=useRef<HTMLAudioElement>(null);
  function dispose() {
    current.current?.abort();current.current=null;
    const player=audio.current;
    if(player){player.pause();player.removeAttribute('src');player.load();}
  }
  useEffect(()=>()=>dispose(),[eventId]);
  function close(){dispose();setUrl('');setBusy(false);setError('');}
  async function listen() {
    dispose();const request=new AbortController();current.current=request;
    setBusy(true);setError('');
    try {
      const response=await apiJson<{url:string}>('/api/speech/messages/'+encodeURIComponent(eventId),{method:'POST',signal:request.signal});
      if(current.current!==request)return;
      if(!/^\/api\/speech\/streams\/[a-f0-9]{48}$/.test(response.url))throw Error('Invalid playback URL');
      setUrl(apiUrl(response.url));
    } catch(reason) {
      if(request.signal.aborted)return;
      let message='Could not load speech. Try again.';
      if(reason instanceof Error){try {const parsed=JSON.parse(reason.message);if(typeof parsed.error==='string')message=parsed.error;}catch{/* Keep a friendly fallback. */}}
      setError(message);setBusy(false);
    }
  }
  return <div className="message-speech" data-aui-quote-selectable="false">
    {!url&&<button type="button" className="message-speech-button" disabled={busy} onClick={()=>void listen()} aria-label="Listen to message">{busy?'Preparing speech…':'Listen'}</button>}
    {(busy||url)&&<button type="button" className="message-speech-button" onClick={close}>{busy?'Cancel':'Close audio'}</button>}
    {url&&<audio ref={audio} controls autoPlay preload="auto" crossOrigin="use-credentials" src={url} aria-label="Spoken message"
      onCanPlay={()=>setBusy(false)} onError={()=>{setBusy(false);setError('Speech was interrupted or could not be played. Close audio and choose Listen to retry.');}}/>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
