// ProxyBox backend entry point.
// Serves the (MIT-licensed, zashboard-derived) panel frontend and exposes the
// JSON API the frontend expects. Run as root on the router; the panel port
// must stay LAN-only (see README security notes).
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAuth } from './lib/auth.mjs'
import { openStore } from './lib/store.mjs'
import { resolvePaths } from './lib/service.mjs'
import { authRouter } from './api/auth.mjs'
import { profileRouter } from './api/profile.mjs'
import { subscriptionsRouter } from './api/subscriptions.mjs'
import { groupsRouter } from './api/groups.mjs'
import { deployRouter, penetrationRouter } from './api/deploy.mjs'
import { controllerRouter, attachControllerWs } from './api/controller.mjs'
import { startSchedulers } from './lib/scheduler.mjs'
import { serviceRouter } from './api/service.mjs'
import { trafficRouter } from './api/traffic.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const paths = resolvePaths(process.env.PROXYBOX_ROOT || ROOT)
fs.mkdirSync(paths.dataDir, { recursive: true })

const store = openStore(paths.dataDir)
const auth = createAuth(store)

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '8mb' }))

// Minimal cookie parser (no extra dependency).
app.use((req, _res, next) => {
  req.cookies = {}
  const header = req.headers.cookie
  if (header) {
    for (const part of header.split(';')) {
      const idx = part.indexOf('=')
      if (idx > 0) req.cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
    }
  }
  next()
})

// --- public auth routes ---
app.use('/api/auth', authRouter(auth))

// --- everything else needs a session ---
app.use('/api/openbox', auth.requireAuth)
app.use('/api/openbox/profile', profileRouter(store))
app.use('/api/openbox/subscriptions', subscriptionsRouter(store))
app.use('/api/openbox/groups', groupsRouter(store))
app.use('/api/openbox/deploy', deployRouter(store, paths))
app.use('/api/openbox/penetration', penetrationRouter(store, paths))
app.use('/api/openbox/service', serviceRouter(paths))
app.use('/api/openbox/traffic', auth.requireAuth, trafficRouter(store))
// clash_api proxy (HTTP + WS) for the panel's runtime pages
app.use('/api/controller', auth.requireAuth, controllerRouter(store))

// --- frontend (built dist if present, otherwise a stub page) ---
// Dev layout: <repo>/panel/dist ; installed layout: /opt/proxybox/panel
const distDir = [path.join(ROOT, 'panel', 'dist'), path.join(ROOT, 'panel')]
  .find(d => fs.existsSync(path.join(d, 'index.html')))
if (distDir) {
  app.use(express.static(distDir))
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')))
} else {
  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>ProxyBox</title>
<h1>ProxyBox backend is running</h1>
<p>Panel frontend not built yet. API is live under <code>/api</code>.</p>`)
  })
}

// --- error handler ---
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: String(err.message || err) })
})

const PORT = Number(process.env.PROXYBOX_PORT || 3037)
const HOST = process.env.PROXYBOX_HOST || '0.0.0.0'
const server = app.listen(PORT, HOST, () => {
  console.log(`[proxybox] panel on http://${HOST === '0.0.0.0' ? '<lan-ip>' : HOST}:${PORT}`)
  console.log(`[proxybox] root: ${paths.root}`)
})
attachControllerWs(server, store)
if (process.env.PROXYBOX_NO_SCHED !== '1') {
  startSchedulers({ store, paths })
}
