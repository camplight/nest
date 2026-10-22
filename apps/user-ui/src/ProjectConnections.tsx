import {useEffect,useState} from 'react';
import {rememberConnectionReturn} from './project-connection-return';
import {apiJson,getApiHeaders} from './api';
import {IntegrationLogo} from './components/IntegrationLogo';

const tools=[
  {search:'trello',match:/\btrello\b/i},{search:'slack',match:/\bslack\b/i},
  {search:'googledrive',match:/\bgoogle\s+drive\b/i},{search:'gmail',match:/\bgmail\b/i},
  {search:'googlecalendar',match:/\bgoogle\s+calendar\b/i},{search:'github',match:/\bgithub\b/i},
  {search:'miro',match:/\bmiro\b/i},{search:'fathom',match:/\bfathom\b/i},
  {search:'wordpress',match:/\bwordpress\b/i},
];
export function suggestedApps(text:string){return tools.filter(tool=>tool.match.test(text)).map(tool=>tool.search).slice(0,2);}
type App={slug:string;name:string;connectable:boolean};
export function ProjectConnections({text,ownerId,projectId}:{text:string;ownerId:string;projectId:string}) {
  const searches=suggestedApps(text).join(',');
  const [apps,setApps]=useState<App[]>([]),[dismissed,setDismissed]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();setApps([]);
    if(!searches||dismissed)return()=>controller.abort();
    void (async()=>{
      const config=await apiJson<{configured:boolean}>('/api/integrations/config',{signal:controller.signal});
      if(!config.configured)return;
      const active=new Set<string>();let cursor:string|null=null;
      for(let page=0;page<20;page++){
        const accounts:{items:{toolkit:string;status:string}[];nextCursor:string|null}=await apiJson('/api/integrations/connections'+(cursor?'?cursor='+encodeURIComponent(cursor):''),{signal:controller.signal});
        accounts.items.filter(a=>a.status==='ACTIVE').forEach(a=>active.add(a.toolkit.toLowerCase()));
        cursor=accounts.nextCursor;if(!cursor)break;
      }
      if(cursor)return; // An incomplete account list must not suggest reconnecting.
      const found=await Promise.all(searches.split(',').map(async search=>{
        const page=await apiJson<{items:App[]}>('/api/integrations/toolkits?search='+encodeURIComponent(search),{signal:controller.signal});
        return page.items.find(app=>app.connectable&&app.slug.toLowerCase()===search&&!active.has(app.slug.toLowerCase()));
      }));
      if(!controller.signal.aborted)setApps(found.filter((app):app is App=>!!app));
    })().catch(()=>{}); // Optional suggestions never block chat on a provider outage.
    return()=>controller.abort();
  },[searches,dismissed]);
  async function connect(app:App){
    setBusy(app.slug);setError('');
    try{
      const result=await apiJson<{redirectUrl:string}>('/api/integrations/connections/link',{method:'POST',headers:getApiHeaders(),body:JSON.stringify({toolkit:app.slug})});
      const url=new URL(result.redirectUrl);if(url.protocol!=='https:'||url.username||url.password)throw Error('Invalid authorization URL');
      rememberConnectionReturn(ownerId,projectId);window.location.assign(url.toString());
    }catch{setError('We couldn’t open account authorization. Try again.');setBusy('');}
  }
  if(dismissed||!apps.length)return null;
  return <aside className="project-connection-suggestions" aria-label="Suggested connections">
    <div><span>Work with your apps</span><button type="button" className="project-inline-action" disabled={!!busy} aria-label="Dismiss connection suggestions" onClick={()=>setDismissed(true)}>Dismiss</button></div>
    <div>{apps.map(app=><button type="button" className="dashboard-action" disabled={!!busy} key={app.slug} onClick={()=>void connect(app)}><IntegrationLogo toolkit={app.slug}/>{busy===app.slug?'Opening…':`Connect ${app.name}`}</button>)}</div>
    <small>This links your own account. Choose tools for your agent in Connected apps; teammates can use those grants through the agent.</small>
    {error&&<p role="alert">{error}</p>}
  </aside>;
}
