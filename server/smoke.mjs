// Smoke test: subscription parse -> rename -> config generation -> HTTP API.
// Run: node smoke.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openStore } from './lib/store.mjs'
import { parseNodes } from './lib/subscribe.mjs'
import { renameNodes } from './lib/rename.mjs'
import { buildConfig } from './lib/config.mjs'

const rootDir = mkdtempSync(path.join(tmpdir(), 'proxybox-smoke-'))
const dataDir = path.join(rootDir, 'data')
process.env.PROXYBOX_ROOT = rootDir
const store = openStore(dataDir)
console.log('store ok:', dataDir)

// ---- 1. share-link parsing ----
const links = [
  'ss://YWVzLTEyOC1nY206cGFzc3dvcmQxMjM=@hk-example.com:8388#香港-01',
  'vless://11111111-2222-4333-8444-555555555555@us-example.com:443?security=tls&sni=us-example.com&flow=xtls-rprx-vision#美国-洛杉矶-01',
  'trojan://trojanpass@jp-example.com:443?sni=jp-example.com#日本-东京-02',
  'vmess://eyJhZGQiOiJzZy1leGFtcGxlLmNvbSIsInBvcnQiOiI0NDMiLCJpZCI6IjExMTExMTExLTIyMjItNDMzMy04NDQ0LTU1NTU1NTU1NTU1NSIsImFpZCI6IjAiLCJuZXQiOiJ0Y3AiLCJ0eXBlIjoibm9uZSIsInRscyI6InRscyIsInBzIjoi5paw5Yqg5Z2hLTAxIn0=#新加坡-01',
  'hysteria2://hy2pass@de-example.com:8443?sni=de-example.com#德国-法兰克福-IEPL-01',
  'tuic://22222222-3333-4444-8555-666666666666:mypass@uk-example.com:443?sni=uk-example.com#英国-伦敦-01',
]
const parsed = parseNodes(links.join('\n'))
console.log(`parsed: ${parsed.nodes.length} nodes, format=${parsed.format}, skipped=${parsed.skipped.length}`)
for (const n of parsed.nodes) console.log('  -', n.type, '|', n.tag, '|', n.server, n.server_port)

// ---- 2. clash yaml parsing ----
const clashYaml = `proxies:
- name: "US-CA-IEPL-x2 洛杉矶 03"
  type: ss
  server: us2.example.com
  port: 8388
  cipher: aes-128-gcm
  password: "secret"
- name: "台湾 Hinet 01"
  type: vless
  server: tw.example.com
  port: 443
  uuid: 11111111-2222-4333-8444-555555555555
  tls: true
  sni: tw.example.com
- name: "未知协议"
  type: socks5
  server: x.example.com
  port: 1080
`;
const clash = parseNodes(clashYaml)
console.log(`clash: ${clash.nodes.length} nodes, skipped=${clash.skipped.length} (${clash.skipped.map((s) => s.type).join(',')})`)

// ---- 3. rename ----
const all = [...parsed.nodes, ...clash.nodes]
const r = renameNodes(all, {}, '测试订阅')
console.log('renamed preview:')
for (const p of r.preview) console.log(`  ${p.originalTag}  =>  ${p.newTag}  [${p.regionCode}]`)
console.log('groups:', r.groups.map((g) => `${g.name}(${g.nodeTags.length})`).join(', '))
console.log('excluded:', r.excluded.length, 'disabled:', r.disabled.length)

// ---- 4. persist + profile + user group ----
const saved = store.saveSubscription({ name: '测试订阅', url: '', content: links.join('\n'), format: 'share-link', renameOptions: {}, nodes: r.nodes })
store.kvSet(`subgroups.${saved.id}`, JSON.stringify(r.groups))
store.patchProfile({ routing: { fallback: 'proxy' }, dns: { split: true, mode: 'hijack' } })
store.replaceGroups([{ name: '手动精选', type: 'selector', allNodes: false, members: r.nodes.slice(0, 2).map((n) => n.tag) }])
console.log('profile region:', store.getProfile().region)

// ---- 5. config generation ----
const { config, stats } = buildConfig({
  profile: store.getProfile(),
  nodes: r.nodes,
  regionGroups: r.groups,
  userGroups: store.listGroups(),
  rulesetDir: path.join(dataDir, 'rulesets'),
  clashApi: { port: 9095, secret: 'smoke-secret' },
  cachePath: path.join(dataDir, 'cache.db'),
})
console.log('config stats:', JSON.stringify(stats))
console.log('outbounds:', config.outbounds.map((o) => `${o.type}:${o.tag}`).join(' | '))
console.log('route rules:')
for (const rule of config.route.rules) console.log('  -', JSON.stringify(rule))
console.log('rule_sets:', config.route.rule_set.map((s) => s.tag).join(','))
console.log('dns servers:', config.dns.servers.map((s) => `${s.tag}<-${s.detour}`).join(', '), '| final:', config.dns.final)
console.log('dns rules:', JSON.stringify(config.dns.rules))
console.log('final outbound:', config.route.final)
console.log('clash api:', config.experimental.clash_api.external_controller)

// ---- 6. HTTP API (same store via PROXYBOX_ROOT) ----
process.env.PROXYBOX_PORT = '18080'
await import('./index.mjs')
await new Promise((r2) => setTimeout(r2, 1200))
const base = 'http://127.0.0.1:18080'
const j = async (p, init) => (await fetch(base + p, init)).json()
console.log('auth status:', JSON.stringify(await j('/api/auth/status')))
console.log('setup:', JSON.stringify(await j('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test1234' }) })))
const loginRes = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test1234' }) })
const cookie = loginRes.headers.get('set-cookie')?.split(';')[0]
console.log('login ok:', loginRes.status === 200, 'cookie:', Boolean(cookie))
const authed = (p, init = {}) => j(p, { ...init, headers: { ...(init.headers || {}), Cookie: cookie } })
console.log('profile region:', (await authed('/api/openbox/profile')).profile.region)
console.log('subscriptions:', (await authed('/api/openbox/subscriptions')).subscriptions.length)
console.log('preview outbounds:', (await authed('/api/openbox/deploy/config/preview')).config.outbounds.length)
console.log('deploy state:', JSON.stringify((await authed('/api/openbox/deploy/state')).state.stage))
console.log('kernel version:', JSON.stringify(await authed('/api/openbox/service/kernel/version')))
console.log('penetration(private):', JSON.stringify(await authed('/api/openbox/penetration', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ target: '192.168.1.5' }) })))
store.close()
process.exit(0)
