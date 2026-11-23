import {describe,expect,it} from 'vitest';
import {formatAttachmentSize} from './attachments';

describe('attachment sizes',()=>{
  it('reads as bytes, KB with one decimal, or MB',()=>{
    expect(formatAttachmentSize(512)).toBe('512 B');
    expect(formatAttachmentSize(5*1024)).toBe('5.0 KB');
    expect(formatAttachmentSize(Math.round(51.2*1024))).toBe('51.2 KB');
    expect(formatAttachmentSize(300*1024)).toBe('300 KB');
    expect(formatAttachmentSize(Math.round(1.2*1024*1024))).toBe('1.2 MB');
  });
  it('is absent when the size is unknown or empty',()=>{
    for(const size of [undefined,0,-1,Number.NaN,Number.POSITIVE_INFINITY])expect(formatAttachmentSize(size)).toBeNull();
  });
});
