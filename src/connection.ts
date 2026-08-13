import { getPublicKey } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { NwcError } from './error.js'
import type { NwcConnectionInfo } from './types.js'

const HEX_64 = /^[0-9a-f]{64}$/i
const MAX_URI_LENGTH = 8192
const MAX_RELAYS = 8
const MAX_LUD16_LENGTH = 320
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const ALLOWED_QUERY_PARAMETERS = new Set(['relay', 'secret', 'lud16'])

export interface ParsedNwcConnection extends NwcConnectionInfo {
  secretKey: Uint8Array
  conversationKey: Uint8Array
  clientPubkey: string
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

function normaliseRelay(value: string): string {
  if (value.length > 2048) {
    throw new NwcError('INVALID_CONNECTION', 'NWC relay URL is too long')
  }

  let relay: URL
  try {
    relay = new URL(value)
  } catch {
    throw new NwcError('INVALID_CONNECTION', 'NWC relay URL is invalid')
  }

  if (relay.protocol !== 'wss:') {
    throw new NwcError('INVALID_CONNECTION', 'NWC relays must use wss://')
  }
  if (relay.username || relay.password || relay.search || relay.hash) {
    throw new NwcError('INVALID_CONNECTION', 'NWC relay URL contains forbidden credentials, query or fragment')
  }
  return relay.toString()
}

export function parseNwcConnection(uri: string): ParsedNwcConnection {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_URI_LENGTH) {
    throw new NwcError('INVALID_CONNECTION', 'NWC connection URI is missing or too long')
  }

  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new NwcError('INVALID_CONNECTION', 'NWC connection URI is invalid')
  }

  if (url.protocol !== 'nostr+walletconnect:') {
    throw new NwcError('INVALID_CONNECTION', 'NWC connection URI must use nostr+walletconnect://')
  }
  if (url.username || url.password || url.hash) {
    throw new NwcError('INVALID_CONNECTION', 'NWC connection URI contains forbidden credentials or fragment')
  }
  if (url.port || (url.pathname !== '' && url.pathname !== '/')) {
    throw new NwcError('INVALID_CONNECTION', 'NWC connection URI contains a forbidden port or path')
  }
  if ([...url.searchParams.keys()].some((name) => !ALLOWED_QUERY_PARAMETERS.has(name))) {
    throw new NwcError('INVALID_CONNECTION', 'NWC connection URI contains an unsupported parameter')
  }

  const walletPubkey = url.hostname.toLowerCase()
  const secrets = url.searchParams.getAll('secret')
  const secret = secrets[0]
  const relayValues = url.searchParams.getAll('relay')
  if (secrets.length !== 1 || !HEX_64.test(walletPubkey) || !secret || !HEX_64.test(secret)) {
    throw new NwcError('INVALID_CONNECTION', 'NWC connection URI has an invalid wallet key or secret')
  }
  if (relayValues.length === 0 || relayValues.length > MAX_RELAYS) {
    throw new NwcError('INVALID_CONNECTION', `NWC connection URI must contain between 1 and ${MAX_RELAYS} relays`)
  }

  const relays = [...new Set(relayValues.map(normaliseRelay))]
  const secretKey = hexToBytes(secret)
  let conversationKey: Uint8Array | undefined
  try {
    const clientPubkey = getPublicKey(secretKey)
    conversationKey = nip44.v2.utils.getConversationKey(secretKey, walletPubkey)
    const lud16Values = url.searchParams.getAll('lud16')
    if (lud16Values.length > 1) {
      throw new NwcError('INVALID_CONNECTION', 'NWC connection URI contains duplicate lud16 values')
    }
    const lud16 = lud16Values[0]?.trim()
    if (lud16 && (lud16.length > MAX_LUD16_LENGTH || CONTROL_CHARS.test(lud16))) {
      throw new NwcError('INVALID_CONNECTION', 'NWC connection URI contains an invalid lud16 value')
    }
    return {
      walletPubkey,
      relays,
      secretKey,
      conversationKey,
      clientPubkey,
      ...(lud16 ? { lud16 } : {}),
    }
  } catch (error) {
    secretKey.fill(0)
    conversationKey?.fill(0)
    if (error instanceof NwcError) throw error
    throw new NwcError('INVALID_CONNECTION', 'NWC connection URI contains invalid key material')
  }
}

export function inspectNwcConnection(uri: string): NwcConnectionInfo {
  const parsed = parseNwcConnection(uri)
  try {
    return {
      walletPubkey: parsed.walletPubkey,
      relays: [...parsed.relays],
      ...(parsed.lud16 ? { lud16: parsed.lud16 } : {}),
    }
  } finally {
    parsed.secretKey.fill(0)
    parsed.conversationKey.fill(0)
  }
}
