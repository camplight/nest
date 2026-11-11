import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ChatDigest,RunNowButton,agentLine,digestItem} from './ChatDigest';
import type {NeedsItem} from './needs';

const item=(kind:NeedsItem['kind'],short:string,at:number,gate?:NeedsItem['gate']):NeedsItem=>({key:`${kind}:${at}`,kind,channelId:'c1',chatTitle:'Weekly metrics',detail:short,at,from:'Pip',short,reason:short,...(gate?{gate}:{})});
const mention=item('mention','mate: ping',9);
const approval=item('approval','Approve hand-off to Blog post',5,{kind:'approval',deliveryId:'d1',linkId:'l1'});
const review=item('review','Review Launch copy',4,{kind:'review',projectId:'p1',taskId:'t1'});
const paused=item('paused','Hand-off to Blog post paused · hit 20 an hour',8,{kind:'paused',linkId:'l1'});
// Task 10 fills missed runs in; this fixture is the shape GET /api/flows/needs will serve.
const missed=item('missed','Missed run · runner offline',3,{kind:'missed',scheduleId:'s1',runId:'r1'});
const noop=async()=>{};
const render=(items:NeedsItem[],line:string|null='Pip: drafting the outline.')=>renderToStaticMarkup(<ChatDigest items={items} agentLine={line} onApprove={noop} onRequestChanges={()=>{}} onRunNow={noop}/>);

describe('ChatDigest',()=>{
  it('renders nothing when nothing here waits on the person: no items, a mention, a paused link',()=>{
    expect(render([])).toBe('');
    expect(render([mention,paused])).toBe('');
  });
  it('shows the newest approval, review or missed run, newest first past mentions and paused links',()=>{
    expect(digestItem([mention,paused,approval,review])).toBe(approval);
    expect(digestItem([review,missed])).toBe(review);
  });
  it('an approval: the mock\'s digest with the agent line, the reason, Approve and Request changes',()=>{
    expect(render([mention,approval])).toBe('<div class="digest" role="region" aria-label="Where it stands"><b>Where it stands</b>Pip: drafting the outline.'
      +'<div class="wy">Waiting on you: Approve hand-off to Blog post</div>'
      +'<div class="gate"><button type="button" class="btn pri">Approve</button><button type="button" class="btn">Request changes</button></div></div>');
    expect(render([review],null)).toContain('<b>Where it stands</b><div class="wy">Waiting on you: Review Launch copy</div><div class="gate">');
  });
  it('says what waits but offers no buttons when the server would refuse this person (a review of someone else\'s project)',()=>{
    const html=renderToStaticMarkup(<ChatDigest items={[review]} agentLine={null} onApprove={noop} onRequestChanges={()=>{}} onRunNow={noop} canDecide={i=>i.kind!=='review'}/>);
    expect(html).toContain('Waiting on you: Review Launch copy');
    expect(html).not.toContain('<button');
  });
  it('a missed run: Waiting on you: Missed run · {reason}, with one Run now and no Approve',()=>{
    const html=render([missed]);
    expect(html).toContain('<div class="wy">Waiting on you: Missed run · runner offline</div>');
    expect(html).toContain('<div class="gate"><button type="button" class="btn">Run now</button></div>');
    expect(html).not.toContain('Approve');
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});

describe('RunNowButton',()=>{
  it('in a Needs you list, names the chat it runs in',()=>{
    expect(renderToStaticMarkup(<RunNowButton item={missed} onRunNow={noop} className="canvas-needs-run" named/>))
      .toBe('<button type="button" class="canvas-needs-run" aria-label="Run now: Weekly metrics">Run now</button>');
  });
});

describe('agentLine',()=>{
  it('is `{agent}: {activity}.` from the first agent row, without a doubled full stop, and absent without an agent',()=>{
    expect(agentLine({label:'Pip',text:'drafting the outline'})).toBe('Pip: drafting the outline.');
    expect(agentLine({label:'Pip',text:'Done.'})).toBe('Pip: Done.');
    expect(agentLine(undefined)).toBeNull();
  });
});
