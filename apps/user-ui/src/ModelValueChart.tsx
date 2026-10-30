import {useState} from 'react';
import type {ModelBenchmarks,OpenRouterModel} from '@nest/schemas';
import {modelPoints,representativePoints} from './model-value';
const color=(family:string)=>`hsl(${[...family].reduce((sum,char)=>sum+char.charCodeAt(0)*7,0)%360} 55% 43%)`;
export function ModelValueChart({models,benchmarks,selected,searching,disabled,onChoose}:{models:OpenRouterModel[];benchmarks:ModelBenchmarks;selected:string;searching:boolean;disabled:boolean;onChoose:(id:string)=>void}){
  const [hover,setHover]=useState('');
  const all=modelPoints(models,benchmarks),points=representativePoints(all,selected,searching);
  if(!points.length)return <p>No matching models have comparable intelligence scores. Browse the catalog below.</p>;
  const maxCost=Math.max(1,...points.map(p=>p.cost)),maxScore=Math.max(10,Math.ceil(Math.max(...points.map(p=>p.score))/10)*10);
  const x=(cost:number)=>65+Math.log1p(cost)/Math.log1p(maxCost)*450,y=(score:number)=>250-score/maxScore*210;
  const frontier=points.filter(p=>p.frontier).sort((a,b)=>a.cost-b.cost||a.score-b.score);
  const focus=points.find(p=>p.model.id===hover)||points.find(p=>p.model.id===selected);
  const leaders=new Map<string,typeof points[number]>();
  for(const point of points){const family=point.model.id.split('/')[0];if(!leaders.has(family)||leaders.get(family)!.score<point.score)leaders.set(family,point);}
  const familyNames:Record<string,string>={'z-ai':'Z.ai',moonshotai:'Kimi',qwen:'Qwen',openai:'OpenAI',anthropic:'Claude',google:'Google',deepseek:'DeepSeek'};
  const choose=(id:string)=>{if(!disabled)onChoose(id);};
  return <figure className="model-value-chart">
    <figcaption><strong>More intelligence, less cost</strong><span>Look toward the upper left. Green rings mark best-value trade-offs.</span></figcaption>
    <svg viewBox="0 0 560 310" role="group" aria-label="Model intelligence versus token price">
      <defs><linearGradient id="model-value-zone" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#22a06b" stopOpacity=".15"/><stop offset="1" stopColor="#22a06b" stopOpacity="0"/></linearGradient></defs>
      <rect x="65" y="40" width="450" height="210" fill="url(#model-value-zone)"/>
      {[0,1,2,3,4].map(i=><g key={i} aria-hidden="true"><line x1="65" x2="515" y1={y(maxScore*i/4)} y2={y(maxScore*i/4)} stroke="currentColor" opacity=".12"/><text x="55" y={y(maxScore*i/4)+4} textAnchor="end">{Math.round(maxScore*i/4)}</text><text x={65+i/4*450} y="271" textAnchor="middle">${Math.expm1(Math.log1p(maxCost)*i/4).toFixed(2)}</text></g>)}
      <text x="18" y="145" transform="rotate(-90 18 145)" textAnchor="middle">Intelligence ↑</text>
      <text x="290" y="298" textAnchor="middle">Token price → ($ / 1M, logarithmic scale)</text>
      <polyline points={frontier.map(p=>`${x(p.cost)},${y(p.score)}`).join(' ')} fill="none" stroke="#168251" strokeWidth="2" strokeDasharray="4 3"/>
      {points.map(point=><g key={point.model.id} role="button" tabIndex={disabled?-1:0} aria-disabled={disabled} aria-pressed={selected===point.model.id} aria-label={`${point.model.name}: intelligence ${point.score}, $${point.cost.toFixed(2)} per million tokens${point.frontier?', best-value trade-off':''}`} onClick={()=>choose(point.model.id)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(point.model.id);}}} onMouseEnter={()=>setHover(point.model.id)} onMouseLeave={()=>setHover('')} onFocus={()=>setHover(point.model.id)} onBlur={()=>setHover('')}>
        <title>{point.model.name} · {point.score} intelligence · ${point.cost.toFixed(2)}/1M tokens</title>
        <circle cx={x(point.cost)} cy={y(point.score)} r="13" fill="transparent"/>
        <circle cx={x(point.cost)} cy={y(point.score)} r={selected===point.model.id?8:6} fill={color(point.model.id.split('/')[0])} stroke={point.frontier?'#168251':'white'} strokeWidth={point.frontier?3:1}/>
        {selected===point.model.id&&<circle cx={x(point.cost)} cy={y(point.score)} r="11" fill="none" stroke="currentColor" strokeWidth="2"/>}
      </g>)}
    </svg>
    <div className="model-chart-families" aria-label="Provider highlights">{[...leaders].map(([family,point])=><button type="button" key={family} disabled={disabled} title={point.model.name} aria-label={`Compare ${point.model.name}`} onClick={()=>choose(point.model.id)}><i aria-hidden="true" style={{backgroundColor:color(family)}}/>{familyNames[family]??family}</button>)}</div>
    <p className="model-chart-focus" aria-live="polite">{focus?`${focus.model.name} · Intelligence ${focus.score} · $${focus.cost.toFixed(2)} / 1M tokens`:'Click a dot to compare a model, then Connect to test it.'}</p>
    <details className="model-chart-method"><summary>How this comparison works</summary><p>Price assumes equal input and output tokens. This is a token-price comparison, not an estimate of cost per task; reasoning can use more tokens. Scores describe benchmark performance, not a guarantee for your work. The green frontier compares models with scores in the current search. The default view includes each provider’s leading model and all frontier models.</p><p>Intelligence: <a href="https://artificialanalysis.ai/" target="_blank" rel="noreferrer">Artificial Analysis</a>, via <a href="https://openrouter.ai/benchmarks" target="_blank" rel="noreferrer">OpenRouter</a>. {benchmarks.asOf?`Source updated ${new Date(benchmarks.asOf).toLocaleDateString()}.`:''} Retrieved {new Date(benchmarks.fetchedAt).toLocaleDateString()}.{benchmarks.stale?' Cached scores; refresh is temporarily unavailable.':''}</p></details>
    <p className="model-source">Intelligence: <a href="https://artificialanalysis.ai/" target="_blank" rel="noreferrer">Artificial Analysis</a> · Prices: OpenRouter</p>
  </figure>;
}
