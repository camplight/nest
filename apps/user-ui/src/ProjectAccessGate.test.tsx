import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createProjectAccessRequestSubmitter, ProjectAccessGateView, type ProjectAccessGateViewState } from './ProjectAccessGate';

function render(state: ProjectAccessGateViewState, submitting = false, error: string | null = null) {
  return renderToStaticMarkup(
    <ProjectAccessGateView
      state={state}
      submitting={submitting}
      error={error}
      onRequest={() => undefined}
      onRetry={() => undefined}
    />,
  );
}

it('renders a privacy-safe requestable project state', () => {
  const html = render({status: 'requestable'});
  expect(html).toContain('Request access');
  expect(html).toContain('normal project chat and file access');
  expect(html).toContain('personal connected-account permissions do not change');
  expect(html).not.toContain('Secret launch');
  expect(html).not.toContain('Confidential roadmap');
  expect(html).not.toContain('owner-human-id');
  expect(html).not.toContain('private-channel-id');
});

it('renders pending without another submission control', () => {
  const html = render({status: 'pending', request: {id: 'request-id', createdAt: Date.UTC(2026, 10, 11)}});
  expect(html).toContain('Access requested');
  expect(html).toContain('The project owner will review your request.');
  expect(html).not.toContain('Request access');
  expect(html).not.toContain('Request again');
});

it('renders denial with a new-request action', () => {
  const html = render({status: 'denied', request: {id: 'request-id', decidedAt: Date.UTC(2026, 10, 11)}});
  expect(html).toContain('Your request was not approved');
  expect(html).toContain('Request again');
  expect(html).not.toContain('Secret launch');
});

it('renders generic unavailable and retryable error states', () => {
  expect(render({status: 'unavailable'})).toContain('Project unavailable');
  const html = render({status: 'requestable'}, false, 'Unable to check access');
  expect(html).toContain('Unable to check access');
  expect(html).toContain('Retry');
  expect(html).toContain('Request access');
});

it('reuses one request UUID after an uncertain response and rotates it after confirmation', async () => {
  const ids: string[] = [];
  let calls = 0;
  const submitter = createProjectAccessRequestSubmitter('project-id', {
    createId: () => `request-${ids.length + 1}`,
    send: async (_projectId, id) => {
      ids.push(id);
      calls += 1;
      if (calls === 1) throw new Error('lost response');
      return {status: 'pending' as const, request: {id, createdAt: 123}};
    },
  });

  await expect(submitter.submit()).rejects.toThrow('lost response');
  expect(submitter.hasPending()).toBe(true);
  await expect(submitter.submit()).resolves.toMatchObject({status: 'pending'});
  expect(ids).toEqual(['request-1', 'request-1']);
  expect(submitter.hasPending()).toBe(false);
  await submitter.submit();
  expect(ids).toEqual(['request-1', 'request-1', 'request-3']);
});

it('retains the request UUID after an uncertain HTTP server error', async () => {
  const originalFetch = globalThis.fetch;
  const ids: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const id = (JSON.parse(String(init?.body)) as {id: string}).id;
    ids.push(id);
    if (ids.length === 1) return Response.json({error: 'Synthetic lost response'}, {status: 502});
    return Response.json({status: 'pending', request: {id, createdAt: 123}});
  }) as typeof fetch;

  try {
    const submitter = createProjectAccessRequestSubmitter('project-id', {createId: () => 'request-id'});
    await expect(submitter.submit()).rejects.toThrow('Synthetic lost response');
    expect(submitter.hasPending()).toBe(true);
    await expect(submitter.submit()).resolves.toMatchObject({status: 'pending'});
    expect(ids).toEqual(['request-id', 'request-id']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it('renders the disabled requesting state', () => {
  const html = render({status: 'requestable'}, true);
  expect(html).toContain('Requesting…');
  expect(html).toContain('disabled');
});
