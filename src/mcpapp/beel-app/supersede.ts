/// <reference lib="dom" />
/**
 * Each tool call mounts a new copy of the app, and the older copies stay live in
 * the conversation. Left alone, a click in an old one would act on stale state
 * and tell Claude the user is somewhere they are not. The newest copy wins: on
 * start each announces itself, and any older one that hears it steps down.
 *
 * Every copy of the app runs on the same sandbox origin within a conversation,
 * which is what lets a BroadcastChannel reach them all.
 */
const CHANNEL = 'beel-app-instances';

interface Announcement {
  startedAt: number;
  id: string;
}

/** Strictly newer: later start, ties broken by id so exactly one copy wins. */
export function isNewer(a: Announcement, b: Announcement): boolean {
  return a.startedAt !== b.startedAt ? a.startedAt > b.startedAt : a.id > b.id;
}

/** Announce this copy and call `onSuperseded` once a newer one appears. */
export function watchForNewerInstance(onSuperseded: () => void): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const self: Announcement = { startedAt: Date.now(), id: crypto.randomUUID() };
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<Announcement>) => {
    const other = event.data;
    if (!other || typeof other.startedAt !== 'number' || typeof other.id !== 'string') return;
    if (isNewer(other, self)) {
      channel.close();
      onSuperseded();
    }
  };
  channel.postMessage(self);
}
