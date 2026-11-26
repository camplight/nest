import type { ProjectAccessNotification, ProjectAccessRequest } from '@nest/schemas';
import { apiJson, getApiHeaders } from './api';

export function loadProjectAccessRequests(signal?: AbortSignal) {
  return apiJson<ProjectAccessNotification[]>('/api/project-access-requests', {signal});
}

export function decideProjectAccess(projectId: string, requestId: string, decision: 'approve' | 'deny') {
  return apiJson<ProjectAccessRequest>(
    `/api/projects/${encodeURIComponent(projectId)}/access-requests/${encodeURIComponent(requestId)}/decision`,
    {method: 'POST', headers: getApiHeaders(), body: JSON.stringify({decision})},
  );
}

export function revokeProjectMember(projectId: string, username: string) {
  return apiJson<{status: 'removed'}>(
    `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(username)}`,
    {method: 'DELETE'},
  );
}
