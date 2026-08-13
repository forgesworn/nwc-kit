import { describe, expect, it } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((byte) => Number.parseInt(byte, 16)))
}

describe('locked NIP-44 v2 vector', () => {
  it('matches the official conversation key and payload', () => {
    const sec1 = hexToBytes('00'.repeat(31) + '01')
    const sec2 = hexToBytes('00'.repeat(31) + '02')
    const pub2 = getPublicKey(sec2)
    const conversationKey = nip44.v2.utils.getConversationKey(sec1, pub2)
    expect(Buffer.from(conversationKey).toString('hex')).toBe('c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d')

    const nonce = hexToBytes('00'.repeat(31) + '01')
    const payload = nip44.v2.encrypt('a', conversationKey, nonce)
    expect(payload).toBe('AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb')
    expect(nip44.v2.decrypt(payload, conversationKey)).toBe('a')

    sec1.fill(0)
    sec2.fill(0)
    conversationKey.fill(0)
  })
})
