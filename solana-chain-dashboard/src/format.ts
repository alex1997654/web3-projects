export function lamportsToSol(lamports: bigint): string {
  const sol = Number(lamports) / 1e9
  return sol.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
}

export function grouped(n: bigint | number): string {
  return n.toLocaleString('en-US')
}

export function shortAddr(addr: string, edge: number = 4): string {
  if (addr.length <= edge * 2 + 1) return addr
  return addr.slice(0, edge) + '..' + addr.slice(-edge)
}
