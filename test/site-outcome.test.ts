import { describe, expect, it } from 'vitest'
import { NwcError } from '../src/error.js'
import { classifyFailure } from '../site/outcome.js'

describe('demo failure labels', () => {
  it('never reports a published payment that went wrong as a rejection', () => {
    for (const error of [
      new NwcError('RESPONSE_TIMEOUT', 'timed out'),
      new NwcError('INVALID_RESPONSE', 'no valid preimage'),
      new NwcError('PUBLISH_FAILED', 'no relay accepted'),
      new NwcError('REQUEST_ABORTED', 'aborted'),
      new NwcError('CLIENT_CLOSED', 'closed'),
      new NwcError('WALLET_ERROR', 'boom', 'INTERNAL'),
      new NwcError('WALLET_ERROR', 'boom', 'OTHER'),
      new Error('unexpected'),
    ]) {
      expect(classifyFailure('pay_invoice', error)).toEqual({
        kind: 'unknown',
        title: 'pay_invoice outcome unknown: reconcile before retrying',
      })
    }
  })

  it('reports a failure raised before publication as a rejection', () => {
    expect(classifyFailure('pay_invoice', new NwcError('INVALID_REQUEST', 'bad')).kind).toBe('rejected')
    expect(classifyFailure('list_transactions', new NwcError('UNSUPPORTED_EXTENSION', 'no')).kind).toBe('rejected')
  })

  it('reports an explicit wallet refusal as definite', () => {
    expect(classifyFailure('pay_invoice', new NwcError('WALLET_ERROR', 'no', 'INSUFFICIENT_BALANCE')).kind).toBe('refused')
    expect(classifyFailure('pay_invoice', new NwcError('WALLET_ERROR', 'no', 'PAYMENT_FAILED')).kind).toBe('refused')
  })

  it('labels a failed read without claiming a payment outcome', () => {
    expect(classifyFailure('get_balance', new NwcError('INVALID_RESPONSE', 'bad')).kind).toBe('rejected')
    expect(classifyFailure('get_balance', new NwcError('RESPONSE_TIMEOUT', 'slow')).kind).toBe('failed')
  })
})
