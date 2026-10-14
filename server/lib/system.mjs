// OS integration for OpenWrt targets (all best-effort, root required):
//  - dnsmasq takeover: point dnsmasq upstream at sing-box's dns-in (127.0.0.1:7853)
//  - nftables: block IPv6 forwarding when the profile disables IPv6 (leak guard)
// State is tracked in the kv store so apply/remove are idempotent.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function sh(cmd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 15000 })
    return { ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') }
  } catch (e) {
    return { ok: false, stdout: String(e.stdout || ''), stderr: String(e.stderr || e.message || '') }
  }
}

const DNSMASQ_UCI = ['dhcp', '@dnsmasq[0]']
const OUR_SERVER = '127.0.0.1#7853'

async function uciGetServerList() {
  const r = await sh('uci', ['get', `${DNSMASQ_UCI[0]}.${DNSMASQ_UCI[1]}.server`])
  if (!r.ok) return []
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

/** Apply or remove dnsmasq upstream takeover according to profile.dns.mode. */
export async function applyDnsTakeover(store, profile) {
  const mode = profile.dns?.mode || 'hijack'
  const applied = store.kvGet('dns.takeover') // 'dnsmasq' | null

  if (mode !== 'dnsmasq') {
    if (applied === 'dnsmasq') await removeDnsTakeover(store)
    return { ok: true, mode: 'none' }
  }
  if (applied === 'dnsmasq') return { ok: true, mode: 'already' }

  // Backup current upstream list, then point dnsmasq at sing-box.
  const current = await uciGetServerList()
  store.kvSet('dnsmasq.backup', JSON.stringify({ servers: current }))
  await sh('uci', ['set', `${DNSMASQ_UCI[0]}.${DNSMASQ_UCI[1]}.noresolv=1`])
  await sh('uci', ['del_list', `${DNSMASQ_UCI[0]}.${DNSMASQ_UCI[1]}.server=${OUR_SERVER}`])
  await sh('uci', ['add_list', `${DNSMASQ_UCI[0]}.${DNSMASQ_UCI[1]}.server=${OUR_SERVER}`])
  await sh('uci', ['commit', 'dhcp'])
  const restarted = await sh('/etc/init.d/dnsmasq', ['restart'])
  if (!restaredOk(restarted)) return { ok: false, error: 'dnsmasq restart failed' }
  store.kvSet('dns.takeover', 'dnsmasq')
  return { ok: true, mode: 'dnsmasq' }
}

function restaredOk(r) {
  return r.ok
}

export async function removeDnsTakeover(store) {
  const backup = store.kvGetJson('dnsmasq.backup', { servers: [] })
  await sh('uci', ['del_list', `${DNSMASQ_UCI[0]}.${DNSMASQ_UCI[1]}.server=${OUR_SERVER}`])
  for (const s of backup.servers || []) {
    await sh('uci', ['add_list', `${DNSMASQ_UCI[0]}.${DNSMASQ_UCI[1]}.server=${s}`])
  }
  await sh('uci', ['set', `${DNSMASQ_UCI[0]}.${DNSMASQ_UCI[1]}.noresolv=0`])
  await sh('uci', ['commit', 'dhcp'])
  await sh('/etc/init.d/dnsmasq', ['restart'])
  store.kvSet('dns.takeover', '')
  return { ok: true }
}

const NFT_TABLE = 'proxybox'

/** IPv6 leak guard: drop forwarded IPv6 when the profile disables IPv6. */
export async function applyFirewall(store, profile) {
  const wantBlock = profile.ipv6 === false
  const applied = store.kvGet('fw.v6block') === '1'

  const nft = await sh('nft', ['--version'])
  if (!nft.ok) return { ok: true, skipped: 'nft not available' }

  if (wantBlock && !applied) {
    await sh('nft', ['add', 'table', 'inet', NFT_TABLE])
    await sh('nft', ['add', 'chain', 'inet', NFT_TABLE, 'v6block', '{', 'type', 'filter', 'hook', 'forward', 'priority', '0', ';', '}'])
    await sh('nft', ['add', 'rule', 'inet', NFT_TABLE, 'v6block', 'ip6', 'daddr', '!=', 'fe80::/10', 'drop'])
    store.kvSet('fw.v6block', '1')
    return { ok: true, v6block: true }
  }
  if (!wantBlock && applied) {
    await sh('nft', ['delete', 'table', 'inet', NFT_TABLE])
    store.kvSet('fw.v6block', '')
    return { ok: true, v6block: false }
  }
  return { ok: true, v6block: applied }
}

export async function flushFirewall(store) {
  await sh('nft', ['delete', 'table', 'inet', NFT_TABLE]).catch(() => {})
  store.kvSet('fw.v6block', '')
  return { ok: true }
}
