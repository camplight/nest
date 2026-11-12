import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {BoardCard} from '@nest/schemas';
import {Card} from './Card';
import type {CardPulse} from './pulse';
import type {NeedsItem} from './needs';
import type {ScheduleJob} from './schedule-jobs';

const base={canvasId:'cv',channelId:'c1',x:0,y:0,w:280,version:0,placedBy:'h',placedAt:0};
// A pulse and Needs you items full of chat content: none of it may reach a card the person cannot read.
const pulse:CardPulse={
  agents:[{name:'Pip',state:'done',since:1,said:'Secret draft is ready',activity:'Reading secret notes'}],
  people:[{name:'mate',at:1,said:'Secret plan attached',files:0}],
  lastActivityAt:null,artifacts:[{fileId:'f1',name:'secret.pdf'}] as CardPulse['artifacts'],fileCount:1,
  needsYou:[{kind:'mention',id:'m1',at:1,sender:'mate',text:'Secret question'}],apps:{apps:[],reads:0,changes:0},
};
const needs:NeedsItem[]=[{key:'mention:m1',kind:'mention',channelId:'c1',chatTitle:'x',detail:'mate: Secret question',at:1,from:'mate',short:'mate: Secret question',reason:'Secret question',canOpen:true}];
const render=(card:BoardCard)=>renderToStaticMarkup(<Card card={card} draggable dx={0} dy={0} dragging={false} measure={()=>{}} pulse={pulse} needs={needs} viewer="me"
  onOpen={()=>{}} onRemove={()=>{}} onNudge={async()=>{}}/>);

describe('Card',()=>{
  it('shows a locked or unavailable card without participant rows, Needs you or any message text',()=>{
    for(const card of [{...base,access:'locked',ownerLabel:'demo-owner'},{...base,access:'unavailable'}] as BoardCard[]){
      const html=render(card);
      expect(html).not.toContain('canvas-card-rows');
      expect(html).not.toContain('canvas-card-need');
      expect(html).not.toContain('needs-you');
      expect(html).not.toMatch(/secret/i);
      expect(html).toContain('Remove from canvas');
    }
    expect(render({...base,access:'locked',ownerLabel:'demo-owner'} as BoardCard)).toContain('Owner: demo-owner');
  });
  it('shows an open card\'s rows and Needs you pill (the control for the test above)',()=>{
    const html=render({...base,access:'open',title:'Launch',canManage:true,archived:false,projectId:null,participants:[{subscriberType:'AGENT',subscriberId:'Pip'},{subscriberType:'HUMAN',subscriberId:'mate'}]} as BoardCard);
    expect(html).toContain('canvas-card-rows');
    expect(html).toContain('canvas-card-need');
    expect(html).toContain('Secret question');
  });
  it('shows the mock\'s schedule badge under the last activity: missed first, then the first live job, with +N',()=>{
    const open={...base,access:'open',title:'Recap',canManage:true,archived:false,projectId:null,participants:[],forkOf:null} as BoardCard;
    const job={key:'s1',channelId:'c1',agent:'Pip',text:'Every Monday, Wednesday at 09:00',short:'Mon Wed 09:00',setBy:null,on:true,next:1,tz:'UTC',missed:null,lastOk:null,schedule:null};
    const html=(schedules:ScheduleJob[])=>renderToStaticMarkup(<Card card={open} draggable dx={0} dy={0} dragging={false} measure={()=>{}} schedules={schedules}/>);
    expect(html([job])).toMatch(/<span class="canvas-card-meta"><span class="sch" title="Every Monday, Wednesday at 09:00"><svg[^>]*>.*<\/svg>Mon Wed 09:00<\/span><\/span>/);
    expect(html([{...job,on:false},{...job,key:'s2',missed:{at:'Mon 09:00',reason:'agent stopped'}}])).toContain('<span class="sch missed" title="Every Monday, Wednesday at 09:00 (+1 more)">');
    expect(html([{...job,on:false}])).toContain('class="sch off"');
    expect(html([])).not.toContain('canvas-card-meta');
  });
  it('says which chat a fork came from, under the title (the mock\'s c-fork)',()=>{
    const open={...base,access:'open',title:'Fork: Agreed on more data',canManage:true,archived:false,projectId:null,participants:[]};
    expect(render({...open,forkOf:{channelId:'c0',title:'Pricing'}} as BoardCard)).toMatch(/<p class="c-fork"><svg[^>]*>.*<\/svg>fork of Pricing<\/p>/);
    expect(render({...open,forkOf:null} as BoardCard)).not.toContain('c-fork');
  });
});
