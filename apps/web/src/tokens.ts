// Display-only metadata for token symbols (glyph and colours from the prototype). Addresses, decimals and names come from
// the app configuration; unknown symbols get a neutral glyph and colours derived from the symbol.
export interface TokenView { address: `0x${string}`; symbol: string; decimals: number; name: string; stable: boolean }

const LOOK: Record<string, { g: string; c: [string, string]; d: number }> = {
  WETH: { g: 'E', c: ['#7C93FF', '#3149E2'], d: 4 },
  WBTC: { g: 'B', c: ['#F6B466', '#C9741F'], d: 6 },
  USDC: { g: 'C', c: ['#4CC3BC', '#1C7F86'], d: 2 },
  USDT: { g: 'T', c: ['#8BCB9B', '#3A7F55'], d: 2 },
  DAI: { g: 'D', c: ['#E2BC5C', '#A8831B'], d: 2 },
  LINK: { g: 'L', c: ['#8FA8FF', '#4561D6'], d: 3 },
  UNI: { g: 'U', c: ['#E58FC0', '#A9437A'], d: 3 },
  ARB: { g: 'A', c: ['#86C9F2', '#2F78B5'], d: 2 },
}
const hue = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7)
export const look = (sym: string) => LOOK[sym] ?? { g: (sym[0] ?? '?').toUpperCase(), c: [`hsl(${hue(sym)} 55% 65%)`, `hsl(${hue(sym)} 55% 38%)`] as [string, string], d: 4 }
export const displayDecimals = (sym: string): number => look(sym).d
const STABLES = new Set(['USDC', 'USDT', 'DAI'])
export const isStableSymbol = (sym: string): boolean => STABLES.has(sym)

export const coin = (sym: string, size?: number): string => {
  const l = look(sym)
  return `<span class="coin" style="--c1:${l.c[0]};--c2:${l.c[1]}${size ? `;width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px` : ''}" aria-hidden="true">${l.g}</span>`
}
export const coins2 = (a: string, b: string, size?: number): string => `<span class="coins2">${coin(a, size)}${coin(b, size)}</span>`
/** `hint`: read by screen readers after the visible symbol (the accessible name starts with what is shown, WCAG 2.5.3) */
export const tokBtn = (sym: string, hint = ''): string => `${coin(sym)}<span>${sym}</span>${hint ? `<span class="sr-only"> · ${hint}</span>` : ''}<svg class="ic sm chev" aria-hidden="true"><use href="#i-down"/></svg>`
