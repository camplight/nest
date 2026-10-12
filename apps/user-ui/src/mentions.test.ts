import {describe,it,expect} from 'vitest';
import {findMention,insertMention,mentionCandidates,rankMentions} from './mentions';
describe('inline mention completion',()=>{
 it('opens only for a mention at the caret, outside emails, URLs, code and selections',()=>{
  expect(findMention('Hello @pff',10)).toEqual({start:6,end:10,query:'pff'});
  for(const text of ['name@example.com','https://example/@name','`@name','```\n@name','hello @name finished'])expect(findMention(text,text.length)).toBeNull();
  expect(findMention('@puff',2,5)).toBeNull();
  expect(findMention('(@ки',4)?.query).toBe('ки');
 });
 it('fuzzy matches case-insensitively and ranks exact/prefix matches before subsequences',()=>{
  const candidates=mentionCandidates([{name:'PuffVitaliy'},{name:'Puff'},{name:'Moss'}],[{username:'vitaliy@example.com'}],[]);
  expect(rankMentions(candidates,'PUFF').map(c=>c.name)).toEqual(['Puff','PuffVitaliy']);
  expect(rankMentions(candidates,'pffvtly').map(c=>c.name)).toEqual(['PuffVitaliy']);
  expect(rankMentions(candidates,'vitaliy').map(c=>c.name)).toEqual(['vitaliy@example.com','PuffVitaliy']);
  expect(rankMentions(candidates,'missing')).toEqual([]);
 });
 it('deduplicates visible candidates, keeps human/agent identities separate and prioritizes members',()=>{
  const candidates=mentionCandidates([{name:'same'},{name:'same'},{name:'outsider'}],[{username:'same'}],[{subscriberType:'AGENT',subscriberId:'same'}]);
  expect(candidates).toHaveLength(3);
  expect(rankMentions(candidates,'')[0]).toMatchObject({kind:'Agent',name:'same',inConversation:true});
 });
 it('inserts at the caret without losing following text, punctuation, names with spaces or email handles',()=>{
  expect(insertMention('Hi @pu, thanks',findMention('Hi @pu, thanks',6)!,'Puff')).toEqual({value:'Hi @Puff, thanks',caret:8});
  expect(insertMention('Hi @puff later',findMention('Hi @puff later',6)!,'PuffVitaliy').value).toBe('Hi @PuffVitaliy later');
  expect(insertMention('@rd',findMention('@rd',3)!,'Research & Design').value).toBe('@Research & Design ');
  expect(insertMention('@vi',findMention('@vi',3)!,'vitaliy@example.com').value).toBe('@vitaliy@example.com ');
 });
});
