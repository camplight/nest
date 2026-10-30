import assert from 'node:assert/strict';
import {runChatTest} from '../support/chat-harness';
import {huddleTestServer} from '../support/huddle-server';

// Linux CI provisions the pinned disposable SFU; local runs can opt into one.
const server = await huddleTestServer(), livekit = server.url;
const previous = Object.fromEntries(['ORGOPS_VOICE_BROKER', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'ORGOPS_LLM_STUB'].map(key => [key, process.env[key]]));
Object.assign(process.env, {ORGOPS_VOICE_BROKER: 'livekit', LIVEKIT_URL: livekit ?? 'ws://127.0.0.1:17999', LIVEKIT_API_KEY: 'huddle-test', LIVEKIT_API_SECRET: 'huddle-test-secret-for-disposable-fixtures', ORGOPS_LLM_STUB: '0'});
try {
  await runChatTest('Figma huddle: channel permissions, avatars, mobile, keyboard and microphone denial', async h => {
    const {page} = h;
    const unauthorized = await fetch(h.apiUrl + '/api/voice/rooms/join', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({channelId: h.project.channelId})});
    assert.equal(unauthorized.status, 401, JSON.stringify({status: unauthorized.status, body: await unauthorized.text()}));
    const brand = await fetch(h.apiUrl + '/api/branding', {method: 'PUT', headers: {cookie: h.cookie, 'content-type': 'application/json'}, body: JSON.stringify({displayName: 'Camplight', logoUrl: '/brand/camplight-logo-white.svg', primaryColor: '#350956', accentColor: '#ff7557', backgroundColor: '#f8f4ff'})});
    assert(brand.ok);
    const created = await h.post('/api/agents', {name: 'Puff', icon: 'puff', modelId: 'openai:gpt-realtime', visibility: 'PUBLIC', workspacePath: '/tmp/nest-huddle-fixture-puff'});
    assert.equal(created.status, 201, await created.text());
    const invitation = await h.post(`/api/projects/${h.project.id}/members`, {subscriberType: 'AGENT', subscriberId: 'Puff'});
    assert.equal(invitation.ok, true, await invitation.text());
    await h.emit('message.created', {text: 'The launch brief is ready for review. We can talk through the next steps here.'});
    await page.reload();
    await page.getByRole('button', {name: 'Huddle', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: 'Huddle', exact: true});
    await dialog.getByRole('button', {name: 'Join huddle', exact: true}).waitFor({state: 'visible'});
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Join huddle')?.disabled);
    assert.equal(await dialog.getByLabel('Invite to huddle').count(), 1, 'The wrapped/text agent must not be offered for voice');
    assert.equal(await dialog.locator('img[src$="puff.png"]').count(), 1);
    assert.equal(await dialog.getByText('0 in huddle', {exact: true}).count(), 1, 'Chat membership is not voice presence');
    await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
    assert((await dialog.boundingBox())!.width > 1000, JSON.stringify(await dialog.evaluate(el => ({classes: el.className, width: getComputedStyle(el).width, maxWidth: getComputedStyle(el).maxWidth, display: getComputedStyle(el).display}))) + ': desktop huddle width');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.huddle-dialog .agent-portrait img')).every(i => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0));
    const imgs = await dialog.locator('.agent-portrait img').evaluateAll(imgs => imgs.map(i => ({width: i.getBoundingClientRect().width, height: i.getBoundingClientRect().height})));
    assert(imgs.every(i => Math.abs(i.width - i.height) < .1 && i.width > 0), JSON.stringify(imgs));
    await h.screenshot('huddle-desktop');
    await dialog.getByRole('button', {name: 'Expand huddle'}).click();
    await dialog.getByRole('button', {name: 'Restore huddle size'}).click();
    await dialog.getByRole('button', {name: 'Hide conversation'}).click();
    assert.equal(await dialog.getByRole('region', {name: 'Huddle conversation'}).count(), 0);
    await dialog.getByRole('button', {name: 'Show conversation'}).click();
    await page.setViewportSize({width: 390, height: 844});
    assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.huddle-dialog')!).paddingLeft === '14px');
    await h.screenshot('huddle-mobile');
    await page.keyboard.press('Escape'); await dialog.waitFor({state: 'hidden'});
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-haspopup') === 'dialog');
    await page.setViewportSize({width: 1440, height: 1000});
    // Deny browser capture after the real engine has authorized the join.
    await page.evaluate(() => {navigator.mediaDevices.getUserMedia = async () => {throw new DOMException('Synthetic denial', 'NotAllowedError');};});
    await page.getByRole('button', {name: 'Huddle', exact: true}).click();
    await page.getByRole('button', {name: 'Join huddle', exact: true}).click();
    await dialog.getByRole('alert').filter({hasText: 'Microphone access was denied'}).waitFor();
    assert(await dialog.getByRole('button', {name: 'Join huddle', exact: true}).isEnabled());
    await page.keyboard.press('Escape');
    // A delayed room authorization must not open a microphone after Close.
    await page.reload();
    const hold = h.holdNext('/api/voice/rooms/join');
    await page.getByRole('button', {name: 'Huddle', exact: true}).click();
    await page.getByRole('button', {name: 'Join huddle', exact: true}).click(); await hold.started;
    await dialog.getByRole('button', {name: 'Cancel', exact: true}).click(); hold.release();
    await dialog.waitFor({state: 'hidden'});
    const read = await fetch(h.apiUrl + `/api/events?channelId=${h.project.channelId}&type=voice.session.started&limit=10`, {headers: {cookie: h.cookie}});
    assert.equal((await read.json()).length, 0, 'Neither denied nor cancelled joins announce an active session');
    // An authenticated shared viewer may read the room but cannot capture/post
    // voice into it. Check both the engine gate and the product affordance.
    assert((await h.post('/api/humans/invite', {username: 'demo-observer', tempPassword: 'password'})).ok);
    h.engineDb.prepare('UPDATE humans SET must_change_password=0 WHERE username=?').run('demo-observer');
    const observerLogin = await h.post('/api/auth/login', {username: 'demo-observer', password: 'password'}, {'content-type': 'application/json'});
    const observerCookie = observerLogin.headers.getSetCookie()[0].split(';')[0];
    const denied = await h.post('/api/voice/rooms/join', {channelId: h.project.channelId}, {cookie: observerCookie, 'content-type': 'application/json'});
    assert.equal(denied.status, 404, 'Uninvited users cannot mint private-room tokens');
    assert((await h.post(`/api/channels/${h.project.channelId}/share`, {viewerType: 'HUMAN', viewerId: 'demo-observer'})).ok);
    const readOnly = await h.post('/api/voice/rooms/join', {channelId: h.project.channelId}, {cookie: observerCookie, 'content-type': 'application/json'});
    assert.equal(readOnly.status, 403, 'Shared readers cannot publish voice');
    const context = await h.context.browser()!.newContext({viewport: {width: 390, height: 844}});
    await context.addCookies([{name: 'nest_session', value: observerCookie.slice('nest_session='.length), url: h.base, httpOnly: true}]);
    await context.addInitScript(ws => {(globalThis as {__NEST_USER_UI_CONFIG__?: unknown}).__NEST_USER_UI_CONFIG__ = {wsBaseUrl: ws};}, h.apiUrl.replace('http:', 'ws:') + '/ws');
    const viewer = await context.newPage();
    await viewer.goto(h.base + '/?channel=' + h.project.channelId);
    await viewer.getByRole('button', {name: 'Huddle', exact: true}).click();
    await viewer.getByText('Huddles are available to members who can send messages in this chat.', {exact: true}).waitFor();
    assert(await viewer.getByRole('button', {name: 'Join huddle', exact: true}).isDisabled());
    await context.close();
  }, {fakeMedia: true});

  if (livekit) await runChatTest('Huddle: two real browser media participants, mute, transcript and leave', async h => {
    const {page} = h;
    const {page: second} = await h.loginAs('demo-teammate');
    await page.getByRole('button', {name: 'Huddle', exact: true}).click();
    await page.getByRole('button', {name: 'Join huddle', exact: true}).click();
    await page.getByRole('button', {name: 'Leave', exact: true}).waitFor();
    await second.getByRole('button', {name: 'Huddle', exact: true}).click();
    await second.getByRole('button', {name: 'Join huddle', exact: true}).click();
    await second.getByRole('button', {name: 'Leave', exact: true}).waitFor();
    await page.getByText('2 in huddle', {exact: true}).waitFor();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('body > audio')).some(a => !(a as HTMLAudioElement).paused && (a as HTMLAudioElement).readyState >= 2), undefined, {timeout: 15_000});
    await page.getByRole('button', {name: 'Mute microphone', exact: true}).click();
    await page.getByRole('button', {name: 'Unmute microphone', exact: true}).waitFor();
    // Synthetic runner transcript on the actual authenticated event path.
    await h.emit('message.created', {text: 'Let’s approve the launch brief and prepare the next review.', voice: {mode: 'realtime', status: 'transcribed', speakerId: 'Pip'}});
    await page.getByRole('region', {name: 'Voice transcript'}).getByText('Let’s approve the launch brief and prepare the next review.', {exact: true}).waitFor();
    await h.screenshot('huddle-connected-desktop');
    await page.setViewportSize({width: 390, height: 844}); await h.screenshot('huddle-connected-mobile');
    await page.getByRole('button', {name: 'Leave', exact: true}).click();
    await second.getByText('1 in huddle', {exact: true}).waitFor();
    assert(await second.getByRole('button', {name: 'Leave', exact: true}).isVisible(), 'Leaving does not hang up the teammate');
    // Navigation releases the second browser's mic and media session too.
    await second.evaluate(() => {history.pushState({}, '', '/?view=dashboard'); dispatchEvent(new PopStateEvent('popstate'));});
    await second.getByRole('dialog', {name: 'Huddle', exact: true}).waitFor({state: 'hidden'});
  }, {fakeMedia: true});
} finally {
  for (const [key, value] of Object.entries(previous)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}
  server.close();
}
