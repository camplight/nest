import {ModelValueChart} from './ModelValueChart';
import {useEffect,useState,useRef} from 'react';
import type {ModelBenchmarks,OpenRouterCatalog,OpenRouterModel} from '@nest/schemas';
import {apiJson,getApiHeaders} from './api';
import './model-picker.css';

const logos:Record<string,string>={openai:'openai',anthropic:'anthropic',google:'google',moonshotai:'moonshot',qwen:'qwen',deepseek:'deepseek',minimax:'minimax','z-ai':'zai',tencent:'tencent'};
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
  const [selected,setSelected]=useState(value.replace(/^openrouter:/,''));
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState('');
  const checkedReference=useRef('');
  useEffect(()=>{setSelected(value.replace(/^openrouter:/,''));if(checkedReference.current!==value)setResult('');},[value]);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();setError('');
    void apiJson<OpenRouterCatalog>('/api/openrouter-models',{signal:controller.signal}).then(value=>{if(!value||!Array.isArray(value.models))throw Error('OpenRouter catalog unavailable. Enter an exact model ID below.');setCatalog(value);}).catch(e=>{if(!controller.signal.aborted)setError(message(e));});
    return ()=>controller.abort();
  },[attempt,open]);
  useEffect(()=>{
    if(!open||disabled)return;
    const controller=new AbortController();setBenchmarkError('');
    void apiJson<ModelBenchmarks>(`/api/agents/${encodeURIComponent(agentName)}/model-benchmarks`,{signal:controller.signal}).then(data=>{
      if(!Array.isArray(data?.models))throw Error('Intelligence scores are unavailable.');
      setBenchmarks(data);
    }).catch(()=>{if(!controller.signal.aborted)setBenchmarkError('Intelligence scores are unavailable. You can still compare prices below.');});
    return ()=>controller.abort();
  },[open,agentName,attempt,disabled]);
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
      checkedReference.current=checked.reference;
      onChange(checked.reference);
      setResult(`Tool-call check passed in ${(checked.latencyMs/1000).toFixed(1)}s. Save settings to use this model on the next turn.`);
    }catch(e){setResult(message(e));}finally{setBusy(false);}
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
  return <details className="model-picker" open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary className="model-picker-toggle"><span><strong>Explore OpenRouter models</strong><small>{current?.name || value || 'Choose a model'}</small></span><span className="model-picker-chevron" aria-hidden="true">⌄</span></summary>
    <div className="model-picker-content" aria-label="OpenRouter model picker">
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
    <div className="model-connect"><label htmlFor="custom-model-id">Exact OpenRouter model ID</label><div><input id="custom-model-id" placeholder="provider/model-name" value={selected} disabled={disabled||busy} onChange={e=>choose(e.target.value)}/><button className="dashboard-action" type="button" disabled={disabled||busy||!selected.trim()} onClick={()=>void connect()}>{busy?'Testing…':'Connect'}</button></div><small>Tests a tool call using this agent’s key (small usage charge). Save settings to apply.</small></div>
    {result&&<p role="status" className="model-result">{result}</p>}
    </div>
  </details>;
}
