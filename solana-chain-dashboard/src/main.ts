import { CLUSTERS, type ClusterDef, type ProgramDef } from './programs'
import { resolveEndpoint, storeKey } from './endpoint'
import { parseLogMessages, type DecodedField } from './decoder'
import { SessionStats, type TradeRow } from './stats'
import { SolanaFeed, type FeedStatus, type LogNotification } from './ws'
import { DashboardUI, type FeedRow } from './ui'
import { lamportsToSol, grouped, shortAddr } from './format'

const ui = new DashboardUI()
const stats = new SessionStats()

const clusterSelect = document.getElementById('cluster') as HTMLSelectElement
const programSelect = document.getElementById('program') as HTMLSelectElement
const endpointInput = document.getElementById('endpoint') as HTMLInputElement
const connectButton = document.getElementById('connect') as HTMLButtonElement
const programNote = document.getElementById('program-note') as HTMLParagraphElement
const keyPrompt = document.getElementById('key-prompt') as HTMLDivElement
const keyInput = document.getElementById('rpc-key') as HTMLInputElement
const keySave = document.getElementById('key-save') as HTMLButtonElement
const repoLink = document.getElementById('repo-link') as HTMLAnchorElement

let feed: SolanaFeed | null = null
let currentCluster: ClusterDef = CLUSTERS[0]!
let currentProgram: ProgramDef = currentCluster.programs[0]!

function fieldByName(fields: readonly DecodedField[], name: string): DecodedField | undefined {
  return fields.find((f) => f.name === name)
}

function tradeRowFrom(fields: readonly DecodedField[]): TradeRow | null {
  const map = currentProgram.tradeMap
  if (map === null) return null
  const wallet = fieldByName(fields, map.walletField)
  const sol = fieldByName(fields, map.solLamportsField)
  const isBuy = fieldByName(fields, map.isBuyField)
  if (sol === undefined || typeof sol.value !== 'bigint' || isBuy === undefined || typeof isBuy.value !== 'boolean') {
    return null
  }
  const walletStr = wallet !== undefined && typeof wallet.value === 'string' ? wallet.value : null
  return { wallet: walletStr, solLamports: sol.value, isBuy: isBuy.value }
}

function handleNotification(n: LogNotification): void {
  const now = new Date()
  const items = parseLogMessages(n.logs, currentProgram)
  let countedFailed = false

  for (const item of items) {
    if (item.type === 'instruction') {
      if (!currentProgram.showInstructions) continue
      stats.recordEvent(now.getTime())
      ui.appendRow({
        time: now.toLocaleTimeString('en-GB'),
        slot: n.slot,
        tag: 'ix',
        tagClass: '',
        line1: item.name,
        line2: null,
      })
      continue
    }

    if (item.type === 'log') {
      stats.recordEvent(now.getTime())
      ui.appendRow({
        time: now.toLocaleTimeString('en-GB'),
        slot: n.slot,
        tag: 'log',
        tagClass: '',
        line1: item.text,
        line2: null,
      })
      continue
    }

    stats.recordEvent(now.getTime())
    if (n.err && !countedFailed) {
      countedFailed = true
      stats.recordFailedTx()
    }

    if (item.event.kind === 'known') {
      const row = tradeRowFrom(item.event.fields)
      if (row !== null && !n.err) stats.recordTrade(row)
      ui.appendRow(knownEventRow(now, n, item.event.name, item.event.fields, row, n.err))
    } else {
      ui.appendRow({
        time: now.toLocaleTimeString('en-GB'),
        slot: n.slot,
        tag: 'raw',
        tagClass: '',
        line1: 'undecoded data: ' + (item.event.discriminator ?? 'no discriminator') + ' (' + item.event.reason + ')',
        line2: null,
      })
    }
  }

  if (!n.err) ui.setSlot(n.slot)
}

function knownEventRow(
  now: Date,
  n: LogNotification,
  name: string,
  fields: readonly DecodedField[],
  row: TradeRow | null,
  failed: boolean,
): FeedRow {
  const time = now.toLocaleTimeString('en-GB')
  const failedSuffix = failed ? ' [tx failed]' : ''

  if (row !== null) {
    const mint = fieldByName(fields, currentProgram.tradeMap?.mintField ?? '')
    const tokens = fieldByName(fields, currentProgram.tradeMap?.tokenAmountField ?? '')
    const line1 =
      (row.isBuy ? 'buy ' : 'sell ') +
      lamportsToSol(row.solLamports) + ' SOL' +
      (tokens !== undefined && typeof tokens.value === 'bigint' ? ' for ' + grouped(tokens.value) + ' tokens' : '') +
      failedSuffix
    const line2 =
      'mint ' + (mint !== undefined && typeof mint.value === 'string' ? shortAddr(mint.value) : '?') +
      (row.wallet !== null ? '  user ' + shortAddr(row.wallet) : '')
    return { time, slot: n.slot, tag: row.isBuy ? 'buy' : 'sell', tagClass: row.isBuy ? 'buy' : 'sell', line1, line2 }
  }

  if (name === 'CreateEvent') {
    const nm = fieldByName(fields, 'name')
    const sym = fieldByName(fields, 'symbol')
    const mint = fieldByName(fields, 'mint')
    const creator = fieldByName(fields, 'creator') ?? fieldByName(fields, 'user')
    const line1 =
      'new token ' +
      (sym !== undefined && typeof sym.value === 'string' ? sym.value : '?') +
      (nm !== undefined && typeof nm.value === 'string' ? ' (' + nm.value + ')' : '') +
      failedSuffix
    const line2 =
      'mint ' + (mint !== undefined && typeof mint.value === 'string' ? shortAddr(mint.value) : '?') +
      (creator !== undefined && typeof creator.value === 'string' ? '  by ' + shortAddr(creator.value) : '')
    return { time, slot: n.slot, tag: 'create', tagClass: 'create', line1, line2 }
  }

  const line1 = name + failedSuffix
  const line2 = fields.map((f) => f.name + '=' + shortish(f.value)).join('  ')
  return { time, slot: n.slot, tag: name.replace('Event', '').toLowerCase(), tagClass: 'complete', line1, line2 }
}

function shortish(v: string | number | boolean | bigint): string {
  if (typeof v === 'string') return shortAddr(v)
  if (typeof v === 'boolean') return String(v)
  return grouped(v)
}

function onStatus(status: FeedStatus): void {
  ui.setStatus(status, Date.now())
  if (status.state === 'live') {
    keyPrompt.hidden = true
    connectButton.textContent = 'disconnect'
    connectButton.classList.add('stop')
  } else if (status.state === 'idle') {
    connectButton.textContent = 'connect'
    connectButton.classList.remove('stop')
  }
}

function startFeed(freshSession: boolean): void {
  stopFeed()
  const endpoint = endpointInput.value.trim()
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    ui.setNotice('endpoint is not a valid URL: ' + endpoint)
    return
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    ui.setNotice('endpoint protocol must be ws: or wss:, got ' + parsed.protocol)
    return
  }

  ui.setNotice(null)
  ui.clearFeed()
  if (freshSession) stats.reset()
  ui.setFeedMeta(currentProgram.label + ' / ' + currentCluster.id, endpoint)

  feed = new SolanaFeed({
    endpoint,
    programId: currentProgram.id,
    commitment: 'confirmed',
    stallTimeoutMs: currentCluster.stallTimeoutMs,
    onStatus,
    onNotification: handleNotification,
    onNotice: (message) => ui.setNotice(message),
    onRefused: () => {
      keyPrompt.hidden = false
      ui.setNotice(null)
    },
  })
  feed.start()
}

function stopFeed(): void {
  if (feed !== null) {
    feed.stop()
    feed = null
  }
}

function populatePrograms(): void {
  programSelect.textContent = ''
  for (const p of currentCluster.programs) {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.label
    programSelect.appendChild(opt)
  }
  currentProgram = currentCluster.programs[0]!
  programNote.textContent = currentProgram.note
}

function populateClusters(): void {
  for (const c of CLUSTERS) {
    const opt = document.createElement('option')
    opt.value = c.id
    opt.textContent = c.label
    clusterSelect.appendChild(opt)
  }
}

clusterSelect.addEventListener('change', () => {
  const found = CLUSTERS.find((c) => c.id === clusterSelect.value)
  if (found === undefined) return
  currentCluster = found
  endpointInput.value = resolveEndpoint(currentCluster.id)
  populatePrograms()
})

programSelect.addEventListener('change', () => {
  const found = currentCluster.programs.find((p) => p.id === programSelect.value)
  if (found === undefined) return
  currentProgram = found
  programNote.textContent = found.note
  if (feed !== null) startFeed(true)
})

connectButton.addEventListener('click', () => {
  if (feed !== null) {
    stopFeed()
    ui.setNotice(null)
    keyPrompt.hidden = true
    return
  }
  startFeed(true)
})

keySave.addEventListener('click', () => {
  const key = keyInput.value.trim()
  if (key === '') {
    keyInput.focus()
    return
  }
  storeKey(key)
  keyPrompt.hidden = true
  endpointInput.value = resolveEndpoint(currentCluster.id)
  startFeed(true)
})

populateClusters()
endpointInput.value = resolveEndpoint(currentCluster.id)
populatePrograms()

setInterval(() => {
  const now = Date.now()
  ui.renderStats(stats.snapshot(now))
  ui.refreshStatus(now)
}, 500)

repoLink.href = 'https://github.com/alex1997654/web3-projects/tree/main/solana-chain-dashboard'