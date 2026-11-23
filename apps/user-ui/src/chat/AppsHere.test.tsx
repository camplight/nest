import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {AppsHere} from './AppsHere';
import type {AppCall} from '../app-activity';

const call=(id:string,app:string,appName:string):AppCall=>({id,channelId:'c1',agent:'Pip',at:1,app,appName,action:'x',kind:'read',label:null,state:'done'});
const calls=[call('1','github','GitHub'),call('2','slack','Slack')];

describe('AppsHere filter',()=>{
  it('renders chips as aria-pressed toggles',()=>{
    const html=renderToStaticMarkup(<AppsHere calls={calls} wrappedAgents={[]} selected="github" onSelect={()=>{}}/>);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>(?:(?!<\/button>).)*GitHub/s);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>(?:(?!<\/button>).)*Slack/s);
  });
  it('shows the Showing only bar with Show all while one is active',()=>{
    const html=renderToStaticMarkup(<AppsHere calls={calls} wrappedAgents={[]} selected="github" onSelect={()=>{}}/>);
    expect(html).toContain('Showing only GitHub');
    expect(html).toContain('Show all');
  });
  it('has no bar when nothing is selected, and no toggles without a handler',()=>{
    expect(renderToStaticMarkup(<AppsHere calls={calls} wrappedAgents={[]} selected={null} onSelect={()=>{}}/>)).not.toContain('Show all');
    expect(renderToStaticMarkup(<AppsHere calls={calls} wrappedAgents={[]}/>)).not.toContain('aria-pressed');
  });
});
