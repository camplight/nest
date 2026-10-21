import {useEffect,useState} from 'react';
import {apiJson} from './api';
import type {ConnectionChannelReview as ChannelReview} from '@nest/schemas';
export function ConnectionChannels({name}:{name:string}) {
  const [channels,setChannels]=useState<ChannelReview[]>([]);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const path=`/api/integrations/agents/${encodeURIComponent(name)}/channels`;
  useEffect(()=>{
    const abort=new AbortController();setError('');
    void apiJson<{channels:ChannelReview[]}>(path,{signal:abort.signal}).then(value=>{if(!abort.signal.aborted)setChannels(Array.isArray(value.channels)?value.channels:[]);}).catch(()=>{if(!abort.signal.aborted)setError('Could not load public-channel access. Reload to try again.');});
    return()=>abort.abort();
  },[path,revision]);
  async function change(channel:ChannelReview) {
    setBusy(true);setError('');
    try {
      await apiJson(`${path}/${encodeURIComponent(channel.channelId)}`,{method:channel.approved?'DELETE':'PUT',headers:{'content-type':'application/json'},body:channel.approved?undefined:JSON.stringify({audienceHash:channel.audienceHash,acknowledgePublicAccess:true})});
      setRevision(v=>v+1);
    } catch {setError('Access was not confirmed. Reload and review the channel membership.');}
    finally {setBusy(false);}
  }
  return <article className="dashboard-card connection-project-access">
    <h3>Public-channel access</h3>
    <p>You and your agent must both be channel participants. Approving lets participants ask the agent to use all apps and tools you grant it, including later grants. Anyone who can read the public channel may see the results.</p>
    <p>Access pauses across the agent’s chats if you leave, membership changes, or approval is removed. Membership does not mean you are online or have approved each request. The agent can carry information between chats; removing access cannot erase information already shared.</p>
    {!channels.length&&!error&&<p>Join a public channel with {name} to review access here.</p>}
    {channels.map(channel=><section key={channel.channelId}>
      <h4>{channel.name}</h4>
      <p>{channel.participants.map(p=>`${p.subscriberId} (${p.subscriberType==='AGENT'?'agent':'person'})`).join(', ')}</p>
      <p>{channel.approved?'Approved while you remain a participant.':channel.audienceHash?'Your approval is required before connected apps can be used.':'This channel is not eligible. It must be active, with you present and no additional shared viewers or team subscriptions.'}</p>
      <button className="dashboard-action" disabled={busy||(!channel.approved&&!channel.audienceHash)} onClick={()=>void change(channel)}>{channel.approved?'Remove channel approval':'Allow my apps in this public channel'}</button>
    </section>)}
    {error&&<p role="alert">{error}</p>}
    <button className="dashboard-action" disabled={busy} onClick={()=>setRevision(v=>v+1)}>Reload public-channel access</button>
  </article>;
}
