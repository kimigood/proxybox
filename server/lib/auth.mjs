// Password + session handling for the panel login wall.
// - Passwords are stored as scrypt hashes (salt$hash) in the kv store.
// - Sessions are opaque random tokens kept server-side with an expiry;
//   the token travels in an HttpOnly, SameSite=Lax cookie.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7 // 7 days
const COOKIE_NAME = 'proxybox_session'

const sessions = new Map() // token -> expiresAt

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(String(password), salt, 64).toString('hex')
  return `${salt}$${hash}`
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split('$')
  if (!salt || !hash) return false
  const candidate = scryptSync(String(password), salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

export function createAuth(store) {
  function isSetup() {
    return Boolean(store.kvGet('auth.password_hash'))
  }

  function setup(password) {
    if (isSetup()) throw new Error('already set up')
    if (!password || String(password).length < 4) throw new Error('password too short')
    store.kvSet('auth.password_hash', hashPassword(password))
  }

  function changePassword(oldPassword, newPassword) {
    const stored = store.kvGet('auth.password_hash')
    if (!verifyPassword(oldPassword, stored)) {
      const err = new Error('old password incorrect')
      err.code = 'BAD_OLD_PASSWORD'
      throw err
    }
    if (!newPassword || String(newPassword).length < 4) throw new Error('password too short')
    store.kvSet('auth.password_hash', hashPassword(newPassword))
    sessions.clear()
  }

  function login(password) {
    const stored = store.kvGet('auth.password_hash')
    if (!stored) return { ok: false, code: 'NOT_SETUP' }
    if (!verifyPassword(password, stored)) return { ok: false, code: 'INVALID_PASSWORD' }
    const token = randomBytes(32).toString('hex')
    sessions.set(token, Date.now() + SESSION_TTL_MS)
    return { ok: true, token }
  }

  function logout(token) {
    if (token) sessions.delete(token)
  }

  function validSession(token) {
    if (!token) return false
    const exp = sessions.get(token)
    if (!exp) return false
    if (exp < Date.now()) {
      sessions.delete(token)
      return false
    }
    return true
  }

  function status(token) {
    const enabled = isSetup()
    return { enabled, authenticated: enabled && validSession(token) }
  }

  /** Express middleware: require a valid session. */
  function requireAuth(req, res, next) {
    const token = req.cookies?.[COOKIE_NAME]
    if (!validSession(token)) {
      return res.status(401).json({ error: 'auth required' })
    }
    next()
  }

  function setCookie(res, token) {
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
      path: '/',
    })
  }

  function clearCookie(res) {
    res.clearCookie(COOKIE_NAME, { path: '/' })
  }

  function tokenFrom(req) {
    return req.cookies?.[COOKIE_NAME]
  }

  return {
    isSetup,
    setup,
    changePassword,
    login,
    logout,
    status,
    requireAuth,
    setCookie,
    clearCookie,
    tokenFrom,
    COOKIE_NAME,
  }
}
