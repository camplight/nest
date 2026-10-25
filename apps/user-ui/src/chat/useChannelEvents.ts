import {useSyncExternalStore} from 'react';
import type {ChannelEventsCore,ChannelEventsSnapshot} from './channel-events';

export function useChannelEvents(core:ChannelEventsCore):ChannelEventsSnapshot{
 return useSyncExternalStore(core.subscribe,core.snapshot);
}
