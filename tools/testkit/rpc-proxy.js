// A JSON-RPC proxy in front of a node (anvil) whose behaviour tests can script, request by request:
//   before(req)  → undefined (forward) | { status, body?, delayMs?, hang? }        e.g. 429, 503, timeout, hang
//   after(req, result) → result | modified result                                e.g. shuffle logs, null block, failing multicall entries
// Counts requests by method. Used by fault-injection, event-order and reorg-during-catch-up tests.
import http from 'node:http'

export async function startRpcProxy(upstream, { before, after } = {}) {
  const counts = {}
  const hooks = { before, after }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let msg
    try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { res.writeHead(400).end(); return }
    const one = Array.isArray(msg) ? null : msg
    if (one) counts[one.method] = (counts[one.method] || 0) + 1
    const pre = one && hooks.before ? await hooks.before(one) : undefined
    if (pre) {
      if (pre.delayMs) await new Promise((r) => setTimeout(r, pre.delayMs))
      if (pre.hang) return // never answer: the client must time out
      if (pre.status) {
        // like real providers: a custom body (e.g. an HTML/text error page) is not labelled as JSON
        res.writeHead(pre.status, { 'content-type': pre.body != null ? 'text/plain' : 'application/json' })
        res.end(pre.body ?? JSON.stringify({ jsonrpc: '2.0', id: one.id, error: { code: -32005, message: `injected ${pre.status}` } }))
        return
      }
      if (pre.response !== undefined) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: one.id, ...pre.response })); return }
    }
    const up = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) })
    let out = await up.json()
    if (one && hooks.after && out && 'result' in out) out = { ...out, result: await hooks.after(one, out.result) }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    counts,
    set(h) { Object.assign(hooks, h) },
    clear() { hooks.before = undefined; hooks.after = undefined },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }),
  }
}
