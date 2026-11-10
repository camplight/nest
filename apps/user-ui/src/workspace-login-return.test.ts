import {describe, it, expect, vi, afterEach} from 'vitest';
import {workspaceLoginDestination, rememberWorkspaceLoginReturn, consumeWorkspaceLoginReturn} from './workspace-login-return';
function storage(): Storage {
 const values = new Map<string,string>();
 return {getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,value);},removeItem:key=>{values.delete(key);},clear:()=>values.clear(),key:index=>[...values.keys()][index]??null,get length(){return values.size;}};
}
afterEach(()=>vi.useRealTimers());
describe('workspace OAuth return',()=>{
 it('restores a project, section and focused message after a root callback, once',()=>{
  const store=storage();
  rememberWorkspaceLoginReturn('/onboarding?view=projects&project=p&tab=files&message=m#focus',store);
  expect(consumeWorkspaceLoginReturn('/',store)).toBe('/?view=projects&project=p&tab=files&message=m#focus');
  expect(consumeWorkspaceLoginReturn('/',store)).toBeNull();
 });
 it('preserves channel share links',()=>{
  const store=storage();
  rememberWorkspaceLoginReturn('/?channel=c&share=test-token',store);
  expect(consumeWorkspaceLoginReturn('/',store)).toBe('/?channel=c&share=test-token');
 });
 it('does not override a new explicit destination',()=>{
  const store=storage();rememberWorkspaceLoginReturn('/?view=projects&project=old',store);
  expect(consumeWorkspaceLoginReturn('/?view=projects&project=new',store)).toBeNull();
  expect(consumeWorkspaceLoginReturn('/',store)).toBeNull();
 });
 it('expires abandoned login attempts',()=>{
  vi.useFakeTimers();const store=storage();rememberWorkspaceLoginReturn('/?channel=c',store);
  vi.advanceTimersByTime(10*60_000);
  expect(consumeWorkspaceLoginReturn('/',store)).toBeNull();
 });
 it.each(['https://evil.example/?view=projects','//evil.example/?view=projects','/\\evil.example/?view=projects','/admin/?view=projects','/%2f%2fevil.example?view=projects'])('rejects non-workspace destination %s',path=>{
  expect(workspaceLoginDestination(path)).toBeNull();
 });
 it('keeps login usable without browser storage',()=>{
  const store={getItem(){throw Error('denied');},setItem(){throw Error('denied');}} as unknown as Storage;
  expect(()=>rememberWorkspaceLoginReturn('/?channel=c',store)).not.toThrow();
  expect(consumeWorkspaceLoginReturn('/',store)).toBeNull();
 });
 it('can restore after a cancelled Google attempt and password retry',()=>{
  const store=storage();rememberWorkspaceLoginReturn('/?view=projects&project=p',store);
  expect(consumeWorkspaceLoginReturn('/?authError=google_cancelled',store)).toBe('/?view=projects&project=p');
 });
});
