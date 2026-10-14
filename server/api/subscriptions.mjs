import { Router } from 'express'
import dns from 'node:dns/promises'
import net from 'node:net'
import { parseNodes, resolveSubscription } from '../lib/subscribe.mjs'
import { renameNodes } from '../lib/rename.mjs'

/** Block private/loopback/link-local targets (SSRF guard for subscription URLs). */
function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0
    )
  }
  if (net.isIP(ip) === 6) {
    const l = ip.toLowerCase()
    return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')
  }
  return true
}

async function assertPublicUrl(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    throw new Error('bad url')
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http(s) allowed')
  if (u.username || u.password) throw new Error('userinfo not allowed')
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => [])
  if (!addrs.length) throw new Error('dns lookup failed')
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('private target blocked')
}

/** Parse + rename; shared by preview and save paths. */
export async function parseAndRename({ url, content, name, renameOptions }) {
  if (url && !content) await assertPublicUrl(url)
  const { format, nodes, skipped } = await resolveSubscription({ url, content })
  const { nodes: renamed, preview, groups, excluded, disabled } = renameNodes(nodes, renameOptions, name)
  return {
    format,
    nodes: renamed,
    preview,
    groups,
    skipped,
    excluded,
    disabled,
    summaries: renamed.map((n) => ({ tag: n.tag, originalTag: n.originalTag, type: n.type, server: n.server })),
  }
}

export function subscriptionsRouter(store) {
  const r = Router()

  r.get('/', (req, res) => {
    res.json({ subscriptions: store.listSubscriptions() })
  })

  r.post('/preview', async (req, res) => {
    try {
      const p = await parseAndRename(req.body || {})
      res.json({
        format: p.format,
        nodes: p.summaries,
        skipped: p.skipped,
        excluded: p.excluded,
        disabled: p.disabled,
        preview: p.preview,
        groups: p.groups,
      })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  r.post('/', async (req, res) => {
    try {
      const { url, content, name, renameOptions } = req.body || {}
      if (!name || !String(name).trim()) throw new Error('name required')
      const p = await parseAndRename({ url, content, name, renameOptions })
      const saved = store.saveSubscription({
        name: String(name).trim(), url: url || '', content: content || '',
        format: p.format, renameOptions: renameOptions || {}, nodes: p.nodes,
      })
      store.kvSet(`subgroups.${saved.id}`, JSON.stringify(p.groups))
      res.json({ id: saved.id, name: saved.name, nodeCount: p.nodes.length, skipped: p.skipped })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  r.patch('/:id', async (req, res) => {
    try {
      const sub = store.getSubscription(req.params.id)
      if (!sub) return res.status(404).json({ error: 'not found' })
      const { name, url, content, renameOptions } = req.body || {}
      const nextUrl = url !== undefined ? url : sub.url
      const nextContent = content !== undefined ? content : sub.content
      const nextRename = renameOptions !== undefined ? renameOptions : sub.renameOptions
      const needRefetch = url !== undefined || content !== undefined || renameOptions !== undefined
      let nodes = store.getSubscriptionNodes(sub.id)
      let fmt = sub.format
      let skipped = []
      let groups = store.kvGetJson(`subgroups.${sub.id}`, [])
      if (needRefetch) {
        const p = await parseAndRename({ url: nextUrl, content: nextContent, name: name || sub.name, renameOptions: nextRename })
        nodes = p.nodes
        fmt = p.format
        skipped = p.skipped
        groups = p.groups
      }
      const saved = store.saveSubscription({
        id: sub.id, name: name !== undefined ? String(name) : sub.name,
        url: nextUrl, content: nextContent, format: fmt,
        renameOptions: nextRename, nodes,
      })
      store.kvSet(`subgroups.${sub.id}`, JSON.stringify(groups))
      res.json({ id: saved.id, name: saved.name, nodeCount: nodes.length, skipped })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  r.delete('/:id', (req, res) => {
    store.deleteSubscription(req.params.id)
    store.kvSet(`subgroups.${req.params.id}`, JSON.stringify([]))
    res.json({ ok: true })
  })

  r.post('/:id/refresh', async (req, res) => {
    try {
      const sub = store.getSubscription(req.params.id)
      if (!sub) return res.status(404).json({ error: 'not found' })
      if (!sub.url) throw new Error('node-mode subscription has no url to refresh')
      const renameOptions = req.body?.renameOptions || sub.renameOptions
      const p = await parseAndRename({ url: sub.url, name: sub.name, renameOptions })
      const saved = store.saveSubscription({
        id: sub.id, name: sub.name, url: sub.url, content: sub.content,
        format: p.format, renameOptions, nodes: p.nodes,
      })
      store.kvSet(`subgroups.${sub.id}`, JSON.stringify(p.groups))
      res.json({ id: saved.id, name: saved.name, nodeCount: p.nodes.length, skipped: p.skipped })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  // Latency: TCP dial to each node's server:port, measuring connect time.
  // (Full end-to-end handshakes per protocol are out of scope for v1.)
  r.post('/nodes/latency', async (req, res) => {
    try {
      const { url, content, name, renameOptions, tags = [], timeoutMs = 8000 } = req.body || {}
      const p = await parseAndRename({ url, content, name, renameOptions })
      const byTag = new Map(p.nodes.map((n) => [n.tag, n]))
      const results = await Promise.all(
        tags.map(
          (tag) =>
            new Promise((resolve) => {
              const node = byTag.get(tag)
              if (!node) return resolve({ ok: false, error: 'node not found' })
              const t0 = Date.now()
              const sock = net.connect({ host: node.server, port: Number(node.server_port) || 443 })
              const done = (r) => {
                sock.destroy()
                resolve(r)
              }
              sock.setTimeout(Math.min(Math.max(Number(timeoutMs) || 8000, 1000), 30000))
              sock.on('connect', () => done({ ok: true, ms: Date.now() - t0 }))
              sock.on('timeout', () => done({ ok: false, error: 'timeout' }))
              sock.on('error', (e) => done({ ok: false, error: String(e.code || e.message) }))
            }),
        ),
      )
      res.json({ results })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  return r
}
