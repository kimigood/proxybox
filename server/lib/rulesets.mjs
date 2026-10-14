// Rule-set (.srs) supply: the generated config references local
// <rulesetDir>/<tag>.srs files, so deploy must ensure they exist first.
// Sources: SagerNet/sing-geosite and SagerNet/sing-geoip (raw.githubusercontent).
import fs from 'node:fs'
import path from 'node:path'

const REPO_BY_PREFIX = [
  { prefix: 'geoip-', repo: 'SagerNet/sing-geoip' },
  { prefix: 'geosite-', repo: 'SagerNet/sing-geosite' },
]
const MIRRORS = ['', 'https://ghfast.top/', 'https://gh-proxy.com/']
const FETCH_TIMEOUT_MS = 15000
const MAX_BYTES = 16 * 1024 * 1024
// `!` is part of upstream naming (e.g. geosite-category-ai-!cn); it is safe
// in a filename and in sing-box rule_set tags.
const SAFE_TAG = /^[A-Za-z0-9._!-]+$/

export function isSafeTag(tag) {
  return typeof tag === 'string' && SAFE_TAG.test(tag) && !tag.includes('..')
}

function urlsFor(tag) {
  const hit = REPO_BY_PREFIX.find((e) => tag.startsWith(e.prefix))
  if (!hit) return []
  const p = `https://raw.githubusercontent.com/${hit.repo}/rule-set/${tag}.srs`
  return MIRRORS.map((m) => (m ? m + p : p))
}

async function fetchBuffer(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('file too large')
    if (buf.length < 16) throw new Error('file suspiciously small')
    return buf
  } finally {
    clearTimeout(t)
  }
}

/**
 * Ensure every tag in `tags` has a local .srs file. Only downloads missing
 * files; existing ones are left alone (explicit refresh via refreshRulesets).
 * Returns { ok, downloaded: [], failed: [] }.
 */
export async function ensureRulesets(rulesetDir, tags) {
  fs.mkdirSync(rulesetDir, { recursive: true })
  const downloaded = []
  const failed = []
  for (const tag of new Set(tags || [])) {
    if (!isSafeTag(tag)) {
      failed.push({ tag, error: 'bad tag' })
      continue
    }
    const dest = path.join(rulesetDir, `${tag}.srs`)
    if (fs.existsSync(dest)) continue
    let done = false
    let lastErr = ''
    for (const url of urlsFor(tag)) {
      try {
        const buf = await fetchBuffer(url)
        const tmp = `${dest}.tmp`
        fs.writeFileSync(tmp, buf)
        fs.renameSync(tmp, dest)
        downloaded.push(tag)
        done = true
        break
      } catch (e) {
        lastErr = String(e.message || e)
      }
    }
    if (!done) failed.push({ tag, error: lastErr })
  }
  return { ok: failed.length === 0, downloaded, failed }
}

/** Force re-download of the given tags (explicit user action / scheduled update). */
export async function refreshRulesets(rulesetDir, tags) {
  for (const tag of new Set(tags || [])) {
    if (!isSafeTag(tag)) continue
    fs.rmSync(path.join(rulesetDir, `${tag}.srs`), { force: true })
  }
  return ensureRulesets(rulesetDir, tags)
}

/** Collect every ruleset tag referenced by the current profile. */
export function profileRulesetTags(profile) {
  const r = profile.routing || {}
  const tags = new Set()
  for (const c of r.categories || []) if (c.ruleset) tags.add(c.ruleset)
  for (const t of r.directRulesets || []) tags.add(t)
  if (r.adBlock && r.adRuleset) tags.add(r.adRuleset)
  return [...tags].filter(isSafeTag)
}
