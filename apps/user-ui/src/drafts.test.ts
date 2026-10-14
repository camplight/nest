import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {loadChatDraft,saveChatDraft,clearSentDraft,clearOwnerDrafts,rememberProject,recentProject,type ChatDraft} from './drafts';
const data=new Map<string,string>();
beforeEach(()=>{data.clear();vi.stubGlobal('localStorage',{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value),removeItem:(key:string)=>data.delete(key),key:(index:number)=>[...data.keys()][index]??null,get length(){return data.size;}});});
afterEach(()=>vi.unstubAllGlobals());
it('isolates owner/channel drafts and removes only the matching confirmed send',()=>{
  const value:ChatDraft={text:'My next message',mentions:[],attachments:[{fileId:'uploaded',name:'brief.txt'}],request:{id:'8f575963-f5ed-45e5-aeed-931ed1c6c38d',fingerprint:'saved send'}};
  expect(saveChatDraft('one','room',value)).toBe(true);
  expect(loadChatDraft('two','room').text).toBe('');expect(loadChatDraft('one','other').text).toBe('');
  expect(loadChatDraft('one','room')).toEqual(value);
  const changed={...value,text:'A newer draft'};saveChatDraft('one','room',changed);clearSentDraft('one','room',value);
  expect(loadChatDraft('one','room').text).toBe('A newer draft');
  clearSentDraft('one','room',changed);expect(loadChatDraft('one','room').text).toBe('');
});
it('clears only the signing-out owner and tolerates corrupted or unavailable storage',()=>{
  const value={text:'private draft',mentions:[],attachments:[]};saveChatDraft('one','room',value);saveChatDraft('two','room',value);
  rememberProject('one','project');expect(recentProject('one')).toBe('project');clearOwnerDrafts('one');
  expect(loadChatDraft('one','room').text).toBe('');expect(recentProject('one')).toBeNull();expect(loadChatDraft('two','room').text).toBe('private draft');
  data.set('nest:draft:two:room','invalid');expect(loadChatDraft('two','room').text).toBe('');
  vi.stubGlobal('localStorage',{setItem(){throw Error('quota');},getItem(){throw Error('blocked');}});
  expect(saveChatDraft('one','room',value)).toBe(false);expect(loadChatDraft('one','room').text).toBe('');
});
