export function reconcileNestSystemBridge(options: {
  agentName?: string;
  agentId?: string;
  apiUrl?: string;
  token?: string;
  dataDir: string;
  fetchImpl?: typeof fetch;
}): Promise<'not-configured' | 'not-found' | 'not-managed' | 'needs-review' | 'current' | 'migrated'>;
