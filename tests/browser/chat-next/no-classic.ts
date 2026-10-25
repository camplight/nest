// No classic chat (Task 18, spec 10): the switch, the classic list helpers and the kit preview are gone.
// Run with VITE_NEST_CHAT_UI unset. Carries over the dark-token check from the deleted ui-kit.ts. Synthetic data.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {agentName,runChatTest} from '../support/chat-harness';

const repo=fileURLToPath(new URL('../../..',import.meta.url));

// git grep exits 1 with no output when nothing matches: that is the pass. Exit 0 fails with the matches.
function noMatches(pattern:string,path:string){
  let out='';
  try{out=execFileSync('git',['-C',repo,'grep','-nE',pattern,'--',path],{encoding:'utf8'});}
  catch(error){
    const e=error as {status?:number;stdout?:string;stderr?:string};
    if(e.status===1&&!e.stdout)return;
    throw new Error(`git grep failed (exit ${e.status}): ${e.stderr??''}`);
  }
  assert.fail(`git grep -nE "${pattern}" ${path} matched:\n${out}`);
}

await runChatTest('no classic: ?chatUi=classic renders the new chat',async h=>{
  const {page,base}=h;
  await page.goto(`${base}/?chatUi=classic&view=projects&project=${h.project.id}`);
  await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  await page.locator('.messages-panel').first().waitFor();
  assert.equal(await page.locator('.nest-chat').count(),1,'?chatUi=classic renders .nest-chat');

  noMatches('chatUi|VITE_NEST_CHAT_UI|preview=chat-kit','apps/user-ui/src');
  noMatches('function (messageText|shouldRenderMarkdown|parseMessageAttachments)','apps/user-ui/src/App.tsx');
},{chatUi:'classic'});

await runChatTest('no classic: chat bg-card follows data-theme=dark',async h=>{
  const {page}=h;
  await page.locator('.messages-panel').first().waitFor();
  const m=await h.emit('message.created',{text:'Synthetic code\n\n```ts\nconst greeting = "dark";\n```',targetAgentName:agentName},{source:'human:demo-owner'});
  const surface=page.locator(`#message-${m.id} pre.bg-card`).first();
  await surface.waitFor();
  const light=await surface.evaluate(el=>getComputedStyle(el).backgroundColor);
  await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));
  const expected=await page.evaluate(()=>{
    const probe=document.createElement('div');probe.style.backgroundColor=getComputedStyle(document.documentElement).getPropertyValue('--nest-surface').trim();
    document.body.append(probe);const value=getComputedStyle(probe).backgroundColor;probe.remove();return value;
  });
  const dark=await surface.evaluate(el=>getComputedStyle(el).backgroundColor);
  assert.notEqual(dark,light,'bg-card changes with data-theme=dark under a light OS scheme');
  assert.equal(dark,expected,'bg-card computes to the dark --nest-surface value');
},{colorScheme:'light'});
