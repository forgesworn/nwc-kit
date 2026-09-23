import { NwcError } from '../src/error.js'

/**
 * How the demo reports a failed request. This mirrors the guidance in the
 * README: a failure raised before publication never reached the wallet, an
 * explicit wallet refusal is definite, and anything else after a payment was
 * published leaves the money in an unknown state.
 */
export type OutcomeKind = 'rejected' | 'refused' | 'unknown' | 'failed'

const PRE_PUBLICATION = new Set([
  'INVALID_CONNECTION',
  'INVALID_REQUEST',
  'UNSUPPORTED_METHOD',
  'UNSUPPORTED_ENCRYPTION',
  'UNSUPPORTED_EXTENSION',
  'INFO_UNAVAILABLE',
])

const EXPLICIT_REFUSALS = new Set([
  'PAYMENT_FAILED',
  'INSUFFICIENT_BALANCE',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'RESTRICTED',
  'UNAUTHORIZED',
  'NOT_IMPLEMENTED',
])

export function classifyFailure(method: string, error: unknown): { kind: OutcomeKind; title: string } {
  const code = error instanceof NwcError ? error.code : undefined
  if (code !== undefined && PRE_PUBLICATION.has(code)) {
    return { kind: 'rejected', title: `${method} rejected by nwc-kit` }
  }
  if (code === 'WALLET_ERROR' && error instanceof NwcError && EXPLICIT_REFUSALS.has(error.walletCode ?? '')) {
    return { kind: 'refused', title: `${method} refused by the wallet` }
  }
  if (method === 'pay_invoice') {
    return { kind: 'unknown', title: `${method} outcome unknown: reconcile before retrying` }
  }
  if (code === 'INVALID_RESPONSE') {
    return { kind: 'rejected', title: `${method} response rejected by nwc-kit` }
  }
  return { kind: 'failed', title: `${method} failed` }
}
