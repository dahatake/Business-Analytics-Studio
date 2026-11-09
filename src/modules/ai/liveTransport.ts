import { setLiveTransport } from '../../ai/client.ts';
import { relayTransport } from './relayClient.ts';

/** Registers the relay as the live transport (imported for its side effect by global.tsx, so it is always present). */
setLiveTransport(relayTransport);