import {describe,expect,it} from 'vitest';
import {olderToast} from './one-toast';

describe('olderToast (one notice at a time, the newest wins)',()=>{
  const none={notice:null,member:null};
  it('clears a member notice when a new canvas notice arrives',()=>{
    expect(olderToast({notice:null,member:3},{notice:'Canvas changed. Refreshed.',member:3})).toBe('member');
  });
  it('clears the canvas notice when a new member notice arrives',()=>{
    expect(olderToast({notice:'Saved',member:null},{notice:'Saved',member:4})).toBe('notice');
  });
  it('keeps the member notice when both arrive together',()=>{
    expect(olderToast(none,{notice:'Saved',member:5})).toBe('notice');
  });
  it('does nothing when only one shows or nothing changed',()=>{
    expect(olderToast(none,{notice:'Saved',member:null})).toBeNull();
    expect(olderToast({notice:'Saved',member:2},{notice:'Saved',member:2})).toBeNull();
    expect(olderToast({notice:'Saved',member:2},{notice:null,member:2})).toBeNull();
  });
});
