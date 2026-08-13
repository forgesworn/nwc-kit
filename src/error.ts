import type { NwcErrorCode } from './types.js'

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

export function safeMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const cleaned = value.replace(CONTROL_CHARS, ' ').trim().slice(0, 512)
  return cleaned || fallback
}

export class NwcError extends Error {
  readonly code: NwcErrorCode
  readonly walletCode?: string

  constructor(code: NwcErrorCode, message: string, walletCode?: string) {
    super(message)
    this.name = 'NwcError'
    this.code = code
    if (walletCode !== undefined) this.walletCode = walletCode
  }
}
