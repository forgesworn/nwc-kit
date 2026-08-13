import { SimplePool } from 'nostr-tools/pool'
import type { Event } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import type {
  NwcEvent,
  NwcFilter,
  NwcPublishResult,
  NwcSubscription,
  NwcTransport,
} from './types.js'

export class NostrRelayTransport implements NwcTransport {
  readonly #pool: SimplePool

  constructor(pool = new SimplePool({ enableReconnect: true })) {
    this.#pool = pool
  }

  async query(relays: readonly string[], filter: NwcFilter, timeoutMs: number): Promise<NwcEvent[]> {
    return this.#pool.querySync([...relays], filter as Filter, { maxWait: timeoutMs })
  }

  subscribe(
    relays: readonly string[],
    filter: NwcFilter,
    handlers: { onevent(event: NwcEvent): void; onclose?(): void },
    signal?: AbortSignal,
  ): NwcSubscription {
    return this.#pool.subscribeMany([...relays], filter as Filter, {
      onevent: handlers.onevent as (event: Event) => void,
      ...(handlers.onclose ? { onclose: handlers.onclose } : {}),
      ...(signal ? { abort: signal } : {}),
    })
  }

  async publish(
    relays: readonly string[],
    event: NwcEvent,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<NwcPublishResult[]> {
    const promises = this.#pool.publish([...relays], event as Event, {
      maxWait: timeoutMs,
      ...(signal ? { abort: signal } : {}),
    })
    const settled = await Promise.allSettled(promises)
    return settled.map((result, index) => ({
      relay: relays[index] ?? 'unknown',
      accepted: result.status === 'fulfilled',
    }))
  }

  close(relays: readonly string[]): void {
    this.#pool.close([...relays])
  }
}
