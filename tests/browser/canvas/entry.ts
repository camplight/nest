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
  await page.getByText('This canvas is not available',{exact:false}).waitFor();
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
