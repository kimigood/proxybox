// Service orchestration: config deploy pipeline, init.d control,
// conflict detection, kernel version, emergency rollback.
// All functions degrade gracefully when not running on OpenWrt
// (they return structured results instead of throwing).
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildConfig } from './config.mjs'
import { ensureRulesets, profileRulesetTags } from './rulesets.mjs'
import { applyDnsTakeover, applyFirewall, flushFirewall, removeDnsTakeover } from './system.mjs'
import { sleep } from './util.mjs'

const execFileAsync = promisify(execFile)

export function resolvePaths(rootDir) {
  const root = path.resolve(rootDir)
  return {
    root,
    bin: path.join(root, 'bin', 'sing-box'),
    etcDir: path.join(root, 'etc'),
    configPath: path.join(root, 'etc', 'config.json'),
    dataDir: path.join(root, 'data'),
    rulesetDir: path.join(root, 'data', 'rulesets'),
    cachePath: path.join(root, 'data', 'cache.db'),
    initCore: '/etc/init.d/proxybox-core',
    initPanel: '/etc/init.d/proxybox-panel',
  }
}

async function run(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 30000, ...opts })
    return { ok: true, code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') }
  } catch (e) {
    return { ok: false, code: e.code ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || e.message || '') }
  }
}

/** Validate a config file with `sing-box check`. */
export async function checkConfig(singboxBin, configPath) {
  if (!fs.existsSync(singboxBin)) {
    return { ok: false, stderr: `sing-box binary not found: ${singboxBin}` }
  }
  const r = await run(singboxBin, ['check', '-c', configPath])
  return { ok: r.ok, stderr: r.stderr || r.stdout }
}

/** Ask the kernel for its version string. */
export async function kernelVersion(singboxBin) {
  if (!fs.existsSync(singboxBin)) return { ok: false, version: '', raw: 'sing-box binary missing' }
  const r = await run(singboxBin, ['version'])
  const m = /sing-box version ([0-9.]+)/.exec(r.stdout)
  return { ok: r.ok && Boolean(m), version: m ? m[1] : '', raw: (r.stdout || r.stderr).trim().slice(0, 500) }
}

/** Run an init.d action for the core or panel service. */
export async function serviceAction(paths, which, action) {
  const script = which === 'panel' ? paths.initPanel : paths.initCore
  if (!['start', 'stop', 'restart', 'enable', 'disable', 'running'].includes(action)) {
    return { ok: false, code: 2, stderr: `unknown action: ${action}` }
  }
  if (!fs.existsSync(script)) {
    return { ok: false, code: 127, stderr: `init script not found: ${script}` }
  }
  return run(script, [action])
}

async function serviceRunning(script) {
  if (!fs.existsSync(script)) return false
  const r = await run(script, ['running'])
  return r.ok
}

/** Detect conflicting proxy services (openclash / nikki / passwall / ...). */
export async function detectConflicts() {
  const candidates = [
    { id: 'openclash', label: 'OpenClash', script: '/etc/init.d/openclash' },
    { id: 'nikki', label: 'Nikki', script: '/etc/init.d/nikki' },
    { id: 'passwall', label: 'PassWall', script: '/etc/init.d/passwall' },
    { id: 'ssr-plus', label: 'SSR Plus', script: '/etc/init.d/shadowsocksr' },
    { id: 'homeproxy', label: 'HomeProxy', script: '/etc/init.d/homeproxy' },
  ]
  const found = []
  for (const c of candidates) {
    if (await serviceRunning(c.script)) found.push({ id: c.id, label: c.label, running: true })
  }
  return found
}

/**
 * Full deploy pipeline. Never throws: returns {ok, stage, message, badTags}.
 * Stages: 'conflict' -> 'validate' -> 'start' -> 'verify' -> 'running'.
 */
export async function deployNow(ctx) {
  const { store, paths, clashApi } = ctx
  const fail = (stage, message, badTags = []) => {
    store.setDeployState({ stage, message, badTags })
    return { ok: false, stage, message, badTags }
  }

  // 1. conflicts
  const conflicts = await detectConflicts()
  if (conflicts.length) {
    return fail('conflict', `Conflicting service running: ${conflicts.map((c) => c.label).join(', ')}. Stop it first.`)
  }

  // 2. build config from current profile + subscriptions + groups
  const profile = store.getProfile()
  const nodes = []
  const regionGroups = []
  const seenTags = new Set()
  for (const sub of store.listSubscriptions()) {
    const subNodes = store.getSubscriptionNodes(sub.id)
    for (const n of subNodes) {
      if (seenTags.has(n.tag)) continue
      seenTags.add(n.tag)
      nodes.push(n)
    }
    // region groups were computed at rename time; recompute names from regionCode is
    // lossy, so we persist them per subscription instead (see api/subscriptions.mjs).
    const g = store.kvGetJson(`subgroups.${sub.id}`, [])
    for (const grp of g) regionGroups.push(grp)
  }
  fs.mkdirSync(paths.etcDir, { recursive: true })
  fs.mkdirSync(paths.rulesetDir, { recursive: true })
  const { config, droppedGroups, stats } = buildConfig({
    profile, nodes, regionGroups,
    userGroups: store.listGroups(),
    rulesetDir: paths.rulesetDir,
    clashApi, cachePath: paths.cachePath,
  })
  void droppedGroups

  // 3. ensure rule-set files exist, then validate with sing-box check
  const rs = await ensureRulesets(paths.rulesetDir, profileRulesetTags(profile))
  if (!rs.ok) {
    return fail('validate', `rule-set download failed: ${rs.failed.map((f) => `${f.tag} (${f.error})`).join(', ')}`)
  }
  const tmpPath = `${paths.configPath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2))
  const checked = await checkConfig(paths.bin, tmpPath)
  if (!checked.ok) {
    fs.rmSync(tmpPath, { force: true })
    return fail('validate', `sing-box check failed: ${checked.stderr.slice(0, 800)}`)
  }

  // 4. swap in, apply OS integration, and (re)start
  fs.renameSync(tmpPath, paths.configPath)
  const dnsR = await applyDnsTakeover(store, profile)
  if (!dnsR.ok) return fail('start', `dns takeover failed: ${dnsR.error || ''}`)
  await applyFirewall(store, profile)
  const started = await serviceAction(paths, 'core', 'restart')
  if (!started.ok) {
    return fail('start', `core service failed to start: ${started.stderr.slice(0, 500)}`)
  }

  // 5. verify: clash api answers or process stays up briefly
  await sleep(1500)
  const up = await serviceRunning(paths.initCore)
  if (!up) {
    return fail('verify', 'core service exited right after start; rolled back to previous config is manual')
  }

  const msg = `running: ${stats.nodes} nodes, ${stats.regionGroups} region groups, ${stats.userGroups} custom groups`
  store.setDeployState({ stage: 'running', message: msg, badTags: [] })
  return { ok: true, stage: 'running', message: msg, badTags: [] }
}

/**
 * Emergency rollback: stop the core, remove firewall/DNS changes, disable autostart.
 * Best-effort per step; returns the list of actions taken.
 */
export async function rollbackToDirect(ctx) {
  const { store, paths } = ctx
  const actions = []
  const step = async (label, fn) => {
    try {
      const r = await fn()
      actions.push(`${label}: ${r.ok ? 'ok' : `failed (${String(r.stderr || r.error || '').slice(0, 120)})`}`)
    } catch (e) {
      actions.push(`${label}: error (${String(e.message || e).slice(0, 120)})`)
    }
  }
  await step('stop core', () => serviceAction(paths, 'core', 'stop'));
  await step('disable autostart', () => serviceAction(paths, 'core', 'disable'));
  await step('restore dnsmasq', () => removeDnsTakeover(store));
  await step('flush firewall', () => flushFirewall(store));
  return { ok: true, actions }
}
