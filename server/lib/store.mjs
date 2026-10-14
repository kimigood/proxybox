// SQLite persistence (node:sqlite, built into Node 22+).
// Tables:
//   kv            generic key/value (profile JSON, auth hash, deploy state, ...)
//   subscriptions subscription sources + last parsed nodes
//   user_groups   user-defined policy groups (select/urltest)
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { deepMerge, isObj, newId } from './util.mjs'

export const DEFAULT_PROFILE = {
  region: 'CN',
  ipv6: true,
  tun: { autoRedirect: true },
  dns: {
    split: true,
    mode: 'hijack', // 'hijack' | 'dnsmasq' | 'off'
    direct: '223.5.5.5',
    proxy: 'https://1.1.1.1/dns-query',
  },
  routing: {
    proxyTag: 'proxy',
    categories: [],
    directRulesets: ['geosite-cn', 'geoip-cn'],
    adBlock: false,
    adRuleset: 'geosite-category-ads-all',
    fallback: 'proxy',
  },
  rulesetDir: 'data/rulesets',
}

/** Per-region recommended defaults (first-run wizard). */
export function regionDefaults(region) {
  const r = String(region || 'CN').toUpperCase()
  if (r === 'CN') {
    return {
      region: 'CN',
      dns: { split: true, mode: 'hijack', direct: '223.5.5.5', proxy: 'https://1.1.1.1/dns-query' },
      routing: {
        proxyTag: 'proxy',
        categories: [],
        directRulesets: ['geosite-cn', 'geoip-cn'],
        adBlock: false,
        adRuleset: 'geosite-category-ads-all',
        fallback: 'proxy',
      },
    }
  }
  return {
    region: r,
    dns: { split: false, mode: 'hijack', direct: '1.1.1.1', proxy: 'https://1.1.1.1/dns-query' },
    routing: {
      proxyTag: 'proxy',
      categories: [],
      directRulesets: [],
      adBlock: false,
      adRuleset: 'geosite-category-ads-all',
      fallback: 'direct',
    },
  }
}

const DEFAULT_DEPLOY_STATE = { stage: 'idle', message: '', at: 0, badTags: [] }

export function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(path.join(dataDir, 'proxybox.db'))
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT, content TEXT,
      format TEXT, rename_options TEXT, nodes TEXT,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS user_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      all_nodes INTEGER NOT NULL DEFAULT 0, members TEXT,
      interval TEXT, tolerance REAL
    );
    CREATE TABLE IF NOT EXISTS traffic_daily (
      day TEXT PRIMARY KEY, up INTEGER NOT NULL DEFAULT 0,
      down INTEGER NOT NULL DEFAULT 0, conns INTEGER NOT NULL DEFAULT 0
    );
  `)

  const kvGet = (key) => {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
    return row ? row.value : null
  }
  const kvSet = (key, value) => {
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }
  const kvGetJson = (key, fallback) => {
    const raw = kvGet(key)
    if (!raw) return fallback
    try {
      return JSON.parse(raw)
    } catch {
      return fallback
    }
  }

  // ---- profile ----
  function getProfile() {
    const saved = kvGetJson('profile', null)
    return deepMerge(structuredClone(DEFAULT_PROFILE), saved || {})
  }
  function patchProfile(patch) {
    if (!isObj(patch)) throw new Error('patch must be an object')
    const merged = deepMerge(getProfile(), patch)
    kvSet('profile', JSON.stringify(merged))
    return merged
  }

  // ---- subscriptions ----
  const rowToSub = (r) => ({
    id: r.id,
    name: r.name,
    url: r.url || '',
    content: r.content || '',
    format: r.format || '',
    nodeCount: JSON.parse(r.nodes || '[]').length,
    renameOptions: JSON.parse(r.rename_options || '{}'),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })

  function listSubscriptions() {
    return db.prepare('SELECT * FROM subscriptions ORDER BY created_at').all().map(rowToSub)
  }
  function getSubscription(id) {
    const r = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id)
    return r ? rowToSub(r) : null
  }
  function getSubscriptionNodes(id) {
    const r = db.prepare('SELECT nodes FROM subscriptions WHERE id = ?').get(id)
    return r ? JSON.parse(r.nodes || '[]') : []
  }
  function saveSubscription({ id, name, url, content, format, renameOptions, nodes }) {
    const now = Date.now()
    const sid = id || newId('sub')
    const existing = db.prepare('SELECT created_at FROM subscriptions WHERE id = ?').get(sid)
    db.prepare(
      `INSERT INTO subscriptions (id, name, url, content, format, rename_options, nodes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=excluded.url, content=excluded.content,
         format=excluded.format, rename_options=excluded.rename_options, nodes=excluded.nodes,
         updated_at=excluded.updated_at`,
    ).run(
      sid, name, url || '', content || '', format || '',
      JSON.stringify(renameOptions || {}), JSON.stringify(nodes || []),
      existing ? existing.created_at : now, now,
    )
    return getSubscription(sid)
  }
  function deleteSubscription(id) {
    db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id)
  }
  function allNodes() {
    const out = []
    for (const s of db.prepare('SELECT id, name, nodes FROM subscriptions').all()) {
      for (const n of JSON.parse(s.nodes || '[]')) out.push({ ...n, subscription: s.name, subscriptionId: s.id })
    }
    return out
  }

  // ---- user groups ----
  function listGroups() {
    return db.prepare('SELECT * FROM user_groups ORDER BY name').all().map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      allNodes: Boolean(r.all_nodes),
      members: JSON.parse(r.members || '[]'),
      interval: r.interval || undefined,
      tolerance: r.tolerance ?? undefined,
    }))
  }
  function replaceGroups(groups) {
    const seen = new Set()
    const clean = []
    for (const g of groups || []) {
      const name = String(g.name || '').trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      clean.push({
        id: g.id || newId('grp'),
        name,
        type: g.type === 'urltest' ? 'urltest' : 'selector',
        allNodes: Boolean(g.allNodes),
        members: Array.isArray(g.members) ? g.members.map(String) : [],
        interval: g.interval,
        tolerance: g.tolerance,
      })
    }
    db.exec('DELETE FROM user_groups')
    const ins = db.prepare(
      'INSERT INTO user_groups (id, name, type, all_nodes, members, interval, tolerance) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    for (const g of clean) ins.run(g.id, g.name, g.type, g.allNodes ? 1 : 0, JSON.stringify(g.members), g.interval || null, g.tolerance ?? null)
    return clean
  }

  // ---- deploy state ----
  function getDeployState() {
    return { ...DEFAULT_DEPLOY_STATE, ...kvGetJson('deploy.state', {}) }
  }
  function setDeployState(patch) {
    const s = { ...getDeployState(), ...patch, at: Date.now() }
    kvSet('deploy.state', JSON.stringify(s))
    return s
  }

  // ---- traffic sampling (daily up/down bytes + connection count) ----
  // The clash API reports cumulative counters; we store per-sample deltas.
  function addTrafficSample(upTotal, downTotal) {
    const last = kvGetJson('traffic.last', null)
    const now = new Date()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    if (last && typeof last.up === 'number' && typeof last.down === 'number') {
      const dup = Math.max(0, upTotal - last.up)
      const ddown = Math.max(0, downTotal - last.down)
      if (dup > 0 || ddown > 0) {
        db.prepare(
          `INSERT INTO traffic_daily (day, up, down, conns) VALUES (?, ?, ?, 1)
           ON CONFLICT(day) DO UPDATE SET up = up + excluded.up, down = down + excluded.down, conns = conns + 1`,
        ).run(day, dup, ddown)
      }
    } else {
      // First sample ever (or counters reset): ensure today's row exists.
      db.prepare('INSERT INTO traffic_daily (day, up, down, conns) VALUES (?, 0, 0, 0) ON CONFLICT(day) DO NOTHING').run(day)
    }
    kvSet('traffic.last', JSON.stringify({ up: upTotal, down: downTotal, at: Date.now() }))
  }
  function getTrafficMonth(month) {
    // month: 'YYYY-MM'
    const rows = db.prepare(
      "SELECT day, up, down, conns FROM traffic_daily WHERE day LIKE ? ORDER BY day",
    ).all(`${month}-%`)
    const days = rows.map((r) => ({ day: r.day, up: r.up, down: r.down, conns: r.conns }))
    const totalUp = days.reduce((a, d) => a + d.up, 0)
    const totalDown = days.reduce((a, d) => a + d.down, 0)
    const totalConns = days.reduce((a, d) => a + d.conns, 0)
    const avgPerDay = days.length ? Math.round((totalUp + totalDown) / days.length) : 0
    return { month, days, totalUp, totalDown, totalConns, avgPerDay }
  }

  return {
    db,
    kvGet, kvSet, kvGetJson,
    getProfile, patchProfile, regionDefaults,
    listSubscriptions, getSubscription, getSubscriptionNodes, saveSubscription, deleteSubscription, allNodes,
    listGroups, replaceGroups,
    getDeployState, setDeployState,
    addTrafficSample, getTrafficMonth,
    close() { db.close() },
  }
}
