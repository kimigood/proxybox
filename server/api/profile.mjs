import { Router } from 'express'
import { isObj } from '../lib/util.mjs'

export function profileRouter(store) {
  const r = Router()

  r.get('/', (req, res) => {
    res.json({ profile: store.getProfile() })
  })

  r.get('/defaults', (req, res) => {
    res.json({ defaults: store.regionDefaults(String(req.query.region || 'CN')) })
  })

  r.put('/', (req, res) => {
    try {
      if (!isObj(req.body)) throw new Error('patch must be an object')
      // Guard the ruleset tag pattern the frontend also enforces.
      const bad = []
      const checkTags = (list) => {
        for (const t of list || []) {
          if (!/^[A-Za-z0-9._!-]+$/.test(String(t))) bad.push(t)
        }
      }
      checkTags((req.body.routing || {}).directRulesets)
      checkTags(((req.body.routing || {}).categories || []).map((c) => c.ruleset))
      if (bad.length) throw new Error(`bad ruleset tag: ${bad[0]}`)
      res.json({ profile: store.patchProfile(req.body) })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  return r
}
