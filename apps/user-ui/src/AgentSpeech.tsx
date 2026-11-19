import {useEffect,useState, type FormEvent} from 'react';
import {DEFAULT_SPEECH_SETTINGS, SpeechSettingsSchema, type AgentSpeechSettings, type SpeechSettings} from '@nest/schemas';
import {apiJson,getApiHeaders} from './api';

export function AgentSpeech({name}:{name:string}) {
  const [data,setData]=useState<AgentSpeechSettings|null>(null);
  const [value,setValue]=useState<SpeechSettings>(DEFAULT_SPEECH_SETTINGS);
  const [error,setError]=useState(''),[saved,setSaved]=useState(false),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0);
  const path='/api/speech/agents/'+encodeURIComponent(name);
  useEffect(()=>{
    const abort=new AbortController();
    setData(null);setError('');
    void apiJson<AgentSpeechSettings>(path,{signal:abort.signal}).then(result=>{const settings=SpeechSettingsSchema.parse(result.settings);setData({...result,settings});setValue(settings);})
      .catch(()=>{if(!abort.signal.aborted)setError('Could not load speech settings.');});
    return()=>abort.abort();
  },[path,attempt]);
  const change=(patch:Partial<SpeechSettings>)=>{setValue(v=>({...v,...patch}));setSaved(false);};
  const dirty=Boolean(data && JSON.stringify(value)!==JSON.stringify(data.settings));
  useEffect(()=>{
    if (!dirty) return;
    const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
  },[dirty]);
  async function save(event:FormEvent) {
    event.preventDefault();setBusy(true);setError('');setSaved(false);
    try {const result=await apiJson<AgentSpeechSettings>(path,{method:'PUT',headers:getApiHeaders(),body:JSON.stringify(value)});setData(result);setValue(result.settings);setSaved(true);}
    catch {setError('Could not save speech settings. Check the voice ID and try again.');}
    finally {setBusy(false);}
  }
  return <form className="dashboard-card agent-speech" onSubmit={save} aria-label="Message speech settings">
    <h2>Message voice</h2>
    <p>Read this agent’s messages aloud with Fish Audio. Choose Listen on a message to send its text to Fish Audio and generate speech.</p>
    {error&&<p role="alert">{error} {!data&&<button type="button" onClick={()=>setAttempt(v=>v+1)}>Retry</button>}</p>}
    {!data&&!error&&<p role="status">Loading speech settings…</p>}
    {data&&<>
      {!data.available&&<p role="status">Fish Audio needs an API key from your administrator. You can save your voice preferences now.</p>}
      <fieldset disabled={!data.canManage||busy}>
        <label className="speech-toggle"><input type="checkbox" checked={value.enabled} onChange={e=>change({enabled:e.target.checked})}/> Enable message speech</label>
        <div className="agent-field"><label htmlFor="speech-voice">Fish Audio voice ID</label><input id="speech-voice" value={value.voiceId} maxLength={128} pattern="[a-zA-Z0-9_\-]*" required={value.enabled} onChange={e=>change({voiceId:e.target.value})}/><small>Copy a voice ID from <a href="https://fish.audio/" target="_blank" rel="noreferrer">Fish Audio</a>.</small></div>
        <div className="agent-field"><label htmlFor="speech-style">Speaking personality</label><select id="speech-style" value={value.style} onChange={e=>change({style:e.target.value as SpeechSettings['style']})}>{['neutral','friendly','calm','excited','confident','empathetic'].map(style=><option key={style} value={style}>{style[0].toUpperCase()+style.slice(1)}</option>)}</select><small>Controls vocal delivery. Personality and instructions above shape what the agent says.</small></div>
        <div className="agent-field"><label htmlFor="speech-speed">Speaking speed</label><select id="speech-speed" value={value.speed} onChange={e=>change({speed:Number(e.target.value)})}>{[0.5,0.75,1,1.25,1.5,1.75,2].map(speed=><option key={speed} value={speed}>{speed}×{speed===1?' · Normal':''}</option>)}</select></div>
        <button className="dashboard-action" disabled={!dirty||busy} type="submit">{busy?'Saving…':'Save voice'}</button>
      </fieldset>
      {!data.canManage&&<p>Only the agent owner or instance owner can change its voice.</p>}
      {saved&&<p role="status">Voice settings saved.</p>}
    </>}
  </form>;
}
