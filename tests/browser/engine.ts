import {createApp, type AppConfig} from '../../vendor/orgops/apps/api/src/app';

// Browser fixtures have no federation peers and close multiple in-process DBs.
// Disable this unrelated poller through its supported configuration: upstream
// currently leaves its interval alive after db.close(). Production is unchanged.
export function createEngine(config: AppConfig) {
  const previous = process.env.ORGOPS_FEDERATION_SYNC_INTERVAL_MS;
  process.env.ORGOPS_FEDERATION_SYNC_INTERVAL_MS = '0';
  try { return createApp(config); }
  finally {
    if (previous === undefined) delete process.env.ORGOPS_FEDERATION_SYNC_INTERVAL_MS;
    else process.env.ORGOPS_FEDERATION_SYNC_INTERVAL_MS = previous;
  }
}
