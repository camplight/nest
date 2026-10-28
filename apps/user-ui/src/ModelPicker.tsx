import {useEffect,useState} from 'react';
import type {OpenRouterCatalog,OpenRouterModel} from '@nest/schemas';
import {apiJson,getApiHeaders} from './api';
import './model-picker.css';

const money=(value:number|null)=>value === null ? 'Unknown' : `$${value.toLocaleString(undefined,{maximumFractionDigits:3})}`;
function message(error:unknown) {
  const raw=error instanceof Error?error.message:'Request failed';
  try {return JSON.parse(raw).error || 'Request failed';}catch{return raw;}
}
export function ModelPicker({agentName,value,disabled,onChange}:{agentName:string;value:string;disabled:boolean;onChange:(value:string)=>void}) {
  const [catalog,setCatalog]=useState<OpenRouterCatalog|null>(null);
  const [error,setError]=useState('');
  const [attempt,setAttempt]=useState(0);
  const [query,setQuery]=useState('');
  const [vision,setVision]=useState(false);
  const [selected,setSelected]=useState(value.replace(/^openrouter:/,''));
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState('');
  useEffect(()=>{setSelected(value.replace(/^openrouter:/,''));},[value]);
  useEffect(()=>{
    const controller=new AbortController();setError('');
    void apiJson<OpenRouterCatalog>('/api/openrouter-models',{signal:controller.signal}).then(setCatalog).catch(e=>{if(!controller.signal.aborted)setError(message(e));});
    return ()=>controller.abort();
  },[attempt]);
  const models=(catalog?.models??[]).filter(m=>m.tools&&(!vision||m.vision)&&`${m.id} ${m.name}`.toLowerCase().includes(query.toLowerCase()));
  const shown=models.slice(0,query?20:5);
  const current=catalog?.models.find(m=>`openrouter:${m.id}`===value);
  const selectedModel=catalog?.models.find(m=>m.id===selected);
  function choose(id:string){setSelected(id);setResult('');}
  async function connect(){
    if(busy||disabled)return;
    setBusy(true);setResult('');
    try {
      const checked=await apiJson<{reference:string;latencyMs:number}>(`/api/agents/${encodeURIComponent(agentName)}/model-check`,{method:'POST',headers:getApiHeaders(),body:JSON.stringify({model:selected})});
      onChange(checked.reference);
      setResult(`Tool-call check passed in ${(checked.latencyMs/1000).toFixed(1)}s. Save settings to use this model on the next turn.`);
    }catch(e){setResult(message(e));}finally{setBusy(false);}
  }
  function card(model:OpenRouterModel,index:number){
    const provider=model.id.split('/')[0];
    return <button type="button" className="model-option" key={model.id} aria-pressed={selected===model.id} disabled={disabled||busy} onClick={()=>choose(model.id)}>
      <span className="model-option-heading"><span className="model-provider-mark" aria-hidden="true">{provider.slice(0,2).toUpperCase()}</span><span><strong>{model.name}</strong><small>{provider} · {query?'Search result':`Popular pick ${index+1}`}</small></span><span className="model-selection" aria-hidden="true">{selected===model.id?'✓':'○'}</span></span>
      <span className="model-capabilities"><span>Tools</span><span>{model.vision?'Image input':'Text input only'}</span>{model.reasoning&&<span>Reasoning</span>}</span>
      <span className="model-price">{money(model.inputPrice)} in / {money(model.outputPrice)} out <small>per 1M tokens</small></span>
      <span className="model-context">{model.context?`${(model.context/1000).toLocaleString()}K context`:'Context not reported'}</span>
    </button>;
  }
  return <section className="model-picker" aria-label="OpenRouter model picker">
    <div className="model-picker-heading"><div><h3>Find your agent’s next model</h3><p>Five popular choices with tool support. Compare what matters to your work.</p></div><span className="model-router-badge">↗ OpenRouter</span></div>
    {current&&<p className="model-current">Selected: <strong>{current.name}</strong> · {current.tools?'Tools advertised':'Tool support not advertised'} · {current.vision?'Accepts images':'No image input advertised'}</p>}
    <div className="model-filters"><input aria-label="Search OpenRouter models" placeholder="Search models or providers…" value={query} onChange={e=>setQuery(e.target.value)}/><label><input type="checkbox" checked={vision} onChange={e=>setVision(e.target.checked)}/> Image input</label></div>
    {!catalog&&!error&&<p role="status">Loading live OpenRouter catalog…</p>}
    {error&&<p role="alert">{error} <button type="button" onClick={()=>setAttempt(n=>n+1)}>Retry catalog</button></p>}
    {catalog&&<>
      <div className="model-options">{shown.map(card)}</div>
      {!shown.length&&<p>No matching tool-capable models. Try another search or enter an exact ID below.</p>}
      <p className="model-source">Ordered by OpenRouter’s weekly token usage, not a quality benchmark. {catalog.stale?'Cached data; refresh temporarily unavailable. ':''}Updated {new Date(catalog.fetchedAt).toLocaleString()}. <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer">Compare on OpenRouter ↗</a></p>
    </>}
    {selectedModel&&<div className="model-summary"><strong>{selectedModel.name}</strong><p>{selectedModel.description}</p><p><b>Useful for:</b> tool-based agents{selectedModel.vision?', image analysis':''}{selectedModel.reasoning?', reasoning tasks':''}. <b>Trade-offs:</b> {selectedModel.vision?'Image capability is advertised, not tested here.':'Cannot read images according to the catalog.'} Token prices vary by route and context; popularity does not guarantee reliable multi-step work.</p></div>}
    <div className="model-connect"><label htmlFor="custom-model-id">Exact OpenRouter model ID</label><div><input id="custom-model-id" placeholder="provider/model-name" value={selected} disabled={disabled||busy} onChange={e=>choose(e.target.value)}/><button className="dashboard-action" type="button" disabled={disabled||busy||!selected.trim()} onClick={()=>void connect()}>{busy?'Testing…':'Connect'}</button></div><small>Runs one small, billable tool-call test using this agent’s key. No chat history is sent. Passing checks connectivity, not overall model quality. Your saved model changes only after Save settings.</small></div>
    {result&&<p role="status" className="model-result">{result}</p>}
  </section>;
}
