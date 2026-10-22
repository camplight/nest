import {it, expect, vi} from 'vitest';
import {createCodexOutput} from './nestsystem-bridge.mjs';

const line = event => JSON.stringify(event)+'\n';
const message = (id,text) => ({type:'item.completed',item:{id,type:'agent_message',text}});

it('publishes interim assistant text before the process closes and returns the final reply once', async()=>{
  const updates=[];
  const output=createCodexOutput({publishProgress:async item=>{updates.push(item);}});
  const input=line({type:'thread.started',thread_id:'saved-thread'})+line(message('update','Waiting for the release checks.'));
  output.write(input.slice(0,17));output.write(input.slice(17));
  output.write(line({type:'item.started',item:{id:'tool',type:'command_execution',command:'private tool arguments'}}));
  await vi.waitFor(()=>expect(updates).toEqual([{id:'update',text:'Waiting for the release checks.'}]));
  output.write(line({type:'item.completed',item:{id:'tool',type:'command_execution',aggregated_output:'private tool output'}}));
  output.write(line(message('final','Release checks passed.')));
  output.write(JSON.stringify({type:'turn.completed'}));
  expect(await output.finish()).toEqual({threadId:'saved-thread',finalText:'Release checks passed.',failure:false});
  expect(updates).toHaveLength(1);
});

it('ignores malformed lines, reasoning, tool results and repeated item completions',async()=>{
  const updates=[];
  const output=createCodexOutput({publishProgress:async item=>{updates.push(item);}});
  output.write('not json\nnull\n');
  output.write(line({type:'item.completed',item:{id:'reasoning',type:'reasoning',text:'private reasoning'}}));
  output.write(line(message('update','I am checking the result.')));
  output.write(line(message('update','I am checking the result.')));
  output.write(line(message('final','Finished.')));
  output.write(line(message('update','I am checking the result.')));
  expect((await output.finish()).finalText).toBe('Finished.');
  expect(updates).toEqual([{id:'update',text:'I am checking the result.'}]);
});

it('does not let progress transport failure lose the final reply or expose the underlying error',async()=>{
  const error=vi.fn(),publish=vi.fn(async()=>{throw Error('private credential/response');});
  const output=createCodexOutput({publishProgress:publish,onProgressError:error});
  for(const event of [message('a','Starting.'),message('b','Still working.'),message('c','Finished.')])output.write(line(event));
  expect(await output.finish()).toMatchObject({failure:false,finalText:'Finished.'});
  expect(publish).toHaveBeenCalledTimes(1);expect(error).toHaveBeenCalledExactlyOnceWith();
});

it('retains failed-turn semantics instead of turning a partial update into a successful reply',async()=>{
  const updates=[];
  const output=createCodexOutput({publishProgress:async item=>{updates.push(item);}});
  output.write(line(message('a','Working.'))+line({type:'turn.failed',error:{message:'private diagnostics'}}));
  expect(await output.finish()).toMatchObject({failure:true});
  expect(updates).toEqual([]);
});
