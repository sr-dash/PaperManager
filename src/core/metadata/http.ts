export type Fetch = typeof globalThis.fetch

export const USER_AGENT = 'PaperManager/0.1 (+https://github.com/sr-dash/PaperManager)'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string
  ) {
    super(`HTTP ${status} from ${new URL(url).host}`)
  }
}

export async function getJson<T>(
  fetch: Fetch,
  url: string,
  headers: Record<string, string> = {},
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) throw new HttpError(res.status, url)
  return (await res.json()) as T
}

export async function getText(fetch: Fetch, url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) throw new HttpError(res.status, url)
  return res.text()
}

/** Split "Family, Given" (ADS style) or "Given Family" (arXiv style) into parts. */
export function splitName(name: string): { family: string; given?: string } {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  const comma = trimmed.indexOf(',')
  if (comma >= 0) {
    const given = trimmed.slice(comma + 1).trim()
    return { family: trimmed.slice(0, comma).trim(), ...(given ? { given } : {}) }
  }
  const parts = trimmed.split(' ')
  if (parts.length === 1) return { family: trimmed }
  // Keep lowercase particles with the family name: "Anne van Ballegooijen" → "van Ballegooijen".
  let i = parts.length - 1
  while (i > 1 && /^(van|von|de|der|den|del|della|di|da|du|le|la|dos|das)$/.test(parts[i - 1]!)) i--
  return { family: parts.slice(i).join(' '), given: parts.slice(0, i).join(' ') }
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}
