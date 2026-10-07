/** Rail order: ids in `order` first (that order), then the rest ascending.
 *  Pure, so the gap between agentCreated and the next agentOrder is stable. */
export function sortByRailOrder(ids: number[], order: number[]): number[] {
  const rank = new Map<number, number>();
  order.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  const ranked = ids.filter((id) => rank.has(id)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  const rest = ids.filter((id) => !rank.has(id)).sort((a, b) => a - b);
  return [...ranked, ...rest];
}
