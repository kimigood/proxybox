import { Router } from 'express'

export function authRouter(auth) {
  const r = Router()

  r.get('/status', (req, res) => {
    res.json(auth.status(auth.tokenFrom(req)))
  })

  r.post('/setup', (req, res) => {
    try {
      auth.setup(req.body?.password)
      const result = auth.login(req.body?.password)
      auth.setCookie(res, result.token)
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) })
    }
  })

  r.post('/login', (req, res) => {
    const result = auth.login(req.body?.password)
    if (!result.ok) {
      return res.status(401).json({ code: result.code })
    }
    auth.setCookie(res, result.token)
    res.json({ ok: true })
  })

  r.post('/logout', (req, res) => {
    auth.logout(auth.tokenFrom(req))
    auth.clearCookie(res)
    res.json({ ok: true })
  })

  r.post('/change-password', auth.requireAuth, (req, res) => {
    try {
      auth.changePassword(req.body?.oldPassword, req.body?.newPassword)
      auth.clearCookie(res)
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ code: e.code || 'ERROR', error: String(e.message || e) })
    }
  })

  return r
}
