import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AppTriggerType} from '@nest/schemas';
import {AppTriggerFields} from './AppTriggerFields';

const types:AppTriggerType[]=[
  {slug:'GITHUB_COMMIT_EVENT',name:'Commit',description:'A commit lands',config:{type:'object',required:['repo'],properties:{repo:{type:'string'},draft:{type:'boolean'},state:{type:'string',enum:['open','closed']},extra:{type:'object'}}}},
  {slug:'GITHUB_STAR_EVENT',name:'Star',description:'',config:{}},
];
const noop=()=>{};
const render=(p:Partial<Parameters<typeof AppTriggerFields>[0]>)=>renderToStaticMarkup(<AppTriggerFields apps={['github','slack']} app="" types={null} typesError={null} slug="" values={{}}
  onApp={noop} onSlug={noop} onValues={noop} {...p}/>);

describe('AppTriggerFields',()=>{
  it('offers the connected apps first and nothing else until one is picked',()=>{
    const html=render({});
    expect(html).toContain('aria-label="App"');
    expect(html).toContain('>github<');
    expect(html).toContain('>slack<');
    expect(html).not.toContain('aria-label="Event"');
  });
  it('says so when no app is connected',()=>{
    expect(render({apps:[]})).toContain('Connect an app first');
    expect(render({apps:null})).toContain('Loading your apps');
  });
  it('then offers the app\'s event types, and the picked type\'s fields with required ones marked',()=>{
    const html=render({app:'github',types,slug:'GITHUB_COMMIT_EVENT',values:{repo:'',draft:false,state:'open',extra:'{}'}});
    expect(html).toContain('aria-label="Event"');
    expect(html).toContain('>Commit<');
    expect(html).toContain('A commit lands');
    expect(html).toContain('Repo *');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<option value="closed">closed</option>');
    expect(html).toContain('<textarea');
  });
  it('shows a Choose placeholder while a required enum is unset, so the select matches its state',()=>{
    const t:AppTriggerType[]=[{slug:'X',name:'X',description:'',config:{required:['state'],properties:{state:{type:'string',enum:['open','closed']}}}}];
    const unset=render({app:'github',types:t,slug:'X',values:{state:''}});
    expect(unset).toMatch(/<option value="" disabled[^>]*>Choose…<\/option>/);
    expect(render({app:'github',types:t,slug:'X',values:{state:'open'}})).not.toContain('Choose…');
  });
  it('shows a failure to read the types inline',()=>{
    expect(render({app:'github',typesError:'Composio is unavailable'})).toContain('Composio is unavailable');
  });
});
