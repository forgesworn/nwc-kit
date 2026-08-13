import { describe, expect, it, vi } from 'vitest'
import type { SimplePool } from 'nostr-tools/pool'
import { NostrRelayTransport } from '../src/transport.js'
import type { NwcEvent, NwcFilter } from '../src/types.js'

const EVENT: NwcEvent = {
  id: '11'.repeat(32),
  pubkey: '22'.repeat(32),
  created_at: 1_700_000_000,
  kind: 23_195,
  tags: [['e', '33'.repeat(32)]],
  content: 'ciphertext',
  sig: '44'.repeat(64),
}

function fakePool() {
  const subscription = { close: vi.fn() }
  return {
    subscription,
    querySync: vi.fn(async () => [EVENT]),
    subscribeMany: vi.fn(() => subscription),
    publish: vi.fn(() => [Promise.resolve('ok'), Promise.reject(new Error('rejected'))]),
    close: vi.fn(),
  }
}

describe('NostrRelayTransport', () => {
  it('adapts query and subscriptions without mutating caller arrays', async () => {
    const pool = fakePool()
    const transport = new NostrRelayTransport(pool as unknown as SimplePool)
    const relays = Object.freeze(['wss://one.example'])
    const filter: NwcFilter = { kinds: [23_195] }

    await expect(transport.query(relays, filter, 1234)).resolves.toEqual([EVENT])
    expect(pool.querySync).toHaveBeenCalledWith(['wss://one.example'], filter, { maxWait: 1234 })

    const onevent = vi.fn()
    const onclose = vi.fn()
    const controller = new AbortController()
    const subscription = transport.subscribe(relays, filter, { onevent, onclose }, controller.signal)
    expect(subscription).toBe(pool.subscription)
    expect(pool.subscribeMany).toHaveBeenCalledWith(['wss://one.example'], filter, {
      onevent,
      onclose,
      abort: controller.signal,
    })

    transport.subscribe(relays, filter, { onevent })
    expect(pool.subscribeMany).toHaveBeenLastCalledWith(['wss://one.example'], filter, { onevent })
    expect(relays).toEqual(['wss://one.example'])
  })

  it('reports acceptance per relay and closes only the requested relays', async () => {
    const pool = fakePool()
    const transport = new NostrRelayTransport(pool as unknown as SimplePool)
    const relays = ['wss://one.example', 'wss://two.example'] as const
    const controller = new AbortController()

    await expect(transport.publish(relays, EVENT, 5000, controller.signal)).resolves.toEqual([
      { relay: 'wss://one.example', accepted: true },
      { relay: 'wss://two.example', accepted: false },
    ])
    expect(pool.publish).toHaveBeenCalledWith([...relays], EVENT, {
      maxWait: 5000,
      abort: controller.signal,
    })

    pool.publish.mockReturnValueOnce([Promise.resolve('ok')])
    await expect(transport.publish(['wss://one.example'], EVENT, 5000)).resolves.toEqual([
      { relay: 'wss://one.example', accepted: true },
    ])
    transport.close(relays)
    expect(pool.close).toHaveBeenCalledWith([...relays])
  })
})
