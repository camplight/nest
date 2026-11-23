import {describe,expect,it} from 'vitest';
import {tapToggle} from './tap-card';

describe('tapToggle',()=>{
 it('opens a closed card on a touch tap and closes an open one',()=>{
  expect(tapToggle('touch',false)).toBe(true);
  expect(tapToggle('touch',true)).toBe(false);
 });
 it('leaves mouse and pen clicks to hover and focus',()=>{
  expect(tapToggle('mouse',false)).toBeNull();
  expect(tapToggle('pen',true)).toBeNull();
  expect(tapToggle(null,false)).toBeNull();
 });
});
