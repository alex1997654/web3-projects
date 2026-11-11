import { CLUSTERS } from './programs'

/**
 * RPC endpoint resolution for a page that runs entirely in the browser.
 *
 * Keyless public Solana endpoints (api.mainnet-beta.solana.com and every
 * other one tried) refuse any browser-origin WebSocket with HTTP 403; only
 * non-browser clients that send no Origin header get through. A keyed free
 * provider endpoint is therefore the default: Helius accepts browser
 * origins and authenticates with the key in the URL.
 *
 * DEMO_RPC_KEY ships a free-tier key so the demo connects on the first
 * try (user approved fallback, operator directive 2026-11-11). When it is
 * empty, exhausted, or rejected, the feed gives up after two refused
 * handshakes and the UI asks the visitor to paste their own key, with a
 * link to create a free one. A visitor-supplied key is kept in
 * localStorage only and is sent to the RPC endpoint alone.
 */
export const DEMO_RPC_KEY = ''

export const CREATE_KEY_URL = 'https://dashboard.helius.com/'

const KEY_STORAGE = 'solana-dashboard-rpc-key'

function keyedEndpoint(clusterId: string, key: string): string {
  const host = clusterId === 'devnet' ? 'devnet.helius-rpc.com' : 'mainnet.helius-rpc.com'
  return `wss://${host}/?api-key=${encodeURIComponent(key)}`
}

function publicEndpoint(clusterId: string): string {
  const cluster = CLUSTERS.find((c) => c.id === clusterId)
  // user approved fallback: without a key, fall back to the keyless public
  // endpoint. Browsers are refused there, which is what surfaces the key
  // prompt instead of a silent failure.
  return cluster?.wsDefault ?? 'wss://api.mainnet-beta.solana.com'
}

export function storedKey(): string | null {
  try {
    return window.localStorage.getItem(KEY_STORAGE)
  } catch {
    return null
  }
}

export function storeKey(key: string): void {
  try {
    window.localStorage.setItem(KEY_STORAGE, key)
  } catch {
    // Private browsing or blocked storage: the key still works for this
    // session through the endpoint field, it just will not persist.
  }
}

export function effectiveKey(): string {
  const stored = storedKey()
  return stored !== null && stored !== '' ? stored : DEMO_RPC_KEY
}

export function resolveEndpoint(clusterId: string): string {
  const key = effectiveKey()
  return key !== '' ? keyedEndpoint(clusterId, key) : publicEndpoint(clusterId)
}
