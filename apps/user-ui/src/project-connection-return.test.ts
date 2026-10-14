import {afterEach,expect,it,vi} from 'vitest';
import {rememberConnectionReturn,consumeConnectionReturn} from './project-connection-return';
import type {Project} from '@nest/schemas';
afterEach(()=>vi.unstubAllGlobals());
it('returns only the same signed-in owner to a currently accessible project and preserves explicit links',()=>{
  let value:string|null=null;vi.stubGlobal('sessionStorage',{getItem:()=>value,setItem:(_key:string,next:string)=>{value=next;},removeItem:()=>{value=null;}});
  const project={id:'project'} as Project;
  const callback=new URL('https://nest.example/?status=success&connected_account_id=fixture');
  rememberConnectionReturn('one','project');expect(consumeConnectionReturn('two',[project],callback)).toBeNull();
  expect(consumeConnectionReturn('one',[],callback)).toBeNull();
  rememberConnectionReturn('one','project');expect(consumeConnectionReturn('one',[project],new URL(callback+'&channel=private-chat'))).toBeNull();
  expect(consumeConnectionReturn('one',[project],callback)).toEqual(project);expect(consumeConnectionReturn('one',[project],callback)).toBeNull();
});
