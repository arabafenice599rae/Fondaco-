// Pure constants and price guards (no viem): shared by protect.ts, wallet-protection.ts and apps that only need to
// display warnings, without pulling the submission code into their first bundle.

/** Protected endpoints with revert protection, per chain. L2s with a sequencer have no public mempool to protect from. */
export const PROTECTED_RPC: Readonly<Record<number, readonly string[]>> = {
  1: ['https://rpc.mevblocker.io/noreverts', 'https://rpc.flashbots.net/fast'],
}
export const SEQUENCER_CHAINS: ReadonlySet<number> = new Set([8453, 10, 42161]) // Base, OP Mainnet, Arbitrum One

// ------------------------------------------------------------------ price guards (pure)

export type PriceLevel = 'ok' | 'warn' | 'danger'
/**
 * How much better than the market an offer is for whoever takes it — what a bot looks for.
 * side: 'sell' (signer gives base) or 'buy' (signer gives quote); price: quote per base; mid: book mid.
 * positive deviation = cheaper than market for the taker. Thresholds are inclusive (exactly 2.00 % → warn).
 */
export function priceCheck({ side, price, mid, warnBps = 200, dangerBps = 1000 }: { side: 'sell' | 'buy'; price: number; mid: number; warnBps?: number; dangerBps?: number }): { level: PriceLevel; deviationBps: number } {
  if (!(price > 0) || !(mid > 0)) return { level: 'ok', deviationBps: 0 }
  const dev = side === 'sell' ? (mid - price) / mid : (price - mid) / mid
  const bps = Math.round(dev * 10_000)
  return { level: bps >= dangerBps ? 'danger' : bps >= warnBps ? 'warn' : 'ok', deviationBps: bps }
}

/** An open offer the market has moved past: takers (and bots) get it below market. */
export const isStale = ({ side, price, mid, staleBps = 100 }: { side: 'sell' | 'buy'; price: number; mid: number; staleBps?: number }): boolean =>
  priceCheck({ side, price, mid, warnBps: staleBps }).level !== 'ok'

/** Expiry defaults: short by default, longer ones flagged (a long-lived fixed price is a free option for bots). */
export const EXPIRY = { defaultSec: 3600, warnAboveSec: 86_400 } as const
