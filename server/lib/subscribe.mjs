// Subscription fetching + parsing, implemented from scratch.
// Supported inputs:
//   - Clash YAML (proxies: list)
//   - Share links: ss://, vmess://, vless://, trojan://, hysteria2:// (hy2://), tuic://, wireguard://
//   - sing-box JSON ({ outbounds: [...] })
//   - Base64 blob containing any of the above
// Every parser normalizes to a sing-box outbound object with a `tag` (original name).
import { b64decode, isObj, lines, tryB64decode } from './util.mjs'

const SUPPORTED = new Set(['shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'wireguard'])

/** Fetch a subscription URL with a browser-ish UA and a timeout. */
export async function fetchSubscription(url, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'clash-verge/v2.0' },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

/** Guess the source format from raw text. */
export function detectFormat(text, url = '') {
  const t = String(text || '').trim()
  if (!t) return 'empty'
  if (t.startsWith('{')) return 'sing-box'
  if (/^proxies\s*:/m.test(t)) return 'clash'
  if (/^(ss|vmess|vless|trojan|hysteria2|hy2|tuic|wireguard):\/\//m.test(t)) return 'share-link'
  const decoded = tryB64decode(t.replace(/\s+/g, ''))
  if (decoded) {
    if (decoded.trim().startsWith('{')) return 'sing-box'
    if (/^proxies\s*:/m.test(decoded)) return 'clash'
    if (/(ss|vmess|vless|trojan|hysteria2|hy2|tuic|wireguard):\/\//.test(decoded)) return 'share-link'
  }
  if (/\.(ya?ml)$/i.test(url)) return 'clash'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Minimal YAML-subset parser: enough for machine-generated Clash subscriptions
// (top-level `proxies:` list of flat maps, one level of nesting allowed).
// ---------------------------------------------------------------------------
function parseClashProxies(text) {
  const result = []
  const all = String(text).split(/\r?\n/)
  let inProxies = false
  let baseIndent = -1
  let current = null
  let nestedKey = null
  let nestedIndent = -1

  const pushCurrent = () => {
    if (current && Object.keys(current).length) result.push(current)
    current = null
    nestedKey = null
  }

  for (const rawLine of all) {
    const line = rawLine.replace(/#.*$/, '')
    if (!line.trim()) continue
    const indent = line.match(/^ */)[0].length
    const trimmed = line.trim()

    if (!inProxies) {
      if (/^proxies\s*:\s*$/.test(trimmed)) {
        inProxies = true
      }
      continue
    }
    // A new top-level key ends the proxies section.
    if (baseIndent >= 0 && indent <= baseIndent && !trimmed.startsWith('-')) {
      if (/^[A-Za-z0-9_-]+\s*:/.test(trimmed)) break
    }

    if (trimmed.startsWith('- ')) {
      pushCurrent()
      baseIndent = indent
      current = {}
      const rest = trimmed.slice(2).trim()
      if (rest) {
        const m = rest.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
        if (m) current[m[1]] = unquote(m[2])
      }
      nestedKey = null
      continue
    }
    if (!current) continue
    const m = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const [, key, rawVal] = m
    if (rawVal === '' && indent > baseIndent) {
      // start of a nested map (e.g. ws-opts:)
      nestedKey = key
      nestedIndent = indent
      current[key] = {}
    } else if (nestedKey && indent > nestedIndent) {
      current[nestedKey][key] = unquote(rawVal)
    } else {
      nestedKey = null
      current[key] = unquote(rawVal)
    }
  }
  pushCurrent()
  return result
}

function unquote(s) {
  s = String(s ?? '').trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

function clashProxyToOutbound(p) {
  const type = String(p.type || '').toLowerCase()
  const tag = String(p.name || 'unnamed')
  const server = String(p.server || '')
  const port = Number(p.port || 0)
  if (!server || !port) return null
  const base = { tag, server, server_port: port }
  switch (type) {
    case 'ss':
    case 'shadowsocks':
      return { ...base, type: 'shadowsocks', method: p.cipher || 'aes-128-gcm', password: p.password || '' }
    case 'vmess':
      return {
        ...base, type: 'vmess', uuid: p.uuid || '', alter_id: Number(p.alterId || p['alter-id'] || 0),
        security: 'auto', tls: tlsFromClash(p),
      }
    case 'vless':
      return {
        ...base, type: 'vless', uuid: p.uuid || '', flow: p.flow || undefined,
        tls: tlsFromClash(p),
      }
    case 'trojan':
      return { ...base, type: 'trojan', password: p.password || '', tls: tlsFromClash(p, true) }
    case 'hysteria2':
    case 'hy2':
      return {
        ...base, type: 'hysteria2', password: p.password || p.auth || '',
        tls: { enabled: true, insecure: true, server_name: p.sni || p.servername || server },
      }
    case 'tuic':
      return {
        ...base, type: 'tuic', uuid: p.uuid || '', password: p.password || '',
        tls: { enabled: true, insecure: true, server_name: p.sni || server },
      }
    case 'wireguard': {
      const peers = [{ server, server_port: port, public_key: p['public-key'] || '', pre_shared_key: p['pre-shared-key'] || undefined }]
      return {
        ...base, type: 'wireguard', private_key: p['private-key'] || '',
        local_address: [p.ip || '172.16.0.2/32'], peers,
        mtu: 1408,
      }
    }
    default:
      return null
  }
}

function tlsFromClash(p, on = false) {
  const enabled = on || String(p.tls || '').toLowerCase() === 'true' || p.tls === true
  if (!enabled) return undefined
  return {
    enabled: true,
    insecure: String(p['skip-cert-verify'] || '').toLowerCase() === 'true' || p['skip-cert-verify'] === true,
    server_name: p.sni || p.servername || undefined,
  }
}

// ---------------------------------------------------------------------------
// Share-link parsers
// ---------------------------------------------------------------------------
function parseShareLink(line) {
  const m = line.match(/^([a-zA-Z0-9+]+):\/\/(.*)$/)
  if (!m) return null
  const scheme = m[1].toLowerCase()
  let rest = m[2]
  let name = ''
  const hashIdx = rest.indexOf('#')
  if (hashIdx >= 0) {
    name = decodeURIComponent(rest.slice(hashIdx + 1))
    rest = rest.slice(0, hashIdx)
  }
  try {
    switch (scheme) {
      case 'ss': return parseSs(rest, name)
      case 'vmess': return parseVmess(rest, name)
      case 'vless': return parseVlessLike('vless', rest, name)
      case 'trojan': return parseVlessLike('trojan', rest, name)
      case 'hysteria2':
      case 'hy2': return parseHysteria2(rest, name)
      case 'tuic': return parseTuic(rest, name)
      case 'wireguard': return parseWireguard(rest, name)
      default: return null
    }
  } catch {
    return null
  }
}

function splitUserHost(rest) {
  const at = rest.lastIndexOf('@')
  if (at < 0) throw new Error('bad link')
  return [rest.slice(0, at), rest.slice(at + 1)]
}

function parseHostPort(hostport) {
  const m = hostport.match(/^\[?([^\]]+)\]?:(\d+)(.*)$/)
  if (!m) throw new Error('bad host:port')
  return { host: m[1], port: Number(m[2]), query: m[3].startsWith('?') ? m[3].slice(1) : '' }
}

function parseSs(rest, name) {
  let [user, hostport] = splitUserHost(rest)
  // ss://BASE64(method:password)@host:port  or  ss://BASE64(method:password@host:port)
  if (!user.includes(':')) {
    const decoded = b64decode(user)
    if (decoded.includes('@')) {
      const at = decoded.lastIndexOf('@')
      const hp = parseHostPort(decoded.slice(at + 1))
      const [method, password] = decoded.slice(0, at).split(':')
      return { type: 'shadowsocks', tag: name || `${hp.host}:${hp.port}`, server: hp.host, server_port: hp.port, method, password }
    }
    const [method, password] = decoded.split(':')
    user = `${method}:${password}`
  }
  const [method, password] = user.split(':')
  const hp = parseHostPort(hostport)
  return { type: 'shadowsocks', tag: name || `${hp.host}:${hp.port}`, server: hp.host, server_port: hp.port, method: method || 'aes-128-gcm', password: password || '' }
}

function parseVmess(rest, name) {
  const j = JSON.parse(b64decode(rest))
  const port = Number(j.port || 0)
  if (!j.add || !port) throw new Error('bad vmess')
  const tlsOn = String(j.tls || '').toLowerCase() === 'tls'
  return {
    type: 'vmess', tag: name || j.ps || `${j.add}:${port}`,
    server: j.add, server_port: port, uuid: j.id || '', alter_id: Number(j.aid || 0),
    security: 'auto',
    tls: tlsOn ? { enabled: true, insecure: true, server_name: j.sni || j.host || undefined } : undefined,
  }
}

function parseVlessLike(kind, rest, name) {
  const [user, hostport] = splitUserHost(rest)
  const hp = parseHostPort(hostport)
  const q = new URLSearchParams(hp.query)
  const tlsOn = (q.get('security') || '').toLowerCase() === 'tls'
  const tag = name || `${hp.host}:${hp.port}`
  const tls = tlsOn ? { enabled: true, insecure: true, server_name: q.get('sni') || undefined } : undefined
  if (kind === 'vless') {
    return {
      type: 'vless', tag, server: hp.host, server_port: hp.port, uuid: decodeURIComponent(user),
      flow: q.get('flow') || undefined, tls,
    }
  }
  return { type: 'trojan', tag, server: hp.host, server_port: hp.port, password: decodeURIComponent(user), tls: tls || { enabled: true, insecure: true } }
}

function parseHysteria2(rest, name) {
  const [user, hostport] = splitUserHost(rest)
  const hp = parseHostPort(hostport)
  const q = new URLSearchParams(hp.query)
  return {
    type: 'hysteria2', tag: name || `${hp.host}:${hp.port}`,
    server: hp.host, server_port: hp.port, password: decodeURIComponent(user),
    tls: { enabled: true, insecure: true, server_name: q.get('sni') || hp.host },
  }
}

function parseTuic(rest, name) {
  const [user, hostport] = splitUserHost(rest)
  const [uuid, password] = decodeURIComponent(user).split(':')
  const hp = parseHostPort(hostport)
  const q = new URLSearchParams(hp.query)
  return {
    type: 'tuic', tag: name || `${hp.host}:${hp.port}`,
    server: hp.host, server_port: hp.port, uuid: uuid || '', password: password || '',
    tls: { enabled: true, insecure: true, server_name: q.get('sni') || hp.host },
  }
}

function parseWireguard(rest, name) {
  const [user, hostport] = splitUserHost(rest)
  const hp = parseHostPort(hostport)
  const q = new URLSearchParams(hp.query)
  const tag = name || `${hp.host}:${hp.port}`
  return {
    type: 'wireguard', tag, server: hp.host, server_port: hp.port,
    private_key: decodeURIComponent(user),
    local_address: (q.get('address') || '172.16.0.2/32').split(','),
    peers: [{
      server: hp.host, server_port: hp.port,
      public_key: q.get('publickey') || '',
      pre_shared_key: q.get('presharedkey') || undefined,
      allowed_ips: (q.get('allowedips') || '0.0.0.0/0').split(','),
    }],
    mtu: 1408,
  }
}

// ---------------------------------------------------------------------------
// Top-level entry
// ---------------------------------------------------------------------------
/**
 * Parse raw subscription text into normalized sing-box outbounds.
 * Returns { format, nodes, skipped } where skipped lists unsupported entries.
 */
export function parseNodes(text, url = '') {
  let format = detectFormat(text, url)
  let body = String(text || '')
  if (format === 'unknown') {
    const decoded = tryB64decode(body.replace(/\s+/g, ''))
    if (decoded) {
      body = decoded
      format = detectFormat(body, url)
    }
  } else if (!['clash', 'sing-box', 'share-link'].includes(format)) {
    const decoded = tryB64decode(body.replace(/\s+/g, ''))
    if (decoded && /(ss|vmess|vless|trojan|hysteria2|hy2|tuic|wireguard):\/\//.test(decoded)) {
      body = decoded
      format = 'share-link'
    } else if (decoded && decoded.trim().startsWith('{')) {
      body = decoded
      format = 'sing-box'
    } else if (decoded && /^proxies\s*:/m.test(decoded)) {
      body = decoded
      format = 'clash'
    }
  }

  const nodes = []
  const skipped = []

  if (format === 'clash') {
    for (const p of parseClashProxies(body)) {
      const ob = clashProxyToOutbound(p)
      if (ob && SUPPORTED.has(ob.type)) nodes.push(ob)
      else skipped.push({ name: String(p.name || '?'), type: String(p.type || '?') })
    }
  } else if (format === 'sing-box') {
    try {
      const j = JSON.parse(body)
      const list = Array.isArray(j) ? j : j.outbounds || []
      for (const o of list) {
        if (!isObj(o) || !o.tag) continue
        if (SUPPORTED.has(o.type)) nodes.push({ ...o })
        else if (!['direct', 'block', 'dns', 'selector', 'urltest'].includes(o.type)) {
          skipped.push({ name: String(o.tag), type: String(o.type) })
        }
      }
    } catch {
      format = 'unknown'
    }
  } else if (format === 'share-link') {
    for (const line of lines(body)) {
      const ob = parseShareLink(line)
      if (ob && SUPPORTED.has(ob.type)) nodes.push(ob)
      else skipped.push({ name: line.slice(0, 40), type: 'unknown' })
    }
  }

  return { format, nodes, skipped }
}

/**
 * Resolve a subscription source ({url, content}) into parsed nodes.
 * content wins when both are present.
 */
export async function resolveSubscription({ url, content }, timeoutMs) {
  let text = content
  if ((!text || !text.trim()) && url) {
    text = await fetchSubscription(url, timeoutMs)
  }
  if (!text || !text.trim()) throw new Error('empty subscription source')
  return parseNodes(text, url)
}
