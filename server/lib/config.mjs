// sing-box config generator, implemented from scratch.
// Follows the documented decision chain:
//   private IPs -> direct | ads (optional) -> reject | category rule_sets -> target groups
//   | direct rule_sets -> direct | DNS hijack (optional) | final -> fallback
// DNS runs split channels: direct domains via direct DNS, proxied domains via
// proxy DNS (detoured through the proxy group), so DNS and connections agree.
import path from 'node:path'

const BUILTIN_OUTBOUND_TYPES = new Set(['direct', 'block', 'dns', 'selector', 'urltest'])

function srsTag(name) {
  return String(name).replace(/^geosite-/, 'geosite-').replace(/^geoip-/, 'geoip-')
}

/**
 * Normalize a user-supplied DNS address into sing-box >= 1.12 server object.
 * Accepts: '223.5.5.5', 'tcp://1.1.1.1', 'tls://8.8.8.8', 'https://1.1.1.1/dns-query'.
 */
export function parseDnsAddress(addr, detour) {
  const s = String(addr || '').trim()
  const withDetour = (o) => (detour ? { ...o, detour } : o)
  let m = s.match(/^https:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/)
  if (m) {
    return withDetour({
      type: 'https', server: m[1], server_port: Number(m[2] || 443),
      path: m[3] || '/dns-query',
    })
  }
  m = s.match(/^(tls|tcp|udp):\/\/([^/:]+)(?::(\d+))?$/)
  if (m) {
    return withDetour({ type: m[1], server: m[2], server_port: Number(m[3] || 53) })
  }
  return withDetour({ type: 'udp', server: s })
}

/**
 * Build a complete sing-box config object.
 * @param opts { profile, nodes (renamed outbounds), regionGroups ([{name, nodeTags}]),
 *               userGroups, rulesetDir (absolute), clashApi: {port, secret}, cachePath }
 */
export function buildConfig(opts) {
  const { profile, nodes = [], regionGroups = [], userGroups = [], rulesetDir, clashApi, cachePath } = opts
  const routing = profile.routing || {}
  const dnsCfg = profile.dns || {}
  const proxyTag = routing.proxyTag || 'proxy'
  const fallback = routing.fallback || 'proxy'
  const ipv6 = profile.ipv6 !== false

  // ---- outbounds ----
  const outbounds = [
    { type: 'direct', tag: 'direct' },
    { type: 'block', tag: 'block' },
  ]
  const nodeTags = []
  for (const n of nodes) {
    if (!n || !n.tag || BUILTIN_OUTBOUND_TYPES.has(n.type)) continue
    const { originalTag, regionCode, subscription, subscriptionId, ...ob } = n
    outbounds.push({ ...ob, tag: n.tag })
    nodeTags.push(n.tag)
  }

  // Auto region groups from the rename engine.
  const regionGroupTags = []
  for (const g of regionGroups) {
    const tags = (g.nodeTags || []).filter((t) => nodeTags.includes(t))
    if (!tags.length) continue
    outbounds.push({
      type: 'urltest', tag: g.name, outbounds: tags,
      url: 'https://www.gstatic.com/generate_204', interval: '10m', tolerance: 150,
    })
    regionGroupTags.push(g.name)
  }

  // User groups (selector/urltest). allNodes members resolve to every node tag.
  const userGroupTags = []
  const droppedGroups = []
  for (const g of userGroups) {
    const members = g.allNodes ? [...nodeTags] : (g.members || []).filter((t) => nodeTags.includes(t))
    if (!members.length) {
      droppedGroups.push({ name: g.name, reason: 'no valid members' })
      continue
    }
    const ob = { type: g.type === 'urltest' ? 'urltest' : 'selector', tag: g.name, outbounds: members }
    if (g.type === 'urltest') {
      ob.url = 'https://www.gstatic.com/generate_204'
      ob.interval = g.interval || '10m'
      ob.tolerance = g.tolerance ?? 150
    }
    outbounds.push(ob)
    userGroupTags.push(g.name)
  }

  // Top-level proxy selector: every group + direct.
  const proxyMembers = [...regionGroupTags, ...userGroupTags]
  outbounds.push({ type: 'selector', tag: proxyTag, outbounds: [...proxyMembers, 'direct'] })

  const validTargets = new Set(['direct', 'block', proxyTag, ...regionGroupTags, ...userGroupTags])
  const resolveTarget = (t) => (validTargets.has(t) ? t : fallback === 'direct' ? 'direct' : proxyTag)

  // ---- rule_sets (all local .srs) ----
  const rulesetNames = new Set()
  for (const c of routing.categories || []) rulesetNames.add(c.ruleset)
  for (const r of routing.directRulesets || []) rulesetNames.add(r)
  if (routing.adBlock && routing.adRuleset) rulesetNames.add(routing.adRuleset)
  const ruleSet = [...rulesetNames]
    .filter((n) => /^[A-Za-z0-9._-]+$/.test(n))
    .map((n) => ({
      tag: srsTag(n),
      type: 'local',
      format: 'binary',
      path: path.join(rulesetDir, `${n}.srs`),
    }))

  // ---- route rules ----
  // In dnsmasq mode the dns-in hijack MUST come before sniff: the sniff
  // action stalls UDP packets arriving on a direct inbound (verified by
  // runtime test), while tun-captured packets are unaffected.
  const rules = []
  if (dnsCfg.mode === 'dnsmasq') {
    rules.push({ inbound: ['dns-in'], action: 'hijack-dns' })
  }
  // sniff first (1.13 moved sniff/sniff_override_destination off inbounds
  // into the `sniff` route action), so domain rules below see hostnames.
  rules.push({ action: 'sniff' })
  rules.push({ ip_is_private: true, outbound: 'direct' })
  if (routing.adBlock && routing.adRuleset) {
    rules.push({ rule_set: srsTag(routing.adRuleset), action: 'reject' })
  }
  for (const c of routing.categories || []) {
    if (!c.ruleset) continue
    rules.push({ rule_set: srsTag(c.ruleset), outbound: resolveTarget(c.target) })
  }
  for (const r of routing.directRulesets || []) {
    rules.push({ rule_set: srsTag(r), outbound: 'direct' })
  }
  // DNS interception.
  //  - hijack mode (tun): protocol-based; the sniff action above lets
  //    `protocol: dns` match port-53 traffic captured by the tun device.
  //  - dnsmasq mode: inbound-scoped rule placed BEFORE sniff (see above).
  if (dnsCfg.mode === 'hijack') {
    rules.push({ protocol: 'dns', action: 'hijack-dns' })
  }

  const finalOutbound = fallback === 'direct' ? 'direct' : proxyTag

  // ---- dns ----
  const proxyCategorySets = (routing.categories || [])
    .filter((c) => resolveTarget(c.target) !== 'direct')
    .map((c) => srsTag(c.ruleset))
  const directCategorySets = [
    ...(routing.directRulesets || []).map(srsTag),
    ...(routing.categories || []).filter((c) => resolveTarget(c.target) === 'direct').map((c) => srsTag(c.ruleset)),
  ]
  const dnsServers = [
    { tag: 'dns-direct', ...parseDnsAddress(dnsCfg.direct || '223.5.5.5') },
    { tag: 'dns-proxy', ...parseDnsAddress(dnsCfg.proxy || 'https://1.1.1.1/dns-query', proxyTag) },
  ]
  const dnsRules = []
  if (dnsCfg.split !== false) {
    if (proxyCategorySets.length) dnsRules.push({ rule_set: proxyCategorySets, server: 'dns-proxy' })
    if (directCategorySets.length) dnsRules.push({ rule_set: directCategorySets, server: 'dns-direct' })
  }
  const dnsFinal = dnsCfg.split === false ? 'dns-direct' : finalOutbound === 'direct' ? 'dns-direct' : 'dns-proxy'
  const dns = {
    servers: dnsServers,
    rules: dnsRules,
    final: dnsFinal,
    independent_cache: true,
  }
  if (!ipv6) dns.strategy = 'prefer_ipv4'

  // ---- inbounds ----
  const inbounds = [
    {
      type: 'tun',
      tag: 'tun-in',
      interface_name: 'proxybox-tun',
      mtu: 9000,
      address: ipv6 ? ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'] : ['172.19.0.1/30'],
      auto_route: true,
      strict_route: true,
      endpoint_independent_nat: true,
      stack: 'system',
    },
  ]
  if (dnsCfg.mode === 'dnsmasq') {
    inbounds.push({ type: 'direct', tag: 'dns-in', listen: '127.0.0.1', listen_port: 7853 })
  }

  const config = {
    log: { level: 'info', timestamp: true },
    dns,
    inbounds,
    outbounds,
    route: {
      rules,
      rule_set: ruleSet,
      final: finalOutbound,
      auto_detect_interface: true,
      default_domain_resolver: { server: 'dns-direct' },
    },
    experimental: {
      clash_api: {
        external_controller: `127.0.0.1:${clashApi?.port || 9095}`,
        external_ui: '',
        secret: clashApi?.secret || '',
      },
      cache_file: { enabled: true, path: cachePath || 'data/cache.db' },
    },
  }
  return { config, droppedGroups, stats: { nodes: nodeTags.length, regionGroups: regionGroupTags.length, userGroups: userGroupTags.length } }
}
