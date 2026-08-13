import { describe, expect, it } from 'vitest'
import { inspectNwcConnection, NwcClient, NwcError } from '../src/index.js'
import { CLIENT_SECRET_HEX, VALID_URI, WALLET_PUBKEY } from './helpers.js'

describe('NWC connection parsing', () => {
  it('returns public connection metadata without the secret', () => {
    const inspected = inspectNwcConnection(VALID_URI)
    expect(inspected).toEqual({
      walletPubkey: WALLET_PUBKEY,
      relays: ['wss://relay.one/', 'wss://relay.two/path'],
      lud16: 'alice@example.com',
    })
    expect(JSON.stringify(inspected)).not.toContain(CLIENT_SECRET_HEX)
  })

  it.each([
    ['', 'missing or too long'],
    ['x'.repeat(8193), 'missing or too long'],
    ['not a URL', 'connection URI is invalid'],
    ['https://example.com', 'nostr+walletconnect'],
    [`nostr+walletconnect://user@${WALLET_PUBKEY}?relay=wss%3A%2F%2Frelay.one&secret=${CLIENT_SECRET_HEX}`, 'forbidden'],
    [`nostr+walletconnect://${WALLET_PUBKEY}?relay=wss%3A%2F%2Frelay.one&secret=${CLIENT_SECRET_HEX}#fragment`, 'forbidden'],
    [`nostr+walletconnect://${WALLET_PUBKEY}:123?relay=wss%3A%2F%2Frelay.one&secret=${CLIENT_SECRET_HEX}`, 'port or path'],
    [`nostr+walletconnect://${WALLET_PUBKEY}/wallet?relay=wss%3A%2F%2Frelay.one&secret=${CLIENT_SECRET_HEX}`, 'port or path'],
    [`nostr+walletconnect://${WALLET_PUBKEY}?relay=wss%3A%2F%2Frelay.one&secret=${CLIENT_SECRET_HEX}&token=unexpected`, 'unsupported parameter'],
    [`nostr+walletconnect://${'a'.repeat(64)}?relay=wss%3A%2F%2Frelay.one`, 'wallet key or secret'],
    [`nostr+walletconnect://${'a'.repeat(64)}?secret=${CLIENT_SECRET_HEX}`, 'between 1 and 8 relays'],
    [`nostr+walletconnect://${'a'.repeat(64)}?relay=ws%3A%2F%2Frelay.one&secret=${CLIENT_SECRET_HEX}`, 'wss'],
    [`nostr+walletconnect://${'a'.repeat(64)}?relay=https%3A%2F%2Frelay.one&secret=${CLIENT_SECRET_HEX}`, 'wss'],
    [`nostr+walletconnect://${'a'.repeat(64)}?relay=${encodeURIComponent('wss://user:pass@relay.one')}&secret=${CLIENT_SECRET_HEX}`, 'forbidden'],
    [`nostr+walletconnect://${'a'.repeat(64)}?relay=${encodeURIComponent('wss://relay.one?token=secret')}&secret=${CLIENT_SECRET_HEX}`, 'forbidden'],
    [`nostr+walletconnect://${'a'.repeat(64)}?relay=${encodeURIComponent('wss://relay.one/#fragment')}&secret=${CLIENT_SECRET_HEX}`, 'forbidden'],
    [`nostr+walletconnect://${WALLET_PUBKEY}?relay=${encodeURIComponent('x'.repeat(2049))}&secret=${CLIENT_SECRET_HEX}`, 'too long'],
    [`nostr+walletconnect://${WALLET_PUBKEY}?relay=not-a-url&secret=${CLIENT_SECRET_HEX}`, 'relay URL is invalid'],
    [`nostr+walletconnect://${'0'.repeat(64)}?relay=wss%3A%2F%2Frelay.one&secret=${CLIENT_SECRET_HEX}`, 'invalid key material'],
    [`nostr+walletconnect://${WALLET_PUBKEY}?relay=wss%3A%2F%2Frelay.one&secret=${'0'.repeat(64)}`, 'invalid key material'],
    [`nostr+walletconnect://${WALLET_PUBKEY}?relay=wss%3A%2F%2Frelay.one&secret=${CLIENT_SECRET_HEX}&secret=${CLIENT_SECRET_HEX}`, 'wallet key or secret'],
    [`nostr+walletconnect://${WALLET_PUBKEY}?relay=wss%3A%2F%2Frelay.one&secret=${CLIENT_SECRET_HEX}&lud16=a%40example.com&lud16=b%40example.com`, 'duplicate lud16'],
    [`nostr+walletconnect://${WALLET_PUBKEY}?relay=wss%3A%2F%2Frelay.one&secret=${CLIENT_SECRET_HEX}&lud16=${'x'.repeat(321)}`, 'invalid lud16'],
    [`nostr+walletconnect://${WALLET_PUBKEY}?relay=wss%3A%2F%2Frelay.one&secret=${CLIENT_SECRET_HEX}&lud16=bad%0Avalue`, 'invalid lud16'],
  ])('rejects malformed connections', (uri, message) => {
    expect(() => inspectNwcConnection(uri)).toThrow(message)
  })

  it('deduplicates relays and enforces the relay bound', () => {
    const duplicate = `nostr+walletconnect://${WALLET_PUBKEY}?relay=wss%3A%2F%2Frelay.one&relay=wss%3A%2F%2Frelay.one&secret=${CLIENT_SECRET_HEX}`
    expect(inspectNwcConnection(duplicate).relays).toEqual(['wss://relay.one/'])

    const relays = Array.from({ length: 9 }, (_, index) => `relay=${encodeURIComponent(`wss://relay${index}.example`)}`).join('&')
    expect(() => inspectNwcConnection(`nostr+walletconnect://${WALLET_PUBKEY}?${relays}&secret=${CLIENT_SECRET_HEX}`)).toThrow('between 1 and 8')
  })

  it('does not expose the connection URI through client properties or errors', () => {
    const client = new NwcClient(VALID_URI)
    expect(JSON.stringify(client)).not.toContain(CLIENT_SECRET_HEX)
    client.close()
    expect(() => client.close()).not.toThrow()
    expect(() => inspectNwcConnection('x')).toThrow(NwcError)
  })
})
