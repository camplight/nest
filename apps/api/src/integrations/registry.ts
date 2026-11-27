import type { ConnectionProvider, Page } from './provider';

/** Stable provider IDs remain on connections; catalog cursors never select execution accounts. */
export function connectionRegistry(providers: ConnectionProvider[]) {
  const byId = new Map(providers.map(p => [p.id, p]));
  if (byId.size !== providers.length) throw Error('Duplicate connection provider');
  const get = (id?: string) => {
    const p = id ? byId.get(id) : providers[0];
    if (!p) throw Error('Connection provider unavailable');
    return p;
  };
  return {
    has: (id: string) => byId.has(id),
    get,
    forToolkit: (slug: string) => providers.find(p => p.toolkits?.includes(slug)) ?? get(),
    async page<T>(cursor: string | undefined, fetchPage: (p: ConnectionProvider, cursor?: string) => Promise<Page<T>>) {
      if (cursor && cursor.length > 12000) throw Error('Invalid catalog cursor');
      let index = 0, remote = cursor;
      if (cursor?.startsWith('nest-provider:')) {
        const parsed = JSON.parse(Buffer.from(cursor.slice(14), 'base64url').toString());
        index = providers.findIndex(p => p.id === parsed.provider);
        if (index < 0 || (parsed.cursor !== undefined && typeof parsed.cursor !== 'string')) throw Error('Invalid catalog cursor');
        remote = parsed.cursor;
      }
      const provider = get(providers[index]?.id);
      const page = await fetchPage(provider, remote);
      const next = page.nextCursor ? {provider: provider.id, cursor: page.nextCursor}
        : providers[index + 1] ? {provider: providers[index + 1].id} : null;
      return {provider, items: page.items, nextCursor: next ? 'nest-provider:' + Buffer.from(JSON.stringify(next)).toString('base64url') : null};
    },
  };
}
