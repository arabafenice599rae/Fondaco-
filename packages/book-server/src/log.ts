// Structured logs: one JSON object per line ({ ts, level, msg, ...fields }), bigint-safe. No dependency.
export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const
export type Level = keyof typeof LEVELS
export type Fields = Record<string, unknown>

export interface Logger {
  debug(msg: string, fields?: Fields): void
  info(msg: string, fields?: Fields): void
  warn(msg: string, fields?: Fields): void
  error(msg: string, fields?: Fields): void
  child(fields: Fields): Logger
}

const replacer = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v instanceof Error ? { name: v.name, message: v.message } : v)

/**
 * @param sink receives each serialized line (default: stdout). Tests pass a function to capture or silence logs.
 */
export function createLogger({ level = 'info', sink = (line: string) => { process.stdout.write(line + '\n') }, base = {}, now = () => new Date() }:
  { level?: Level; sink?: (line: string) => void; base?: Fields; now?: () => Date } = {}): Logger {
  const min = LEVELS[level]
  const write = (lvl: Exclude<Level, 'silent'>, msg: string, fields: Fields = {}) => {
    if (LEVELS[lvl] < min) return
    let line: string
    try { line = JSON.stringify({ ts: now().toISOString(), level: lvl, msg, ...base, ...fields }, replacer) }
    catch { line = JSON.stringify({ ts: now().toISOString(), level: lvl, msg, ...base, logError: 'unserializable fields' }) }
    sink(line)
  }
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (f) => createLogger({ level, sink, base: { ...base, ...f }, now }),
  }
}
