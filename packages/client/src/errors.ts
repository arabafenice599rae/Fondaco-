// Error classification shared by the submitter and the taker.
import { BaseError, UserRejectedRequestError } from 'viem'

/** The user rejected the request in the wallet (EIP-1193 code 4001). Walks the cause chain by class, code and name: with two
 *  copies of viem in an app bundle, instanceof alone would miss it. */
export function isUserRejection(e: unknown): boolean {
  if (e instanceof BaseError && e.walk((x) => x instanceof UserRejectedRequestError)) return true
  for (let x = e as { code?: number; name?: string; cause?: unknown } | undefined, i = 0; x && i < 10; x = x.cause as typeof x, i++) {
    if (x.code === 4001 || x.name === 'UserRejectedRequestError') return true
  }
  return false
}
