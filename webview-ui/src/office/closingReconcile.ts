/** Reconcile this tab's closing ids with the server's on an existingAgents
 *  handshake. The handshake is authoritative in both directions:
 *  - ids this tab marked but the server no longer lists were undone (from
 *    another tab) or finalized while we were disconnected → unmark, or every
 *    later message for that agent stays filtered for good;
 *  - ids the server lists that this tab still holds as live were closed while
 *    we were disconnected → tear down, or the character stays next to the
 *    toast. Pure, so it can be pinned without React. */
export function reconcileClosingIds(
  mine: ReadonlySet<number>,
  server: ReadonlySet<number>,
  isLiveHere: (id: number) => boolean,
): { unmark: number[]; tearDown: number[] } {
  const unmark = [...mine].filter((id) => !server.has(id));
  const tearDown = [...server].filter((id) => isLiveHere(id));
  return { unmark, tearDown };
}
