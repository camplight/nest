import {ModelValueChart} from './ModelValueChart';
import {useEffect,useState,useRef} from 'react';
import {describeModelReference,modelProviderLabel,type CompatibleCatalog,type CompatibleModel,type ModelBenchmarks,type OpenRouterCatalog,type OpenRouterModel} from '@nest/schemas';
import {apiJson,getApiHeaders} from './api';
import './model-picker.css';

const logos:Record<string,string>={openai:'openai',anthropic:'anthropic',google:'google',moonshotai:'moonshot',qwen:'qwen',deepseek:'deepseek',minimax:'minimax','z-ai':'zai',tencent:'tencent'};
// Non-OpenRouter references (e.g. openai-compatible on Fireworks) read as "model · provider".
const otherProvider=(value:string)=>{if(!value.includes(':')||value.startsWith('openrouter:'))return '';const d=describeModelReference(value);return `${d.name} · ${d.provider}`;};
type ProviderId='openrouter'|'openai-compatible';
type ModelProvider={id:ProviderId;label:string};
const COMPATIBLE='openai-compatible:';
const providerOf=(value:string):ProviderId=>value.startsWith(COMPATIBLE)?'openai-compatible':'openrouter';
const modelName=(value:string)=>value.replace(/^(openrouter|openai-compatible):/,'');
// One ID draft per provider: the saved model shows only under its own provider.
const draftsFor=(value:string):Record<ProviderId,string>=>({openrouter:providerOf(value)==='openrouter'?modelName(value):'','openai-compatible':providerOf(value)==='openai-compatible'?modelName(value):''});
// Family marks for provider-hosted open models (Fireworks IDs carry no vendor prefix).
const families:[string,string][]=[['glm','zai'],['kimi','moonshot'],['deepseek','deepseek'],['qwen','qwen'],['minimax','minimax'],['gpt-oss','openai']];
const familyLogo=(id:string)=>{const segment=(id.split('/').pop()??id).toLowerCase();return families.find(([prefix])=>segment.startsWith(prefix))?.[1];};
const SUGGESTED=4;
const money=(value:number|null)=>value === null ? 'Unknown' : `$${value.toLocaleString(undefined,{maximumFractionDigits:3})}`;
function message(error:unknown) {
  const raw=error instanceof Error?error.message:'Request failed';
  try {return JSON.parse(raw).error || 'Request failed';}catch{return raw;}
}
export function ModelPicker({agentName,value,disabled,onChange}:{agentName:string;value:string;disabled:boolean;onChange:(value:string)=>void}) {
  const [open,setOpen]=useState(false);
  const [catalog,setCatalog]=useState<OpenRouterCatalog|null>(null);
  const [error,setError]=useState('');
  const [attempt,setAttempt]=useState(0);
  const [query,setQuery]=useState('');
  const [benchmarks,setBenchmarks]=useState<ModelBenchmarks|null>(null);
  const [benchmarkError,setBenchmarkError]=useState('');
  const [vision,setVision]=useState(false);
  // Providers whose keys this agent has; null until known (or unavailable), then the saved model decides.
  const [providers,setProviders]=useState<ModelProvider[]|null>(null);
  const [mode,setMode]=useState<ProviderId>(providerOf(value));
  const active:ProviderId=providers?.length&&!providers.some(p=>p.id===mode)?providers[0].id:mode;
  const label=active==='openrouter'?'OpenRouter':providers?.find(p=>p.id===active)?.label??modelProviderLabel('openai-compatible',modelName(value));
  const [drafts,setDrafts]=useState(()=>draftsFor(value));
  const selected=drafts[active];
  const [compat,setCompat]=useState<CompatibleCatalog|null>(null);
  const [compatError,setCompatError]=useState('');
  const [browseAll,setBrowseAll]=useState(false);
  const [compatQuery,setCompatQuery]=useState('');
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState('');
  const checkedReference=useRef('');
  useEffect(()=>{setMode(providerOf(value));setDrafts(draftsFor(value));if(checkedReference.current!==value)setResult('');},[value]);
  useEffect(()=>{
    if(disabled)return;
    const controller=new AbortController();
    void apiJson<{providers:ModelProvider[]}>(`/api/agents/${encodeURIComponent(agentName)}/model-providers`,{signal:controller.signal})
      .then(data=>{if(Array.isArray(data?.providers))setProviders(data.providers);})
      .catch(()=>{}); // Unknown providers fall back to the saved model's provider.
    return ()=>controller.abort();
  },[agentName,disabled]);
  function switchProvider(id:ProviderId){setMode(id);setResult('');}
  useEffect(()=>{
    if(!open||active!=='openrouter')return;
    const controller=new AbortController();setError('');
    void apiJson<OpenRouterCatalog>('/api/openrouter-models',{signal:controller.signal}).then(value=>{if(!value||!Array.isArray(value.models))throw Error('OpenRouter catalog unavailable. Enter an exact model ID below.');setCatalog(value);}).catch(e=>{if(!controller.signal.aborted)setError(message(e));});
    return ()=>controller.abort();
  },[attempt,open,active]);
  useEffect(()=>{
    if(!open||disabled||active!=='openai-compatible')return;
    const controller=new AbortController();setCompatError('');
    void apiJson<CompatibleCatalog>(`/api/agents/${encodeURIComponent(agentName)}/compatible-models`,{signal:controller.signal}).then(data=>{
      if(!Array.isArray(data?.models))throw Error('The provider’s model list is unavailable. You can still enter an exact model ID below.');
      setCompat(data);
    }).catch(e=>{if(!controller.signal.aborted)setCompatError(message(e));});
    return ()=>controller.abort();
  },[open,agentName,attempt,disabled,active]);
  useEffect(()=>{
    if(!open||disabled||active!=='openrouter')return;
    const controller=new AbortController();setBenchmarkError('');
    void apiJson<ModelBenchmarks>(`/api/agents/${encodeURIComponent(agentName)}/model-benchmarks`,{signal:controller.signal}).then(data=>{
      if(!Array.isArray(data?.models))throw Error('Intelligence scores are unavailable.');
      setBenchmarks(data);
    }).catch(()=>{if(!controller.signal.aborted)setBenchmarkError('Intelligence scores are unavailable. You can still compare prices below.');});
    return ()=>controller.abort();
  },[open,agentName,attempt,disabled,active]);
  const models=(catalog?.models??[]).filter(m=>m.tools&&(!vision||m.vision)&&`${m.id} ${m.name}`.toLowerCase().includes(query.toLowerCase()));
  const shown=models.slice(0,query?20:5);
  const current=catalog?.models.find(m=>`openrouter:${m.id}`===value);
  const savedCompat=compat?.models.find(m=>COMPATIBLE+m.id===value);
  // A few suggestions (the saved model first, then the newest models); every model and search on request.
  const compatMatches=(compat?.models??[]).filter(m=>(!vision||m.vision)&&`${m.id} ${m.name}`.toLowerCase().includes(compatQuery.toLowerCase()));
  const compatShown=browseAll?compatMatches.slice(0,60):[...(savedCompat&&(!vision||savedCompat.vision)?[savedCompat]:[]),...compatMatches.filter(m=>!m.route&&m!==savedCompat)].slice(0,SUGGESTED);
  const selectedCompat=compat?.models.find(m=>m.id===selected);
  const selectedModel=catalog?.models.find(m=>m.id===selected);
  function choose(id:string){setDrafts(d=>({...d,[active]:id}));setResult('');}
  async function connect(){
    if(busy||disabled)return;
    setBusy(true);setResult('');
    try {
      const checked=await apiJson<{reference:string;latencyMs:number;provider?:string}>(`/api/agents/${encodeURIComponent(agentName)}/model-check`,{method:'POST',headers:getApiHeaders(),body:JSON.stringify({model:active==='openai-compatible'?COMPATIBLE+modelName(selected.trim()):selected})});
      checkedReference.current=checked.reference;
      onChange(checked.reference);
      setResult(`Tool-call check passed${checked.provider&&checked.provider!=='OpenRouter'?` on ${checked.provider}`:''} in ${(checked.latencyMs/1000).toFixed(1)}s. Save settings to use this model on the next turn.`);
    }catch(e){setResult(message(e));}finally{setBusy(false);}
  }
  function compatCard(model:CompatibleModel){
    const logo=familyLogo(model.id);
    return <button type="button" className="model-option" key={model.id} aria-pressed={selected===model.id} disabled={disabled||busy} onClick={()=>choose(model.id)}>
      <span className="model-option-heading"><span className="model-provider-mark" aria-hidden="true">{logo?<img src={`/model-logos/${logo}.svg`} alt=""/>:model.name.slice(0,2).toUpperCase()}</span><span><strong>{model.name}</strong><small>{model.route?'Route':'Model'} · {model.id.split('/').pop()}</small></span><span className="model-selection" aria-hidden="true">{selected===model.id?'✓':'○'}</span></span>
      <span className="model-capabilities">{model.tools!==false&&<span>Tools</span>}{model.vision===true?<span>Image input</span>:model.vision===false?<span>Text input only</span>:null}</span>
      <span className="model-context">{model.context?`${(model.context/1000).toLocaleString()}K context`:'Context not reported'}</span>
    </button>;
  }
  function card(model:OpenRouterModel){
    const provider=model.id.split('/')[0];
    return <button type="button" className="model-option" key={model.id} aria-pressed={selected===model.id} disabled={disabled||busy} onClick={()=>choose(model.id)}>
      <span className="model-option-heading"><span className="model-provider-mark" aria-hidden="true">{logos[provider]?<img src={`/model-logos/${logos[provider]}.svg`} alt=""/>:provider.slice(0,2).toUpperCase()}</span><span><strong>{model.name}</strong><small>{provider} · {query?'Search result':'Catalog model'}</small></span><span className="model-selection" aria-hidden="true">{selected===model.id?'✓':'○'}</span></span>
      <span className="model-capabilities"><span>Tools</span><span>{model.vision?'Image input':'Text input only'}</span>{model.reasoning&&<span>Reasoning</span>}</span>
      <span className="model-price">{money(model.inputPrice)} in / {money(model.outputPrice)} out <small>per 1M tokens</small></span>
      <span className="model-context">{model.context?`${(model.context/1000).toLocaleString()}K context`:'Context not reported'}</span>
    </button>;
  }
  const fireworks=label==='Fireworks';
  return <details className="model-picker" open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary className="model-picker-toggle"><span><strong>{active==='openrouter'?'Explore OpenRouter models':`Choose a ${label} model`}</strong><small>{current?.name || (savedCompat&&`${savedCompat.name} · ${compat?.provider}`) || otherProvider(value) || value || 'Choose a model'}</small></span><span className="model-picker-chevron" aria-hidden="true">⌄</span></summary>
    <div className="model-picker-content" aria-label={`${label} model picker`}>
    {providers&&providers.length>1&&<div className="model-provider-switch" role="group" aria-label="Model provider">{providers.map(p=><button type="button" key={p.id} aria-pressed={active===p.id} disabled={busy} onClick={()=>switchProvider(p.id)}>{p.label}</button>)}</div>}
    {providers&&!providers.length&&<p role="status">No model provider key is configured for this agent. Ask an administrator to add one.</p>}
    {active==='openrouter'?<>
    <div className="model-filters"><input aria-label="Search OpenRouter models" placeholder="Search models or providers…" value={query} onChange={e=>setQuery(e.target.value)}/><label><input type="checkbox" checked={vision} onChange={e=>setVision(e.target.checked)}/> Image input</label></div>
    {!catalog&&!error&&<p role="status">Loading live OpenRouter catalog…</p>}
    {error&&<p role="alert">{error} <button type="button" onClick={()=>setAttempt(n=>n+1)}>Retry catalog</button></p>}
    {catalog&&<>
      {benchmarks&&<ModelValueChart models={models} benchmarks={benchmarks} selected={selected} searching={!!query.trim()} disabled={disabled||busy} onChoose={choose}/>}
      {benchmarkError&&<p role="status">{benchmarkError} <button type="button" onClick={()=>setAttempt(n=>n+1)}>Retry scores</button></p>}
      {!benchmarks&&!benchmarkError&&!disabled&&<p role="status">Loading intelligence scores…</p>}
      <div className="model-options">{shown.map(card)}</div>
      {!shown.length&&<p>No matching tool-capable models. Try another search or enter an exact ID below.</p>}
      <p className="model-source">{catalog.stale?'Showing cached models. ':''}<a href="https://openrouter.ai/models" target="_blank" rel="noreferrer">Compare on OpenRouter ↗</a></p>
    </>}
    {selectedModel&&<details className="model-summary"><summary>About {selectedModel.name}</summary><p>{selectedModel.description}</p><p><b>Useful for:</b> {selectedModel.tools?'tool-based agents':'text conversations (tools not advertised)'}{selectedModel.vision?', image analysis':''}{selectedModel.reasoning?', reasoning tasks':''}. <b>Trade-offs:</b> {selectedModel.vision?'Image capability is advertised, not tested here.':'Cannot read images according to the catalog.'} Prices vary by route and context.</p></details>}
    </>:<>
    {browseAll&&<div className="model-filters"><input aria-label={`Search ${label} models`} placeholder="Search models…" value={compatQuery} onChange={e=>setCompatQuery(e.target.value)}/><label><input type="checkbox" checked={vision} onChange={e=>setVision(e.target.checked)}/> Image input</label></div>}
    {!compat&&!compatError&&<p role="status">Loading {label} models…</p>}
    {compatError&&<p role="alert">{compatError} <button type="button" onClick={()=>setAttempt(n=>n+1)}>Retry models</button></p>}
    {compat&&<>
      <div className="model-options">{compatShown.map(compatCard)}</div>
      {!compatShown.length&&<p>No matching models. Try another search or enter an exact ID below.</p>}
      <div className="model-browse"><button type="button" className="dashboard-action" aria-expanded={browseAll} onClick={()=>{setBrowseAll(v=>!v);setCompatQuery('');}}>{browseAll?'Show suggestions':`Browse all ${compat.models.length} models`}</button>
      <p className="model-source">{compat.stale?'Showing cached models. ':''}{label} doesn’t list prices here.{fireworks&&<> <a href="https://fireworks.ai/models" target="_blank" rel="noreferrer">Compare on Fireworks ↗</a></>}</p></div>
    </>}
    {selectedCompat?.description&&<details className="model-summary"><summary>About {selectedCompat.name}</summary><p>{selectedCompat.description}</p></details>}
    </>}
    <div className="model-connect"><label htmlFor="custom-model-id">Exact {label} model ID</label><div><input id="custom-model-id" placeholder={active==='openrouter'?'provider/model-name':fireworks?'accounts/fireworks/models/model-name':'model-name'} value={selected} disabled={disabled||busy} onChange={e=>choose(e.target.value)}/><button className="dashboard-action" type="button" disabled={disabled||busy||!selected.trim()} onClick={()=>void connect()}>{busy?'Testing…':'Connect'}</button></div><small>Tests a tool call using this agent’s {label} key (small usage charge). Save settings to apply.</small></div>
    {result&&<p role="status" className="model-result">{result}</p>}
    </div>
  </details>;
}
