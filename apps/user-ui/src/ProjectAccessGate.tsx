import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectAccessRequesterState } from '@nest/schemas';
import { apiJson, getApiHeaders } from './api';
import { apiUrl } from './config';

export type ProjectAccessGateViewState = ProjectAccessRequesterState | {status: 'loading'} | {status: 'unavailable'};

type SubmitterOptions = {
  createId?: () => string;
  send?: (projectId: string, id: string) => Promise<ProjectAccessRequesterState>;
};

class DefinitiveAccessRequestError extends Error {}

async function sendAccessRequest(projectId: string, id: string) {
  const response = await fetch(apiUrl(`/api/projects/${encodeURIComponent(projectId)}/access-requests`), {
    method: 'POST',
    credentials: 'include',
    headers: getApiHeaders(),
    body: JSON.stringify({id}),
  });
  const text = await response.text();
  if (!response.ok) throw new DefinitiveAccessRequestError(text || `Request failed: ${response.status}`);
  return JSON.parse(text) as ProjectAccessRequesterState;
}

export function createProjectAccessRequestSubmitter(projectId: string, options: SubmitterOptions = {}) {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const send = options.send ?? sendAccessRequest;
  let requestId: string | null = null;
  return {
    hasPending: () => requestId !== null,
    submit: async () => {
      requestId ??= createId();
      try {
        const result = await send(projectId, requestId);
        requestId = null;
        return result;
      } catch (error) {
        if (error instanceof DefinitiveAccessRequestError) requestId = null;
        throw error;
      }
    },
  };
}

type ViewProps = {
  state: ProjectAccessGateViewState;
  submitting: boolean;
  error: string | null;
  onRequest: () => void;
  onRetry: () => void;
};

function requestTime(value: number) {
  return new Date(value).toLocaleString();
}

export function ProjectAccessGateView({state, submitting, error, onRequest, onRetry}: ViewProps) {
  return <section className="dashboard-card project-access-gate" aria-label="Project access">
    {state.status === 'loading' && <><h2>Project</h2><p role="status">Checking whether you can request access…</p></>}
    {state.status === 'requestable' && <>
      <h2>This project is private</h2>
      <p>Ask the project owner for normal project chat and file access. Your personal connected-account permissions do not change.</p>
      <button type="button" className="dashboard-action project-primary" disabled={submitting} onClick={onRequest}>{submitting ? 'Requesting…' : 'Request access'}</button>
    </>}
    {state.status === 'pending' && <>
      <h2>Access requested</h2>
      <p>The project owner will review your request.</p>
      <p className="project-muted">Requested {requestTime(state.request.createdAt)}</p>
    </>}
    {state.status === 'denied' && <>
      <h2>Your request was not approved</h2>
      <p>You can submit a new request without revealing any project details.</p>
      <button type="button" className="dashboard-action project-primary" disabled={submitting} onClick={onRequest}>{submitting ? 'Requesting…' : 'Request again'}</button>
    </>}
    {state.status === 'unavailable' && <>
      <h2>Project unavailable</h2>
      <p>This project cannot be opened or requested right now.</p>
      <button type="button" className="dashboard-action" onClick={onRetry}>Refresh</button>
    </>}
    {state.status === 'member' && <><h2>Project</h2><p role="status">Access is available. Loading the project…</p></>}
    {error && <div className="notice error project-access-error" role="alert">{error} <button type="button" onClick={onRetry}>Retry</button></div>}
  </section>;
}

function message(reason: unknown) {
  const text = reason instanceof Error ? reason.message : 'Unable to check access';
  try {
    const value = JSON.parse(text) as {error?: unknown};
    return typeof value.error === 'string' ? value.error : text;
  } catch {
    return text;
  }
}

export function ProjectAccessGate({projectId, onMember, onUnavailable}: {
  projectId: string;
  onMember: () => void;
  onUnavailable: () => void;
}) {
  const [state, setState] = useState<ProjectAccessGateViewState>({status: 'loading'});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const retryKind = useRef<'load' | 'submit'>('load');
  const submitter = useRef<ReturnType<typeof createProjectAccessRequestSubmitter> | null>(null);
  if (!submitter.current) submitter.current = createProjectAccessRequestSubmitter(projectId);

  const applyState = useCallback((next: ProjectAccessRequesterState) => {
    setError(null);
    if (next.status === 'member') onMember();
    setState(next);
  }, [onMember]);

  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      retryKind.current = 'load';
      void apiJson<ProjectAccessRequesterState>(`/api/projects/${encodeURIComponent(projectId)}/access-request`, {signal: controller.signal})
        .then(next => { if (!controller.signal.aborted) applyState(next); })
        .catch(reason => {
          if (controller.signal.aborted) return;
          const text = message(reason);
          if (text === 'Project unavailable') {
            setState({status: 'unavailable'});
            setError(null);
            onUnavailable();
          } else {
            setError(text);
          }
        });
    };
    load();
    const interval = window.setInterval(load, 10_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [projectId, refresh, applyState, onUnavailable]);

  const submit = useCallback(async () => {
    if (submitting) return;
    retryKind.current = 'submit';
    setSubmitting(true);
    setError(null);
    try {
      applyState(await submitter.current!.submit());
    } catch (reason) {
      setError(message(reason));
    } finally {
      setSubmitting(false);
    }
  }, [applyState, projectId, submitting]);

  const retry = useCallback(() => {
    if (retryKind.current === 'submit' && submitter.current?.hasPending()) void submit();
    else setRefresh(value => value + 1);
  }, [submit]);

  return <ProjectAccessGateView state={state} submitting={submitting} error={error} onRequest={() => void submit()} onRetry={retry}/>;
}
