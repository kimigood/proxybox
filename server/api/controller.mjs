// Proxy to sing-box's clash_api (127.0.0.1:9095):
//   HTTP  /api/controller/*    -> http://127.0.0.1:9095/*
//   WS    /api/controller-ws/* -> ws://127.0.0.1:9095/*
// The clash secret never leaves the server: the browser talks to us, we add
// the Authorization header. When the core is down we answer 502 (the frontend
// renders that as a connection problem, not an auth problem).
import { Router } from 'express'
import { WebSocket, WebSocketServer } from 'ws'

function clashBase() {
  return 'http://127.0.0.1:9095'
}

export function controllerRouter(store) {
  const r = Router()
  const secret = () => store.kvGet('clash.secret') || ''

  r.use(async (req, res) => {
    const target = clashBase() + req.path + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')
    try {
      const headers = { Authorization: `Bearer ${secret()}` }
      if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type']
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
      })
      const text = await upstream.text()
      res.status(upstream.status)
      const ct = upstream.headers.get('content-type')
      if (ct) res.set('content-type', ct)
      res.send(text)
    } catch (e) {
      res.status(502).json({ message: `core unreachable: ${String(e.message || e)}` })
    }
  })

  return r
}

/** Attach the WS proxy. Call with the http server returned by app.listen(). */
export function attachControllerWs(server, store) {
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const m = /^\/api\/controller-ws\/(.+)$/.exec(req.url.split('?')[0])
    if (!m) {
      socket.destroy()
      return
    }
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
    const secret = store.kvGet('clash.secret') || ''
    const upstream = new WebSocket(`ws://127.0.0.1:9095/${m[1]}${query}`, {
      headers: { Authorization: `Bearer ${secret}` },
    })
    wss.handleUpgrade(req, socket, head, (client) => {
      const pipe = (from, to) => {
        from.on('message', (data) => {
          if (to.readyState === WebSocket.OPEN) to.send(data)
        })
      }
      const closeBoth = () => {
        try { client.close() } catch { /* noop */ }
        try { upstream.close() } catch { /* noop */ }
      }
      pipe(client, upstream)
      pipe(upstream, client)
      client.on('close', closeBoth)
      upstream.on('close', closeBoth)
      client.on('error', closeBoth)
      upstream.on('error', closeBoth)
    })
  })
}
