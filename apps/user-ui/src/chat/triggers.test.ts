import {describe,it,expect} from 'vitest';
import {findTrigger} from './triggers';

describe('findTrigger',()=>{
 it('finds an @ mention at the caret',()=>{
  expect(findTrigger('@pi',3)).toEqual({trigger:'@',start:0,end:3,query:'pi'});
 });
 it('finds a / command at the start of the draft',()=>{
  expect(findTrigger('/inv',4)).toEqual({trigger:'/',start:0,end:4,query:'inv'});
 });
 it('finds a / command at the start of a later line',()=>{
  expect(findTrigger('hello\n/fi',9)).toEqual({trigger:'/',start:6,end:9,query:'fi'});
 });
 it('ignores a / after other text on the line',()=>{
  expect(findTrigger('a /inv',6)).toBeNull();
 });
 it('ignores an @ inside an email address',()=>{
  expect(findTrigger('mail me@x',9)).toBeNull();
 });
 it('ignores triggers inside a code fence',()=>{
  expect(findTrigger('```\n/inv',8)).toBeNull();
  expect(findTrigger('```\n@pi',7)).toBeNull();
 });
});
