// Node rename engine, implemented from scratch.
// Pipeline per subscription:
//   1. drop `disabled` original names; drop names hitting `excludeKeywords`
//   2. apply `overrides` (manual rename, excluded from sequencing)
//   3. region detection via regionDict keywords (case-insensitive substring)
//   4. feature extraction via featureKeywords (matched keyword, uppercased, in order)
//   5. name = template with {region} {features} {seq} {original}
//   6. auto region groups for the policy UI
// Only the panel frontend (MIT, zashboard-derived) is reused; this engine is original code.

const DEFAULT_REGION_DICT = [
  { code: 'CN', name: '中国', keywords: ['中国', 'china', 'cn-', '-cn', 'cn_', 'chin'] },
  { code: 'HK', name: '香港', keywords: ['香港', 'hongkong', 'hong kong', 'hk-', '-hk', 'hk_', 'hong-kong'] },
  { code: 'TW', name: '台湾', keywords: ['台湾', 'taiwan', 'tw-', '-tw', 'tw_'] },
  { code: 'JP', name: '日本', keywords: ['日本', 'japan', 'jp-', '-jp', 'jp_', 'tokyo', '东京', 'osaka', '大阪'] },
  { code: 'SG', name: '新加坡', keywords: ['新加坡', 'singapore', 'sg-', '-sg', 'sg_', '狮城', 'sgp'] },
  { code: 'KR', name: '韩国', keywords: ['韩国', 'korea', 'kr-', '-kr', 'kr_', 'seoul', '首尔'] },
  { code: 'US', name: '美国', keywords: ['美国', 'united states', 'usa', 'us-', '-us', 'us_', '洛杉矶', 'los angeles', 'california', '加州', '旧金山', 'san francisco', '纽约', 'new york', 'seattle', '西雅图', 'dallas', '达拉斯', 'chicago', '芝加哥', 'silicon', 'oregon', '俄勒冈', 'phoenix', '凤凰城'] },
  { code: 'CA', name: '加拿大', keywords: ['加拿大', 'canada', 'ca-', '-ca', 'ca_', 'toronto', '多伦多', 'vancouver', '温哥华'] },
  { code: 'UK', name: '英国', keywords: ['英国', 'united kingdom', 'uk-', '-uk', 'uk_', 'london', '伦敦'] },
  { code: 'DE', name: '德国', keywords: ['德国', 'germany', 'de-', '-de', 'de_', 'frankfurt', '法兰克福'] },
  { code: 'FR', name: '法国', keywords: ['法国', 'france', 'fr-', '-fr', 'fr_', 'paris', '巴黎'] },
  { code: 'NL', name: '荷兰', keywords: ['荷兰', 'netherlands', 'nl-', '-nl', 'nl_', 'amsterdam', '阿姆斯特丹'] },
  { code: 'AU', name: '澳大利亚', keywords: ['澳大利亚', 'australia', 'au-', '-au', 'au_', 'sydney', '悉尼'] },
  { code: 'MO', name: '澳门', keywords: ['澳门', 'macao', 'macau', 'mo-'] },
  { code: 'MY', name: '马来西亚', keywords: ['马来西亚', 'malaysia', 'my-'] },
  { code: 'TH', name: '泰国', keywords: ['泰国', 'thailand', 'th-', 'bangkok', '曼谷'] },
  { code: 'VN', name: '越南', keywords: ['越南', 'vietnam', 'vn-'] },
  { code: 'PH', name: '菲律宾', keywords: ['菲律宾', 'philippines', 'ph-'] },
  { code: 'ID', name: '印度尼西亚', keywords: ['印度尼西亚', '印尼', 'indonesia', 'id-', 'jakarta', '雅加达'] },
  { code: 'IN', name: '印度', keywords: ['印度', 'india', 'in-', 'mumbai', '孟买'] },
  { code: 'AE', name: '阿联酋', keywords: ['阿联酋', '迪拜', 'dubai', 'uae', 'ae-'] },
  { code: 'TR', name: '土耳其', keywords: ['土耳其', 'turkey', 'tr-', 'istanbul', '伊斯坦布尔'] },
  { code: 'RU', name: '俄罗斯', keywords: ['俄罗斯', 'russia', 'ru-', 'moscow', '莫斯科'] },
]

const DEFAULT_FEATURE_KEYWORDS = [
  'IEPL', 'IPLC', '专线', 'BGP', 'CN2', 'GIA', '游戏', '流媒体', '家宽', '住宅', '原生',
]

export function defaultRenameOptions() {
  return {
    regionDict: DEFAULT_REGION_DICT,
    featureKeywords: DEFAULT_FEATURE_KEYWORDS,
    excludeKeywords: ['公告', '官网', '剩余流量', '到期时间', '套餐'],
    overrides: {},
    disabled: [],
    usePrefix: false,
    template: '{region}-{features}-{seq}',
    unknownLabel: '其他',
    seqPad: 2,
  }
}

function matchRegion(name, regionDict) {
  const lower = name.toLowerCase()
  for (const entry of regionDict || []) {
    for (const kw of entry.keywords || []) {
      if (kw && lower.includes(String(kw).toLowerCase())) {
        return { code: entry.code, name: entry.name }
      }
    }
  }
  return null
}

function matchFeatures(name, featureKeywords) {
  const lower = name.toLowerCase()
  const out = []
  for (const kw of featureKeywords || []) {
    const k = String(kw)
    if (k && lower.includes(k.toLowerCase()) && !out.includes(k.toUpperCase())) {
      out.push(k.toUpperCase())
    }
  }
  return out
}

function applyTemplate(template, { region, features, seq, original }) {
  let t = template || '{region}-{features}-{seq}'
  const featStr = features.join('-')
  t = t.replace('{region}', region).replace('{features}', featStr).replace('{seq}', seq).replace('{original}', original)
  // clean up dangling separators when features are empty: "美国--01" -> "美国-01"
  t = t.replace(/--+/g, '-').replace(/^-|-$/g, '')
  return t
}

/**
 * Rename a list of parsed nodes.
 * @param nodes sing-box outbounds with original `tag`
 * @param options rename options (partial; defaults filled in)
 * @param subName subscription name (used as prefix when usePrefix is on)
 * @returns { nodes, preview, groups, skipped }
 */
export function renameNodes(nodes, options = {}, subName = '') {
  const opts = { ...defaultRenameOptions(), ...(options || {}) }
  // Back-compat: old two-level featureDict -> flat keyword list.
  if (opts.featureDict && !options.featureKeywords) {
    opts.featureKeywords = opts.featureDict.flatMap((e) => e.keywords || [])
  }
  const disabledSet = new Set(opts.disabled || [])
  const excludeRes = (opts.excludeKeywords || []).map((k) => String(k).toLowerCase())

  const renamed = []
  const preview = []
  const excluded = []
  const skippedDisabled = []
  const seqCounters = new Map()

  for (const node of nodes || []) {
    const original = String(node.tag || 'unnamed')

    if (disabledSet.has(original)) {
      skippedDisabled.push({ name: original })
      continue
    }
    if (excludeRes.some((k) => k && original.toLowerCase().includes(k))) {
      excluded.push({ name: original })
      continue
    }

    let newTag
    let regionCode
    if (opts.overrides && opts.overrides[original]) {
      newTag = String(opts.overrides[original])
    } else {
      const region = matchRegion(original, opts.regionDict)
      const regionName = region ? region.name : opts.unknownLabel || '其他'
      regionCode = region ? region.code : ''
      const features = matchFeatures(original, opts.featureKeywords)
      const key = `${regionName}|${features.join(',')}`
      const seq = (seqCounters.get(key) || 0) + 1
      seqCounters.set(key, seq)
      const seqStr = String(seq).padStart(opts.seqPad || 2, '0')
      newTag = applyTemplate(opts.template, { region: regionName, features, seq: seqStr, original })
    }

    if (opts.usePrefix && subName) newTag = `${subName} | ${newTag}`
    preview.push({ originalTag: original, newTag, regionCode })
    renamed.push({ ...node, tag: newTag, originalTag: original, regionCode })
  }

  // Auto region groups (selector per region, in first-seen order).
  const groupMap = new Map()
  for (const n of renamed) {
    const gname = n.regionCode
      ? (opts.regionDict.find((e) => e.code === n.regionCode)?.name || opts.unknownLabel)
      : opts.unknownLabel || '其他'
    if (!groupMap.has(gname)) groupMap.set(gname, [])
    groupMap.get(gname).push(n.tag)
  }
  const groups = [...groupMap.entries()].map(([name, nodeTags]) => ({ name, type: 'selector', nodeTags }))

  return { nodes: renamed, preview, groups, excluded, disabled: skippedDisabled }
}
