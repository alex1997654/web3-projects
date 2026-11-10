import { BorshError, BorshReader } from './borsh'
import type { FieldDef, LayoutDef, ProgramDef } from '../programs'

export type FieldValue = string | number | boolean | bigint

export interface DecodedField {
  readonly name: string
  readonly kind: FieldDef['kind']
  readonly value: FieldValue
}

export type ProgramDataEvent =
  | { readonly kind: 'known'; readonly name: string; readonly fields: readonly DecodedField[]; readonly tailBytes?: number }
  | { readonly kind: 'unknown'; readonly discriminator: string | null; readonly reason: string }

export type LogItem =
  | { readonly type: 'instruction'; readonly name: string }
  | { readonly type: 'log'; readonly text: string }
  | { readonly type: 'data'; readonly payloadBase64: string; readonly event: ProgramDataEvent }

const RE_INSTRUCTION = /^Program log: Instruction: (.+)$/
const RE_DATA = /^Program data: (.+)$/
const RE_LOG = /^Program log: (.+)$/
// Base58 pubkey charset, no spaces: keeps 'Program log: Instruction: Success'
// style lines out of the stack machine.
const RE_INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[\d+\]$/
const RE_FINISHED = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed.*)$/

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function hex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

function readField(reader: BorshReader, field: FieldDef): FieldValue {
  switch (field.kind) {
    case 'u64':
      return reader.u64()
    case 'i64':
      return reader.i64()
    case 'bool':
      return reader.bool()
    case 'pubkey':
      return reader.pubkey()
    case 'string':
      return reader.string()
  }
}

/**
 * Decode one 'Program data:' payload as an Anchor event. The first 8 bytes
 * are sha256('event:<Name>') truncated, the rest is a borsh-serialized body.
 * Several program upgrades share one discriminator with different bodies,
 * so every registered layout is tried until one consumes the body exactly;
 * partial reads never leak out as success.
 */
export function decodeAnchorEvent(payload: Uint8Array, layouts: readonly LayoutDef[]): ProgramDataEvent {
  if (payload.length < 8) {
    return { kind: 'unknown', discriminator: null, reason: 'payload shorter than an 8-byte discriminator (' + payload.length + ' bytes)' }
  }
  const discriminator = hex(payload.subarray(0, 8))
  const candidates = layouts.filter((l) => l.discriminator === discriminator)
  if (candidates.length === 0) {
    return { kind: 'unknown', discriminator, reason: 'no layout registered for this discriminator' }
  }

  const body = payload.subarray(8)
  const failures: string[] = []
  // Pass 1: exact layouts must consume the body completely.
  // Pass 2: prefix layouts consume a verified head; the remainder is
  // reported, not guessed at.
  for (const pass of ['exact', 'prefix'] as const) {
    for (const layout of candidates) {
      if ((layout.mode ?? 'exact') !== pass) continue
      const reader = new BorshReader(body)
      try {
        const fields = layout.fields.map((f) => ({ name: f.name, kind: f.kind, value: readField(reader, f) }))
        if (pass === 'exact') {
          if (reader.remaining !== 0) {
            failures.push(layout.name + ' left ' + reader.remaining + ' bytes unconsumed')
            continue
          }
          return { kind: 'known', name: layout.name, fields }
        }
        return { kind: 'known', name: layout.name, fields, tailBytes: reader.remaining }
      } catch (e) {
        failures.push(layout.name + ' (' + pass + '): ' + (e instanceof BorshError ? e.message : String(e)))
      }
    }
  }
  return { kind: 'unknown', discriminator, reason: failures.join('; ') }
}

/**
 * Turn the log array of one transaction notification into typed items:
 * Anchor instruction names, program log lines, and decoded event data.
 *
 * A logsNotification carries the logs of the WHOLE transaction, so a
 * pump.fun buy also contains the Jupiter or PumpSwap legs, each with
 * their own 'Program data:' events. The invoke/success nesting is
 * tracked as a stack and only lines emitted by the watched program
 * are attributed to it; other programs' lines are ignored entirely.
 */
export function parseLogMessages(logs: readonly string[], program: ProgramDef): LogItem[] {
  const items: LogItem[] = []
  const stack: string[] = []
  for (const line of logs) {
    const invoke = line.match(RE_INVOKE)
    if (invoke) {
      stack.push(invoke[1]!)
      continue
    }
    const finished = line.match(RE_FINISHED)
    if (finished) {
      const idx = stack.lastIndexOf(finished[1]!)
      if (idx !== -1) stack.length = idx
      continue
    }
    if ((stack[stack.length - 1] ?? null) !== program.id) continue
    const ix = line.match(RE_INSTRUCTION)
    if (ix) {
      items.push({ type: 'instruction', name: ix[1]! })
      continue
    }
    const data = line.match(RE_DATA)
    if (data) {
      const payloadBase64 = data[1]!
      let payload: Uint8Array
      try {
        payload = decodeBase64(payloadBase64)
      } catch {
        items.push({ type: 'data', payloadBase64, event: { kind: 'unknown', discriminator: null, reason: 'invalid base64 in Program data line' } })
        continue
      }
      items.push({ type: 'data', payloadBase64, event: decodeAnchorEvent(payload, program.layouts) })
      continue
    }
    const log = line.match(RE_LOG)
    if (log) items.push({ type: 'log', text: log[1]! })
  }
  return items
}
