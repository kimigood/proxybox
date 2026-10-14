import { Router } from 'express'
import fs from 'node:fs'
import { detectConflicts, kernelVersion, serviceAction } from '../lib/service.mjs'

async function probe(script) {
  if (!fs.existsSync(script)) return { running: false, raw: 'not installed' }
  const r = await serviceAction({ initCore: script, initPanel: script }, 'core', 'running')
  return { running: r.ok, raw: (r.stdout || r.stderr || '').trim().slice(0, 300) }
}

export function serviceRouter(paths) {
  const r = Router()

  r.get('/status', async (req, res) => {
    const [core, panel, conflicts] = await Promise.all([
      probe(paths.initCore),
      probe(paths.initPanel),
      detectConflicts(),
    ])
    res.json({ core, panel, conflicts })
  })

  r.post('/core/:action', async (req, res) => {
    const { action } = req.params
    if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) {
      return res.status(400).json({ ok: false, code: 2, stderr: 'unknown action' })
    }
    const result = await serviceAction(paths, 'core', action)
    res.json(result)
  })

  r.get('/kernel/version', async (req, res) => {
    res.json(await kernelVersion(paths.bin))
  })

  return r
}
