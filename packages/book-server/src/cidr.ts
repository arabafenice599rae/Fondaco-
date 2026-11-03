// IPv4/IPv6 CIDR matching for the /metrics allowlist. IPv4-mapped IPv6 (::ffff:a.b.c.d) matches IPv4 blocks.
function v4(ip: string): bigint | null {
  const p = ip.split('.')
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null
  return p.reduce((a, x) => (a << 8n) | BigInt(x), 0n)
}
function v6(ip: string): bigint | null {
  ip = ip.split('%')[0] as string
  const tail4 = ip.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (tail4) { const n = v4(tail4[2] as string); if (n == null) return null; ip = `${tail4[1]}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}` }
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const h = halves[0] ? (halves[0] as string).split(':') : [], t = halves.length === 2 && halves[1] ? (halves[1] as string).split(':') : []
  const fill = halves.length === 2 ? 8 - h.length - t.length : 0
  const g = [...h, ...Array<string>(fill).fill('0'), ...t]
  if (g.length !== 8 || g.some((x) => !/^[0-9a-fA-F]{1,4}$/.test(x))) return null
  return g.reduce((a, x) => (a << 16n) | BigInt(parseInt(x, 16)), 0n)
}
/** Parse an address into [family bits, value]; IPv4-mapped IPv6 → IPv4. */
export function parseIp(ip: string): [32 | 128, bigint] | null {
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7)
  const a = v4(ip)
  if (a != null) return [32, a]
  const b = v6(ip)
  return b != null ? [128, b] : null
}
export function inCidr(ip: string, cidr: string): boolean {
  const [net, bitsS] = cidr.split('/') as [string, string]
  const a = parseIp(ip), n = parseIp(net), bits = Number(bitsS)
  if (!a || !n || a[0] !== n[0] || !(bits >= 0 && bits <= a[0])) return false
  const shift = BigInt(a[0] - bits)
  return a[1] >> shift === n[1] >> shift
}
export const inAny = (ip: string, cidrs: readonly string[]) => cidrs.some((c) => inCidr(ip, c))
