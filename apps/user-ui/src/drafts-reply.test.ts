import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {loadChatDraft,saveChatDraft,type ChatDraft} from './drafts';
const data=new Map<string,string>();
beforeEach(()=>{data.clear();vi.stubGlobal('localStorage',{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value),removeItem:(key:string)=>data.delete(key),key:(index:number)=>[...data.keys()][index]??null,get length(){return data.size;}});});
afterEach(()=>vi.unstubAllGlobals());
const empty={text:'',mentions:[],attachments:[]};
it('round-trips a reply target with the draft',()=>{
  const value={text:'> quoted\n\nmy answer',mentions:[],attachments:[],replyTo:{eventId:'event-1',author:'owner',excerpt:'quoted'}} as ChatDraft;
  expect(saveChatDraft('one','room',value)).toBe(true);
  expect(loadChatDraft('one','room')).toEqual(value);
});
it('accepts a 500-character excerpt',()=>{
  const value={text:'reply',mentions:[],attachments:[],replyTo:{eventId:'event-1',author:'owner',excerpt:'x'.repeat(500)}} as ChatDraft;
  expect(saveChatDraft('one','room',value)).toBe(true);
  expect(loadChatDraft('one','room')).toEqual(value);
});
it('rejects a 501-character excerpt and loads the empty draft',()=>{
  const value={text:'reply',mentions:[],attachments:[],replyTo:{eventId:'event-1',author:'owner',excerpt:'x'.repeat(501)}} as ChatDraft;
  expect(saveChatDraft('one','room',value)).toBe(false);
  expect(loadChatDraft('one','room')).toEqual(empty);
  data.set('nest:draft:one:room',JSON.stringify(value));
  expect(loadChatDraft('one','room')).toEqual(empty);
});
it('rejects a reply target missing its author',()=>{
  data.set('nest:draft:one:room',JSON.stringify({text:'reply',mentions:[],attachments:[],replyTo:{eventId:'event-1',excerpt:'quoted'}}));
  expect(loadChatDraft('one','room')).toEqual(empty);
});
