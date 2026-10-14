import { Router } from 'express'

const TYPES = ['urltest', 'selector']

export function groupsRouter(store) {
  const r = Router()

  r.get('/', (req, res) => {
    const groups = store.listGroups()
    const availableNodes = []
    const availableGroups = new Set()
    for (const sub of store.listSubscriptions()) {
      for (const n of store.getSubscriptionNodes(sub.id)) {
        availableNodes.push({ name: n.tag, subscription: sub.name })
      }
      for (const g of store.kvGetJson(`subgroups.${sub.id}`, [])) {
        availableGroups.add(g.name)
      }
    }
    for (const g of groups) availableGroups.add(g.name)
    res.json({ groups, types: TYPES, availableNodes, availableGroups: [...availableGroups] })
  })

  // Whole-document replace (groups can reference each other; partial edits
  // would leave dangling references mid-way).
  r.put('/', (req, res) => {
    try {
      const groups = store.replaceGroups(req.body?.groups)
      const nodeTags = new Set(store.allNodes().map((n) => n.tag))
      const dropped = []
      const kept = []
      for (const g of groups) {
        const members = g.allNodes ? [...nodeTags] : g.members.filter((m) => nodeTags.has(m))
        if (!members.length) {
          dropped.push({ name: g.name, reason: 'no valid members' })
          continue
        }
        kept.push(g)
      }
      store.replaceGroups(kept)
      res.json({ ok: true, groups: kept, dropped })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  return r
}
