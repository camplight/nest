import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {Legend} from './Legend';
import {TRAY_HEADING} from './AgentTray';

describe('Legend',()=>{
  const html=renderToStaticMarkup(<Legend/>);
  it('names the three statuses',()=>{
    expect(html).toContain('aria-label="Legend"');
    for(const label of ['working','waiting on you','gone quiet']) expect(html).toContain(label);
  });
  it('hints with the tray\'s real heading',()=>{
    expect(html).toContain(`Drag an agent from ${TRAY_HEADING} onto a chat`);
  });
});
