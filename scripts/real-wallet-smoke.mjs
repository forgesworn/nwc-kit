#!/usr/bin/env node
/**
 * Exercises the built package against a real wallet service.
 *
 * The test suite proves the client is correct against a fake wallet that this
 * repo also wrote, which is a weaker claim than it sounds: both sides share the
 * author's assumptions. This script closes that gap by pointing the shipped
 * bundle at something the repo did not write.
 *
 * Usage:
 *   npm run build
 *   node scripts/real-wallet-smoke.mjs /path/to/nwc-uri.txt
 *   node scripts/real-wallet-smoke.mjs /path/to/nwc-uri.txt --pay lnbc...
 *
 * The URI is read from an owner-only file rather than argv or the environment,
 * because it is a spending capability: argv is visible in `ps`, and environment
 * variables leak into child processes and crash reports. It is never printed.
 * Only read-only methods run unless --pay is passed explicitly.
 */
import { readFile, stat } from 'node:fs/promises'
import { NwcClient, NwcError, inspectNwcConnection } from '../dist/index.js'
import { NwcTransactionHistoryClient } from '../dist/extensions/05.js'

const [, , uriPath, ...rest] = process.argv
if (!uriPath) {
  console.error('usage: real-wallet-smoke.mjs <path-to-uri-file> [--pay <bolt11>]')
  process.exit(2)
}

const payIndex = rest.indexOf('--pay')
const payInvoice = payIndex === -1 ? undefined : rest[payIndex + 1]

const info = await stat(uriPath)
if (!info.isFile()) {
  console.error(`${uriPath} is not a regular file`)
  process.exit(2)
}
if ((info.mode & 0o077) !== 0) {
  console.error(`${uriPath} is group- or world-accessible; chmod 600 it first`)
  process.exit(2)
}

const uri = (await readFile(uriPath, 'utf8')).trim()

// inspectNwcConnection deliberately returns everything except the secret, which
// is exactly what a log line should ever see.
let connection
try {
  connection = inspectNwcConnection(uri)
} catch (error) {
  console.error(`connection string rejected: ${describe(error)}`)
  process.exit(1)
}

console.log('wallet  ', connection.walletPubkey)
console.log('relays  ', connection.relays.join(', '))
if (connection.lud16) console.log('lud16   ', connection.lud16)
console.log()

function describe(error) {
  if (error instanceof NwcError) {
    return error.walletCode ? `${error.code} (${error.walletCode}) ${error.message}` : `${error.code} ${error.message}`
  }
  return error instanceof Error ? `${error.name} ${error.message}` : String(error)
}

const results = []

async function step(name, action) {
  const started = Date.now()
  try {
    const value = await action()
    const ms = Date.now() - started
    results.push({ name, ok: true, ms })
    console.log(`PASS  ${name.padEnd(20)} ${String(ms).padStart(6)}ms`)
    if (value !== undefined) {
      console.log(`      ${JSON.stringify(value).slice(0, 300)}`)
    }
    return value
  } catch (error) {
    const ms = Date.now() - started
    results.push({ name, ok: false, ms, error: describe(error) })
    console.log(`FAIL  ${name.padEnd(20)} ${String(ms).padStart(6)}ms`)
    console.log(`      ${describe(error)}`)
    return undefined
  }
}

const client = new NwcTransactionHistoryClient(uri, { requestTimeoutMs: 30_000, infoTimeoutMs: 15_000 })

try {
  const capabilities = await step('connect', () => client.connect())
  if (capabilities) {
    // Only ask for what the wallet said it can do. A wallet that advertises a
    // method it cannot serve is itself worth knowing about.
    const has = (method) => capabilities.methods.includes(method)
    if (has('get_info')) await step('get_info', () => client.getInfo())
    if (has('get_balance')) await step('get_balance', () => client.getBalance())
    if (capabilities.extensions.includes('05') && has('list_transactions')) {
      await step('list_transactions', () => client.listTransactions({ limit: 5 }))
    } else {
      console.log(`SKIP  list_transactions    extension 05 not advertised`)
    }
    if (payInvoice) {
      if (!has('pay_invoice')) {
        console.log('SKIP  pay_invoice          not advertised by this connection')
      } else {
        console.log('\nSpending real satoshis in 3 seconds. Ctrl-C to abort.')
        await new Promise((resolve) => setTimeout(resolve, 3000))
        await step('pay_invoice', () => client.payInvoice({ invoice: payInvoice }))
      }
    }
  }
} finally {
  client.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
