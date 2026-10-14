// Small shared helpers. No external dependencies.
import { randomBytes } from 'node:crypto'

/** URL-safe random id, e.g. for subscriptions and groups. */
export function newId(prefix = 'id') {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

/** Decode base64 that may be standard or URL-safe and missing padding. */
export function b64decode(s) {
  let t = String(s || '').trim().replace(/-/g, '+').replace(/_/g, '/')
  const pad = t.length % 4
  if (pad) t += '='.repeat(4 - pad)
  return Buffer.from(t, 'base64').toString('utf8')
}

/** Try to base64-decode; return null when it is not decodable text. */
export function tryB64decode(s) {
  try {
    const out = b64decode(s)
    if (!out || /[\u0000-\u0008\u000e-\u001f]/.test(out)) return null
    return out
  } catch {
    return null
  }
}

/** Plain-object check. */
export function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Deep-merge `patch` onto `base` (objects merge, arrays/scalars replace).
 * Used for profile PATCH semantics: omitted fields keep their stored value.
 */
export function deepMerge(base, patch) {
  if (!isObj(patch)) return patch === undefined ? base : patch
  const out = isObj(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v
  }
  return out
}

/** Clamp a number into [min, max]. */
export function clamp(n, min, max) {
  const x = Number(n)
  if (!Number.isFinite(x)) return min
  return Math.min(max, Math.max(min, x))
}

/** Split text into non-empty trimmed lines. */
export function lines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

/** Sleep helper for polling loops. */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
