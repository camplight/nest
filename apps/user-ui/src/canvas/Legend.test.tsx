import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {Legend} from './Legend';
import {TRAY_PINNED,TRAY_SUGGESTED,trayHeading} from './AgentTray';

describe('Legend',()=>{
  const html=renderToStaticMarkup(<Legend heading="Pinned"/>);
  it('names the three statuses',()=>{
    expect(html).toContain('aria-label="Legend"');
    for(const label of ['working','waiting on you','gone quiet']) expect(html).toContain(label);
  });
  it('hints with whichever tray heading is visible',()=>{
    expect(renderToStaticMarkup(<Legend heading={trayHeading(true)}/>)).toContain(`Drag an agent from ${TRAY_SUGGESTED} onto a chat`);
    expect(renderToStaticMarkup(<Legend heading={trayHeading(false)}/>)).toContain(`Drag an agent from ${TRAY_PINNED} onto a chat`);
    expect(html).not.toContain(TRAY_SUGGESTED);
  });
});
