import {describe,expect,it} from 'vitest';
import type {BoardCard,Canvas,CanvasArea,CanvasBoard} from '@nest/schemas';
import type {LooseChat} from './loose';
import {rank,searchIndex,type SearchItem} from './search';

const item=(kind:SearchItem['kind'],id:string,label:string):SearchItem=>({kind,id,label,detail:''});
const canvas=(id:string,name:string,role:Canvas['role']='owner'):Canvas=>({id,name,role,ownerId:'h1',visibility:'private',version:1,createdAt:1,updatedAt:1} as Canvas);
const base={canvasId:'k1',x:0,y:0,w:280,version:1,placedBy:'h1',placedAt:1,ownerLabel:'demo-owner'};
const open=(channelId:string,title:string):BoardCard=>({...base,channelId,projectId:null,access:'open',title,participants:[{subscriberType:'AGENT',subscriberId:'Pip'}],archived:false,canManage:true} as BoardCard);
const area=(id:string,title:string):CanvasArea=>({id,canvasId:'k1',title,x:0,y:0,w:400,h:300,tint:'moss',version:1} as CanvasArea);
const loose=(channelId:string,title:string):LooseChat=>({channelId,projectId:null,title,participants:[],lastActivityAt:null,needsYou:false,agents:['Moss']});

describe('rank',()=>{
  it('puts prefix matches before word-start matches before substring matches',()=>{
    const items=[item('card','1','Blau'),item('card','2','Q3 launch plan'),item('card','3','Launch')];
    expect(rank(items,'lau').map(i=>i.label)).toEqual(['Launch','Q3 launch plan','Blau']);
  });
  it('returns nothing for an empty or blank query',()=>{
    expect(rank([item('card','1','Launch')],'')).toEqual([]);
    expect(rank([item('card','1','Launch')],'   ')).toEqual([]);
  });
  it('breaks ties by kind: card, area, loose, canvas, and keeps order within a kind',()=>{
    const items=[item('canvas','c','Launch c'),item('loose','l','Launch l'),item('area','a','Launch a'),item('card','x','Launch x'),item('card','y','Launch y')];
    expect(rank(items,'launch').map(i=>i.id)).toEqual(['x','y','a','l','c']);
  });
  it('ignores case, drops non-matches and honours the limit',()=>{
    const many=Array.from({length:30},(_,i)=>item('card',`${i}`,`Invoice ${i}`));
    expect(rank(many,'INVOICE')).toHaveLength(20);
    expect(rank(many,'invoice',5)).toHaveLength(5);
    expect(rank(many,'zzz')).toEqual([]);
  });
});

describe('searchIndex',()=>{
  const board=(cards:BoardCard[],areas:CanvasArea[]=[]):CanvasBoard=>({canvas:canvas('k1','Launch'),areas,cards,etag:'e'});
  it('lists open cards, areas, loose chats and canvases',()=>{
    const index=searchIndex({canvases:[canvas('k1','Launch'),canvas('k2','Ops','view')],board:board([open('c1','Invoices')],[area('a1','Billing')]),loose:[loose('l1','Old thread')]});
    expect(index.map(i=>[i.kind,i.id,i.label])).toEqual([['card','c1','Invoices'],['area','a1','Billing'],['loose','l1','Old thread'],['canvas','k1','Launch'],['canvas','k2','Ops']]);
  });
  it('never lists locked or unavailable cards',()=>{
    const cards=[open('c1','Invoices'),{...base,channelId:'c2',access:'locked',ownerLabel:'Secret plans'} as BoardCard,{...base,channelId:'c3',access:'unavailable'} as BoardCard];
    const index=searchIndex({canvases:[],board:board(cards),loose:[]});
    expect(index.map(i=>i.id)).toEqual(['c1']);
    expect(rank(index,'private')).toEqual([]);
    expect(rank(index,'secret')).toEqual([]);
  });
  it('works without a board',()=>{
    expect(searchIndex({canvases:[canvas('k1','Launch')],board:null,loose:[]}).map(i=>i.kind)).toEqual(['canvas']);
  });
});
