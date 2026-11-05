// The contract the app signs for and sends to, shown in full with its Sourcify page (D-61): the confirmation sheet and
// Impostazioni use it for the active network. In the DEMO build the address is simulated, so there is no link.
import { esc } from './fmt.js'

export const sourcifyUrl = (chainId: number, address: string): string => `https://repo.sourcify.dev/${chainId}/${address}`

export function contractHTML(address: string | null, chainId: number): string {
  if (!address) return 'non configurato'
  const link = __DEMO__ ? '' : ` <a class="src-link" href="${esc(sourcifyUrl(chainId, address))}" target="_blank" rel="noopener noreferrer">Sourcify →</a>`
  return `<span class="addr-full">${esc(address)}</span>${link}`
}
