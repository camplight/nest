import {expect,it,vi} from 'vitest';
import {createTaskClassifier} from './task-classifier';
const input={text:'Plan a database migration with rollback',attachmentTypes:['image/png']};
const response=(choice:string,confidence=0.95)=>Response.json({answers:{complexity:{type:'choice',choice,confidence}}});
it('uses typed Jev decisions with bounded context and no executable model choice',async()=>{
 const transport=vi.fn(async()=>response('complex'));
 const classify=createTaskClassifier({env:{OPENROUTER_API_KEY:'fixture'},transport:transport as typeof fetch});
 expect(await classify({...input,text:'x'.repeat(10000)})).toEqual({tier:'complex',reason:'classified',confidence:0.95});
 const [url,request]=transport.mock.calls[0] as unknown as [string,RequestInit];
 expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
 const body=JSON.parse(request.body as string);
 expect(JSON.parse(body.state).task).toHaveLength(8000);
 expect(JSON.parse(body.state).attachmentTypes).toEqual(['image/png']);
 expect(body.questions.complexity.criteria.complex).toContain('planning');
});
it('keeps ordinary work available on timeout, refusal, invalid tier or low confidence',async()=>{
 for(const value of [response('complex',0.3),response('uncertain'),response('arbitrary/model'),Response.json({answers:{complexity:{type:'refusal'}}}),new Response('',{status:503})]){
  expect((await createTaskClassifier({env:{OPENROUTER_API_KEY:'fixture'},transport:(async()=>value) as typeof fetch})(input)).tier).toBe('default');
 }
 const transport=vi.fn(()=>new Promise<Response>(()=>{}));
 expect(await createTaskClassifier({env:{OPENROUTER_API_KEY:'fixture'},transport:transport as typeof fetch,timeoutMs:10})(input)).toEqual({tier:'default',reason:'unavailable'});
 const key=()=>new Promise<string>(()=>{});
 expect((await createTaskClassifier({key,timeoutMs:10})(input)).tier).toBe('default');
});
it('does not call a provider without credentials or when disabled',async()=>{
 const transport=vi.fn();
 for(const env of [{},{NEST_TASK_CLASSIFIER:'off',OPENROUTER_API_KEY:'fixture'}])
  expect((await createTaskClassifier({env,transport})(input)).tier).toBe('default');
 expect(transport).not.toHaveBeenCalled();
});
