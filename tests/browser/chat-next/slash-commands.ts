// Slash commands in the composer picker (Task 12, spec 7.4.1, 7.4.2, 12.5): `/` at the start of a line lists the
// commands the user may run here, `@` keeps every mention rule. Synthetic labelled data.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {runChatTest} from '../support/chat-harness';

const second='synthetic-bea';
const box=(page:Page)=>page.getByRole('textbox',{name:'Message',exact:true});
const commands=(page:Page)=>page.getByRole('listbox',{name:'Commands',exact:true});
const commandNames=async(page:Page)=>{
  await commands(page).waitFor();
  return (await commands(page).getByRole('option').allInnerTexts()).map(text=>text.match(/\b(invite|files)\b/)?.[1]??text).sort();
};
const must=async(response:Promise<Response>,what:string)=>{const result=await response;assert.equal(result.ok,true,`${what}: ${result.status}`);return result;};

await runChatTest('slash commands: owner in a project chat and a standalone channel',async h=>{
  const {page}=h;
  await box(page).fill('/');
  assert.deepEqual(await commandNames(page),['files','invite'],'a project owner gets invite and files');

  // invite opens the invite picker (the participants dialog) and clears the command text.
  await box(page).fill('/inv');
  assert.deepEqual(await commandNames(page),['invite']);
  await box(page).press('Enter');
  await page.getByRole('dialog').getByRole('heading',{name:'Manage participants'}).waitFor();
  assert.equal(await box(page).inputValue(),'','the command text is removed');
  await page.getByRole('button',{name:'Close dialog'}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});

  // A path is not a command: the list closes on no match, so Enter sends.
  await box(page).fill('/usr/bin/env');
  assert.equal(await commands(page).count(),0,'no command list for a path');
  await box(page).press('Enter');
  await page.locator('article.message').filter({hasText:'/usr/bin/env'}).waitFor();
  assert.equal(await box(page).inputValue(),'');

  // The @ list keeps its name.
  await box(page).fill('@');
  await page.getByRole('listbox',{name:'Mention people and agents',exact:true}).waitFor();
  await box(page).press('Escape');

  // files opens the project's Files tab.
  await box(page).fill('/fi');
  assert.deepEqual(await commandNames(page),['files']);
  await commands(page).getByRole('option').filter({hasText:'files'}).click();
  await page.getByRole('region',{name:'Project files'}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('tab'),'files');

  // A standalone channel the owner manages offers only invite.
  const channel=await(await must(h.post('/api/channels',{name:'Synthetic standalone channel',visibility:'PRIVATE'}),'create channel')).json() as {id:string};
  await page.goto(`${h.base}/?channel=${channel.id}`);
  await box(page).fill('/');
  assert.deepEqual(await commandNames(page),['invite'],'a standalone channel offers only invite');
});

await runChatTest('slash commands: a member who can post but not invite',async h=>{
  const channel=await(await must(h.post('/api/channels',{name:'Synthetic shared channel',visibility:'PRIVATE'}),'create channel')).json() as {id:string};
  const {page}=await h.loginAs(second);
  // loginAs makes the human a project member through POST /api/projects/<id>/members, as the owner.
  await must(h.post(`/api/channels/${channel.id}/subscribe`,{subscriberType:'HUMAN',subscriberId:second}),'channel subscriber');
  await page.locator('.nest-chat').waitFor();
  // A member sees a project (and its Files tab) only in a team project (apps/api/src/projects.ts canView), so the member's project chat is a team project's.
  const team=await(await must(h.post('/api/projects',{id:crypto.randomUUID(),name:'Synthetic team project',description:'Synthetic team project for slash commands',collaboration:'team'}),'create team project')).json() as {id:string;channelId:string};
  await must(h.post(`/api/projects/${team.id}/members`,{subscriberType:'HUMAN',subscriberId:second}),'team project member');
  await page.goto(`${h.base}/?channel=${team.channelId}`);
  await page.reload();
  await box(page).fill('/');
  assert.deepEqual(await commandNames(page),['files'],'a project member without invite rights gets only files');

  await page.goto(`${h.base}/?channel=${channel.id}`);
  await box(page).fill('/');
  await page.getByText('No commands available',{exact:true}).waitFor();
  assert.equal(await commands(page).getByRole('option').count(),0);
});

await runChatTest('slash commands: another person\'s shared personal agent from @',async h=>{
  // The harness API has no engine token, so its personal agent directory is empty. The member's browser gets the
  // directory entry and the direct-chat answer from route stubs; the agent, the member and the chat are real.
  const helper='SyntheticHelper';
  await must(h.post('/api/agents',{name:helper,icon:'pip',visibility:'PRIVATE',modelId:'wrapped:none',workspacePath:'/tmp/nest-synthetic-helper'}),'create personal agent');
  const direct=await(await must(h.post('/api/channels',{name:'Synthetic direct chat with SyntheticHelper',visibility:'PRIVATE'}),'create direct chat')).json() as {id:string};
  const {page}=await h.loginAs(second);
  await must(h.post(`/api/channels/${direct.id}/subscribe`,{subscriberType:'HUMAN',subscriberId:second}),'direct chat member');
  await must(h.post(`/api/channels/${direct.id}/subscribe`,{subscriberType:'AGENT',subscriberId:helper}),'direct chat agent');
  let opened=0;
  await page.context().route('**/api/assistants',route=>route.fulfill({json:{items:[{agentName:helper,ownerName:'demo-owner',description:'Shared personal agent',yours:false}]}}));
  await page.context().route(`**/api/collaboration/agents/${helper}/chat`,route=>{opened++;return route.fulfill({json:{channelId:direct.id}});});
  await page.locator('.nest-chat').waitFor();
  await page.reload();

  const choose=async(text:string)=>{
    await box(page).fill(text);
    const option=page.getByRole('listbox',{name:'Mention people and agents',exact:true}).getByRole('option').filter({hasText:helper});
    await option.waitFor();
    await box(page).press('Enter');
    await page.waitForURL(url=>url.searchParams.get('channel')===direct.id);
  };
  // An empty direct-chat draft gets the brief.
  await choose('Synthetic first brief @SynthH');
  await page.waitForFunction(()=>(document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement|null)?.value==='Synthetic first brief');
  // A non-empty one is kept.
  await page.goto(`${h.base}/?channel=${h.project.channelId}`);
  await choose('Synthetic second brief @SynthH');
  await page.waitForTimeout(500);
  assert.equal(await box(page).inputValue(),'Synthetic first brief','the existing draft is kept');
  assert.equal(opened,2,'each choice opens the direct chat');
});
