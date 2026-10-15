import {describe,it,expect} from 'vitest';
import {activity,activityDetails} from './activity';
import type {EventRow} from './types';
const event=(type:string,payload:unknown)=>({id:'fixture',type,payload,source:'agent:Demo',createdAt:1,channelId:'demo'} as EventRow);
describe('activity status meaning',()=>{
 it('distinguishes process success, failure and missing status',()=>{
  expect(activity(event('process.exited',{exitCode:0})).tone).toBe('success');
  expect(activity(event('process.exited',{exitCode:1}))).toMatchObject({tone:'danger',icon:'error'});
  expect(activity(event('process.exited',{})).tone).toBe('muted');
 });
 it('does not equate diagnostic output with a failed response',()=>{
  expect(activity(event('process.output',{stream:'STDERR',text:'warning'})).tone).toBe('muted');
 });
 it('retains original event data in technical details',()=>{
  const row=event('tool.failed',{tool:'Search',args:{query:'demo'},error:{code:'offline'}});
  expect(JSON.parse(activityDetails(row))).toEqual({event:row.type,source:row.source,payload:row.payload});
 });
});
