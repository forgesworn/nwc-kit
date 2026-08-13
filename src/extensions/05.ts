import { NwcError } from '../error.js'
import { NwcClient } from '../client.js'
import type { NwcClientOptions, NwcRequestOptions, NwcTransaction } from '../types.js'

export interface ListTransactionsParams {
  from?: number
  until?: number
  limit?: number
  offset?: number
  unpaid?: boolean
  type?: 'incoming' | 'outgoing'
}

function optionalInteger(value: number | undefined, name: string, minimum = 0): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new NwcError('INVALID_REQUEST', `${name} must be an integer of at least ${minimum}`)
  }
}

export class NwcTransactionHistoryClient extends NwcClient {
  constructor(connectionUri: string, options: NwcClientOptions = {}) {
    super(connectionUri, options)
  }

  async listTransactions(
    params: ListTransactionsParams = {},
    options: NwcRequestOptions = {},
  ): Promise<{ transactions: NwcTransaction[] }> {
    optionalInteger(params.from, 'from')
    optionalInteger(params.until, 'until')
    optionalInteger(params.offset, 'offset')
    optionalInteger(params.limit, 'limit', 1)
    if (params.limit !== undefined && params.limit > 20) {
      throw new NwcError('INVALID_REQUEST', 'limit must not exceed 20')
    }
    if (params.type !== undefined && params.type !== 'incoming' && params.type !== 'outgoing') {
      throw new NwcError('INVALID_REQUEST', 'type must be incoming or outgoing')
    }
    if (params.unpaid !== undefined && typeof params.unpaid !== 'boolean') {
      throw new NwcError('INVALID_REQUEST', 'unpaid must be a boolean')
    }
    if (params.from !== undefined && params.until !== undefined && params.from > params.until) {
      throw new NwcError('INVALID_REQUEST', 'from must not be after until')
    }

    if (!this.capabilities) await this.connect()
    this.requireExtension('05')
    const request = {
      ...(params.from !== undefined ? { from: params.from } : {}),
      ...(params.until !== undefined ? { until: params.until } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
      ...(params.unpaid !== undefined ? { unpaid: params.unpaid } : {}),
      ...(params.type !== undefined ? { type: params.type } : {}),
    }
    const result = await this.execute('list_transactions', request, options)
    if (typeof result !== 'object' || result === null || !Array.isArray((result as { transactions?: unknown }).transactions)) {
      throw new NwcError('INVALID_RESPONSE', 'list_transactions result has no transactions array')
    }
    const transactions = (result as { transactions: unknown[] }).transactions
    if (transactions.length > 20 || (params.limit !== undefined && transactions.length > params.limit)) {
      throw new NwcError('INVALID_RESPONSE', 'list_transactions returned too many transactions')
    }
    return {
      transactions: transactions.map((transaction) => this.validateTransaction(transaction, 'list_transactions')),
    }
  }
}
