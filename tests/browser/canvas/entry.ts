// Canvas entry (Task 4): the flagged nav entry, first-canvas creation and URL state. Synthetic data.
import assert from 'node:assert/strict';
import {runChatTest} from '../support/chat-harness';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

await runChatTest('canvas entry: create the first canvas, reload and go back',async h=>{
  const {page,base}=h;
  const available=page.waitForResponse(response=>response.url().endsWith('/api/canvases/availability'));
  await page.goto(`${base}/?view=dashboard`);
  assert.deepEqual(await(await available).json(),{available:true});
  const nav=page.getByRole('navigation',{name:'Main navigation'});
  const entry=nav.getByRole('button',{name:'Canvas',exact:true});
  await entry.waitFor({state:'visible'});
  await entry.click();
  await page.getByRole('heading',{name:'Create your first canvas',exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('view'),'canvas');
  assert.equal(await entry.getAttribute('aria-current'),'page');

  await page.getByRole('textbox',{name:'Canvas name',exact:true}).fill('Launch');
  await page.getByRole('button',{name:'Create canvas',exact:true}).click();
  await page.waitForURL(url=>url.searchParams.get('view')==='canvas'&&uuid.test(url.searchParams.get('canvas')??''));
  const id=new URL(page.url()).searchParams.get('canvas')!;
  await page.locator('.canvas-name').getByText('Launch',{exact:true}).waitFor();
  await page.locator('.canvas-surface').waitFor();
  const listed=await(await fetch(`${h.apiUrl}/api/canvases`,{headers:{cookie:h.cookie}})).json() as {id:string;name:string}[];
  assert.deepEqual(listed.map(c=>[c.id,c.name]),[[id,'Launch']],'the canvas is stored in the product API');

  await page.reload();
  await page.locator('.canvas-name').getByText('Launch',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('canvas'),id,'reload keeps the canvas open');

  // Opening the view without a canvas id picks the most recent canvas and replaces the entry.
  await nav.getByRole('button',{name:'Dashboard',exact:true}).click();
  await nav.getByRole('button',{name:'Canvas',exact:true}).click();
  await page.waitForURL(url=>url.searchParams.get('canvas')===id);

  await page.goBack();
  await page.waitForURL(url=>url.searchParams.get('view')==='dashboard'&&!url.searchParams.has('canvas'));
  await nav.getByRole('button',{name:'Dashboard',exact:true}).and(page.locator('[aria-current="page"]')).waitFor();
  assert.equal(await page.locator('.canvas-surface').count(),0,'Back leaves the canvas view');

  // A canvas that does not exist, or is no longer shared, reads as gone.
  await page.goto(`${base}/?view=canvas&canvas=${crypto.randomUUID()}`);
  await page.getByText('This canvas is no longer shared with you',{exact:true}).waitFor();
},{canvas:true});

await runChatTest('canvas entry: no nav entry while the flag is off',async h=>{
  const {page,base}=h;
  const available=page.waitForResponse(response=>response.url().endsWith('/api/canvases/availability'));
  await page.goto(`${base}/?view=canvas`);
  assert.deepEqual(await(await available).json(),{available:false});
  await page.waitForURL(url=>url.searchParams.get('view')!=='canvas');
  const nav=page.getByRole('navigation',{name:'Main navigation'});
  await nav.getByRole('button',{name:'Dashboard',exact:true}).waitFor();
  assert.equal(await nav.getByRole('button',{name:'Canvas',exact:true}).count(),0);
  assert.equal(await page.locator('.canvas-surface').count(),0);
},{canvas:false});

await runChatTest('canvas entry: the canvas starts with an icon sidebar, other views start full, and each choice is remembered',async h=>{
  const {page,base}=h;
  await page.setViewportSize({width:1440,height:900});
  const nav=page.getByRole('navigation',{name:'Main navigation'});
  const sidebar=page.locator('aside.sidebar');
  const width=async()=>(await sidebar.boundingBox())!.width;

  // Other views start with the full sidebar. The agent list hides with the Agents button and stays hidden.
  await page.goto(`${base}/?view=dashboard`);
  await page.getByRole('button',{name:'Collapse sidebar',exact:true}).waitFor();
  const wide=await width();
  assert.ok(wide>200,`the dashboard sidebar is full width (${wide})`);
  const agents=nav.getByRole('button',{name:'Agents',exact:true});
  assert.equal(await agents.getAttribute('aria-expanded'),'true');
  await agents.click();
  assert.equal(await agents.getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('#agent-shortcuts').count(),0,'the agent list is hidden');
  await page.reload();
  await page.getByRole('button',{name:'Collapse sidebar',exact:true}).waitFor();
  assert.equal(await agents.getAttribute('aria-expanded'),'false','the hidden agent list is remembered');

  // The canvas starts as an icon rail: same accessible names, a tooltip each, and the canvas gets the room.
  await nav.getByRole('button',{name:'Canvas',exact:true}).click();
  const expand=page.getByRole('button',{name:'Expand sidebar',exact:true});
  await expand.waitFor();
  assert.equal(await expand.getAttribute('aria-expanded'),'false');
  const narrow=await width();
  assert.ok(narrow<=72,`the canvas sidebar is an icon rail (${narrow})`);
  for(const name of ['Dashboard','Canvas','Projects','Agents','Community']){
    const button=nav.getByRole('button',{name,exact:true});
    assert.equal(await button.getAttribute('title'),name,`${name} has a tooltip`);
    assert.ok(((await button.boundingBox())!.width)<=narrow,`${name} fits the rail`);
  }

  // Expanding on the canvas is remembered for the canvas, and leaves other views alone.
  await expand.click();
  await page.getByRole('button',{name:'Collapse sidebar',exact:true}).waitFor();
  assert.ok(await width()>200,'the canvas sidebar expands');
  await page.reload();
  await page.getByRole('button',{name:'Collapse sidebar',exact:true}).waitFor();
  assert.ok(await width()>200,'the expanded canvas sidebar is remembered');
  await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
  await expand.waitFor();

  // Collapsing elsewhere is a separate choice; the rail's Agents button opens the agents page.
  await nav.getByRole('button',{name:'Dashboard',exact:true}).click();
  await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
  await page.reload();
  await expand.waitFor();
  assert.ok(await width()<=72,'the collapsed dashboard sidebar is remembered');
  await nav.getByRole('button',{name:'Agents',exact:true}).click();
  await page.waitForURL(url=>url.searchParams.get('view')==='agents');

  // Phones keep the slide-in menu and never show the collapse control.
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.getByRole('button',{name:/^(Collapse|Expand) sidebar$/}).isVisible(),false);
},{canvas:true});
