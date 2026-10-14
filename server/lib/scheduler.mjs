// Background schedulers: subscription refresh (24h) and rule-set update (7d).
// Runs inside the panel process; last-run timestamps persist in the kv store.
// Failures never throw: old nodes / old rule-sets are kept and the error is logged.
import { parseAndRename } from '../api/subscriptions.mjs'
import { profileRulesetTags, refreshRulesets } from './rulesets.mjs'
import { deployNow } from './service.mjs'

const SUB_INTERVAL_MS = 24 * 3600 * 1000
const RULESET_INTERVAL_MS = 7 * 24 * 3600 * 1000
const TICK_MS = 5 * 60 * 1000

async function refreshSubscriptions(store) {
  let changed = 0
  for (const sub of store.listSubscriptions()) {
    if (!sub.url) continue // node-mode: nothing to re-fetch
    try {
      const p = await parseAndRename({ url: sub.url, name: sub.name, renameOptions: sub.renameOptions })
      store.saveSubscription({
        id: sub.id, name: sub.name, url: sub.url, content: sub.content,
        format: p.format, renameOptions: sub.renameOptions, nodes: p.nodes,
      })
      store.kvSet(`subgroups.${sub.id}`, JSON.stringify(p.groups))
      changed++
    } catch (e) {
      console.log(`[proxybox] subscription refresh failed for ${sub.name}: ${String(e.message || e)} (kept old nodes)`)
    }
  }
  return changed
}

export function startSchedulers(ctx) {
  const { store, paths } = ctx

  const due = (key, interval) => {
    const last = Number(store.kvGet(`sched.${key}`) || 0)
    return Date.now() - last >= interval
  }
  const mark = (key) => store.kvSet(`sched.${key}`, String(Date.now()))

  async function tick() {
    try {
      if (due('subscriptions', SUB_INTERVAL_MS)) {
        const n = await refreshSubscriptions(store)
        mark('subscriptions')
        console.log(`[proxybox] scheduled subscription refresh done (${n} updated)`)
      }
    } catch (e) {
      console.log('[proxybox] subscription scheduler error:', String(e.message || e))
    }
    try {
      if (due('rulesets', RULESET_INTERVAL_MS)) {
        const tags = profileRulesetTags(store.getProfile())
        const r = await refreshRulesets(paths.rulesetDir, tags)
        mark('rulesets')
        console.log(`[proxybox] scheduled ruleset refresh: ${r.downloaded.length} updated, ${r.failed.length} failed`)
        if (r.downloaded.length) {
          // Re-deploy so the new rule data takes effect.
          await deployNow({ ...ctx, clashApi: { port: 9095, secret: store.kvGet('clash.secret') || '' } })
        }
      }
    } catch (e) {
      console.log('[proxybox] ruleset scheduler error:', String(e.message || e))
    }
  }

  // First tick shortly after boot (staggered), then every TICK_MS.
  setTimeout(tick, 60 * 1000)
  const timer = setInterval(tick, TICK_MS)
  timer.unref?.()

  // Traffic sampler: every 60s read cumulative counters from the clash API
  // and accumulate per-day deltas. Silent when the core is unreachable.
  const TRAFFIC_INTERVAL_MS = 60 * 1000
  async function sampleTraffic() {
    try {
      const secret = store.kvGet('clash.secret') || ''
      const ctl = new AbortController()
      const to = setTimeout(() => ctl.abort(), 8000)
      try {
        const res = await fetch('http://127.0.0.1:9095/traffic', {
          headers: { Authorization: `Bearer ${secret}` },
          signal: ctl.signal,
        })
        if (!res.ok || !res.body) return
        const reader = res.body.getReader()
        const { value, done } = await reader.read()
        reader.cancel().catch(() => {})
        if (done || !value) return
        const text = new TextDecoder().decode(value)
        const m = text.match(/\{[^}]*\}/)
        if (!m) return
        const { up, down } = JSON.parse(m[0])
        if (typeof up === 'number' && typeof down === 'number') {
          store.addTrafficSample(up, down)
        }
      } finally {
        clearTimeout(to)
      }
    } catch {
      // core unreachable — skip silently
    }
  }
  setTimeout(sampleTraffic, 30 * 1000)
  const trafficTimer = setInterval(sampleTraffic, TRAFFIC_INTERVAL_MS)
  trafficTimer.unref?.()

  return { tick, stop: () => { clearInterval(timer); clearInterval(trafficTimer) } }
}
