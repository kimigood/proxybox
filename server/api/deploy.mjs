import { Router } from 'express'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { assembleInputs } from '../lib/assemble.mjs'
import { buildConfig } from '../lib/config.mjs'
import { deployNow, rollbackToDirect } from '../lib/service.mjs'

function clashSecret(store) {
  let s = store.kvGet('clash.secret')
  if (!s) {
    s = randomBytes(16).toString('hex')
    store.kvSet('clash.secret', s)
  }
  return s
}

function buildPreviewConfig(store, paths) {
  const { nodes, regionGroups } = assembleInputs(store)
  const { config } = buildConfig({
    profile: store.getProfile(),
    nodes,
    regionGroups,
    userGroups: store.listGroups(),
    rulesetDir: paths.rulesetDir,
    clashApi: { port: 9095, secret: 'preview' },
    cachePath: paths.cachePath,
  })
  return config
}

export function deployRouter(store, paths) {
  const r = Router()

  r.post('/', async (req, res) => {
    try {
      const result = await deployNow({
        store,
        paths,
        clashApi: { port: 9095, secret: clashSecret(store) },
      })
      res.status(result.ok ? 200 : 500).json(result)
    } catch (e) {
      res.status(500).json({ ok: false, stage: 'error', message: String(e.message || e), badTags: [] })
    }
  })

  r.get('/state', (req, res) => {
    res.json({ state: store.getDeployState() })
  })

  r.get('/config/preview', (req, res) => {
    try {
      res.json({ config: buildPreviewConfig(store, paths) })
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) })
    }
  })

  r.post('/rollback', async (req, res) => {
    try {
      const result = await rollbackToDirect({ store, paths })
      store.setDeployState({ stage: 'idle', message: 'rolled back to direct', badTags: [] })
      res.json(result)
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e.message || e) })
    }
  })

  return r
}

// Rule penetration lives at /api/openbox/penetration (separate mount point,
// matching what the panel frontend calls).
export function penetrationRouter(store, paths) {
  const r = Router()

  // Rule penetration: which route rule would a target hit?
  // Locally-decidable conditions are evaluated here; rule_set membership
  // needs the sing-box binary and is reported as matchError when unavailable.
  r.post('/', (req, res) => {
    try {
      const target = String(req.body?.target || '').trim()
      if (!target || target.startsWith('-') || !/^[A-Za-z0-9._:-]+$/.test(target)) {
        return res.status(400).json({ error: 'bad target' })
      }
      const config = buildPreviewConfig(store, paths)
      const rules = config.route.rules || []
      const isIp = net.isIP(target) !== 0
      const privateRe = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1|fc|fd|fe80)/i

      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i]
        if (rule.ip_is_private && isIp && privateRe.test(target)) {
          return res.json({
            matched: { index: i, rule: { ip_is_private: true }, outbound: rule.outbound },
            chain: [rule.outbound || ''],
            finalOutbound: rule.outbound || null,
          })
        }
        if (rule.action === 'hijack-dns') continue
        if (rule.rule_set) {
          return res.json({
            matched: null,
            chain: [],
            finalOutbound: null,
            matchError: `rule_set '${rule.rule_set}' membership needs the sing-box binary to evaluate`,
          })
        }
        if (rule.outbound) {
          return res.json({
            matched: { index: i, rule: {}, outbound: rule.outbound },
            chain: [rule.outbound],
            finalOutbound: rule.outbound,
          })
        }
      }
      const final = config.route.final || null
      res.json({ matched: null, chain: final ? [final] : [], finalOutbound: final })
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) })
    }
  })

  return r
}
