import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {AddAgentPicker,filterAgents} from './AddAgentPicker';
import type {Agent} from '../types';

const agent=(name:string,description?:string):Agent=>({name,ownerHumanId:'h1',visibility:'PUBLIC',...(description?{description}:{})});
const agents=[agent('Moss','Research'),agent('Pip'),agent('Ash')];

describe('AddAgentPicker',()=>{
  it('lists the tray agents',()=>{
    const html=renderToStaticMarkup(<AddAgentPicker agents={agents} members={[]} onPick={()=>{}} onClose={()=>{}}/>);
    for(const name of ['Moss','Pip','Ash']) expect(html).toContain(name);
    expect(html).not.toContain('In this chat');
  });
  it('marks members as In this chat and disabled',()=>{
    const html=renderToStaticMarkup(<AddAgentPicker agents={agents} members={['Pip']} onPick={()=>{}} onClose={()=>{}}/>);
    expect(html).toContain('In this chat');
    expect(html.match(/disabled=""/g)).toHaveLength(1);
  });
  it('filters case-insensitively by name or role',()=>{
    expect(filterAgents(agents,'mO').map(a=>a.name)).toEqual(['Moss']);
    expect(filterAgents(agents,'research').map(a=>a.name)).toEqual(['Moss']);
    expect(filterAgents(agents,'  ').map(a=>a.name)).toEqual(['Moss','Pip','Ash']);
  });
});
