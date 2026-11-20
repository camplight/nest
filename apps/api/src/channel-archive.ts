import type { Hono } from 'hono';
import type { ProductDb } from '@nest/db';
import type { OrgOpsClient } from '@nest/orgops-client';

type Forward = (request: Request) => Promise<Response>;

/**
 * Archiving a chat (the engine's own archive, read-only for everyone) pauses every hand-off link to or from it
 * and declines hand-offs there waiting for an OK; unarchiving resumes the links archiving paused, unless the
 * other end is still archived or hidden from the link creator's list. The engine decides who may archive;
 * Nest touches links only after the engine accepted, and returns the engine's answer unchanged.
 */
export function registerChannelArchiveRoutes(app: Hono, { store, orgops, forward }: { store: ProductDb; orgops: OrgOpsClient; forward: Forward }): void {
  async function archivedChannels(headers: Headers): Promise<Set<string>> {
    const response = await orgops.request('/api/channels?includeArchived=1', { headers });
    if (!response.ok) return new Set();
    const channels = await response.json() as { id: string; archivedAt?: number | null }[];
    return new Set(channels.filter(channel => channel.archivedAt).map(channel => channel.id));
  }
  for (const action of ['archive', 'unarchive'] as const) {
    app.post(`/api/channels/:id/${action}`, async c => {
      const response = await forward(c.req.raw);
      if (!response.ok) return response;
      const id = c.req.param('id');
      if (action === 'archive') store.flows.archiveLinks(null, [id]);
      else {
        const archived = await archivedChannels(c.req.raw.headers);
        store.flows.unarchiveLinks(null, [id], (other, creator) => archived.has(other) || store.canvases.hidden(creator).includes(other));
      }
      return response;
    });
  }
}
