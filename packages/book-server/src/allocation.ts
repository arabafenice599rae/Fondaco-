// Cumulative funding (spec §3.1): a signer's orders on one token are funded in creation order until
// min(balance, allowance) runs out. An order that does not fit is skipped (unfunded) and younger, smaller orders may
// still be funded with what is left. Pure: no I/O, so it is property-tested in isolation (test/allocation.test.js).
export interface Fundable { need: bigint; createdAt: number; seq: number }

/** Canonical funding order: oldest first; ties broken by insertion sequence (SQLite rowid). */
export const byAge = (a: Fundable, b: Fundable) => a.createdAt - b.createdAt || a.seq - b.seq

/** @returns for each input (same order as given) whether it is funded. Input order does not matter. */
export function allocate<T extends Fundable>(orders: readonly T[], available: bigint): boolean[] {
  const idx = orders.map((_, i) => i).sort((i, j) => byAge(orders[i] as T, orders[j] as T))
  const funded = new Array<boolean>(orders.length).fill(false)
  let left = available
  for (const i of idx) {
    const need = (orders[i] as T).need
    if (need <= left) { funded[i] = true; left -= need }
  }
  return funded
}
