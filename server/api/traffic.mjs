// Daily traffic statistics collected from the clash API.
// GET /api/openbox/traffic?month=YYYY-MM  -> { month, days:[{day,up,down,conns}], totalUp, totalDown, totalConns, avgPerDay }
import { Router } from 'express'

export function trafficRouter(store) {
  const r = Router()

  r.get('/', (req, res) => {
    let month = String(req.query.month || '')
    if (!/^\d{4}-\d{2}$/.test(month)) {
      const now = new Date()
      month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    }
    try {
      res.json(store.getTrafficMonth(month))
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) })
    }
  })

  return r
}
