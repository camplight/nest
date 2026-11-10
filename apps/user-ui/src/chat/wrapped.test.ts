import {expect,it} from 'vitest';
import {unseenAppAgents} from './wrapped';
const agent=(id:string)=>({subscriberType:'AGENT',subscriberId:id});
it('lists wrapped agents and agents whose mode is unknown, never known classic ones or humans',()=>{
 const agents=[{name:'Pip',mode:'CLASSIC' as const},{name:'Wren',mode:'WRAPPED' as const}];
 expect(unseenAppAgents([agent('Pip')],agents)).toEqual([]);
 expect(unseenAppAgents([agent('Pip'),agent('Wren')],agents)).toEqual(['Wren']);
 expect(unseenAppAgents([{subscriberType:'HUMAN',subscriberId:'me'}],agents)).toEqual([]);
});
it('counts an agent that is not in the list (not loaded, or not visible) as unseen',()=>{
 expect(unseenAppAgents([agent('Pip')],[])).toEqual(['Pip']);
 expect(unseenAppAgents([agent('Ghost')],[{name:'Pip',mode:'CLASSIC'}])).toEqual(['Ghost']);
 expect(unseenAppAgents([agent('Old')],[{name:'Old'}])).toEqual(['Old']);
});
