import {describe,expect,it} from 'vitest';
import {ApiError,readableError} from './api';

describe('readableError',()=>{
  it('shows the error a JSON body carries, not the raw body',()=>{
    expect(readableError(new ApiError('{"error":"Forbidden"}',403),'Unable to archive the chat')).toBe('Forbidden');
  });
  it('keeps a plain-text message and falls back for anything else',()=>{
    expect(readableError(new ApiError('Engine down',502),'x')).toBe('Engine down');
    expect(readableError('nope','Unable to archive the chat')).toBe('Unable to archive the chat');
    expect(readableError(new ApiError('{"other":1}',500),'Unable to archive the chat')).toBe('Unable to archive the chat');
  });
});
