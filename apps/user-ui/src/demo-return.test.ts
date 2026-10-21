import {expect,it} from 'vitest';
import {demoReturnTo} from './demo-return';
it('preserves demo paths, queries and fragments across sign-in',()=>{
  expect(demoReturnTo('?returnTo='+encodeURIComponent('/demo/example?campaign=test#details'))).toBe('/demo/example?campaign=test#details');
  expect(demoReturnTo('?returnTo=%2Fdemo%2Fexample','#details')).toBe('/demo/example#details');
});
it('rejects external and non-demo redirects',()=>{
  for(const value of ['', 'https://evil.example/demo/x', '//evil.example/demo/x','/admin/','/demo/../api/secrets','/demo/%2e%2e/api/secrets','/demo/\\evil.example','/demo/\nanything']) {
    expect(demoReturnTo('?returnTo='+encodeURIComponent(value))).toBeNull();
  }
});

import {afterEach,vi} from 'vitest';
import {rememberDemoReturnTo,pendingDemoReturnTo,clearDemoReturnTo} from './demo-return';
afterEach(()=>vi.unstubAllGlobals());
it('keeps OAuth destinations only for this tab, clears after use and expires abandoned returns',()=>{
  const values=new Map<string,string>();
  vi.stubGlobal('window',{sessionStorage:{setItem:(k:string,v:string)=>values.set(k,v),getItem:(k:string)=>values.get(k)??null,removeItem:(k:string)=>values.delete(k)}});
  rememberDemoReturnTo('/demo/example?campaign=test#details');
  expect(pendingDemoReturnTo()).toBe('/demo/example?campaign=test#details');
  clearDemoReturnTo();expect(pendingDemoReturnTo()).toBeNull();
  rememberDemoReturnTo('//evil.example');expect(pendingDemoReturnTo()).toBeNull();
  values.set('nest-demo-login-return',JSON.stringify({path:'/demo/example',expires:0}));
  expect(pendingDemoReturnTo()).toBeNull();expect(values.size).toBe(0);
});
