// Type-level use from an external project (strict TS): exported types, discriminated unions, exhaustive switches.
import { plan, type Quote, type VerifiedQuote, type ExecuteResult, type TakerEvent, type Reason, type BookEntry } from '@fondaco/client'
import { createTaker, type Taker } from '@fondaco/client/taker'
import { createSubmitter, cancelOrders, type CancelResult, type PriceLevel } from '@fondaco/client/protect'
import { protectionStatus, type ProtectionStatus, type ProtectionLevel } from '@fondaco/client/wallet-protection'

const entries: BookEntry[] = []
const q: Quote = plan(entries, 1n)
function describe(x: Quote): string {
  switch (x.kind) {
    case 'indicative': return `indicative ${x.legs.length}`
    case 'verified': return `verified ok=${x.ok} at ${x.block ?? '-'}`
    default: { const never: never = x; return never }
  }
}
function onUpdate(e: TakerEvent): string {
  switch (e.type) {
    case 'verified': return describe(e.quote)
    case 'protection': return e.mode
    case 'approval_reset': return e.token
    case 'approving': return e.amount.toString()
    case 'simulating': case 'awaiting_signature': case 'rejected': return String(e.leg)
    case 'pending': return e.hash
    case 'sped_up': return e.previous
    case 'filled': return e.received.toString()
    case 'skipped': return e.reason
    case 'failed': return e.message
    case 'cancelled': case 'replaced': case 'timeout': return e.txHash
    case 'blocked': return e.message
    case 'private_unavailable': return e.error
    case 'protection_downgraded': return `${e.from}->${e.to}`
    case 'done': return summary(e.result)
    default: { const never: never = e; return never }
  }
}
function summary(r: ExecuteResult): string { return `${r.filled.length} filled, stopped ${r.stopped ?? 'no'}, via ${r.protection}${r.downgraded ? ' (downgraded)' : ''}` }
function cancelled(c: CancelResult): number { return c.status === 'cancelled' || c.status === 'partly_taken' ? c.taken.length : c.status === 'private_unavailable' ? -1 : 0 }
const reasons: Reason[] = ['taken', 'recipient_guard', 'private_unavailable']
const level: PriceLevel = 'warn'
const status: ProtectionStatus = protectionStatus({ chainId: 8453 })
const lvl: ProtectionLevel = status.level
const v: VerifiedQuote | null = null
const t: Taker | null = null
void [q, onUpdate, cancelled, reasons, level, lvl, v, t, createTaker, createSubmitter, cancelOrders]
