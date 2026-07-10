import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const SESSION_COOKIE_NAME = "kanna_session"
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const LOGIN_WINDOW_MS = 60 * 1_000
const MAX_LOGIN_FAILURES_PER_WINDOW = 10
const MAX_ACTIVE_SESSIONS = 64
const SESSION_STORE_VERSION = 1

interface PersistedSession {
  tokenHash: string
  expiresAt: number
}

interface PersistedSessionStore {
  v: typeof SESSION_STORE_VERSION
  salt: string
  sessions: PersistedSession[]
  mac: string
}

export interface AuthStatusPayload {
  enabled: boolean
  authenticated: boolean
}

export interface AuthManager {
  isAuthenticated(req: Request): boolean
  validateOrigin(req: Request): boolean
  redirectToApp(req: Request): Response
  handleLogin(req: Request, nextPath: string): Promise<Response>
  handleLogout(req: Request): Promise<Response>
  handleStatus(req: Request): Response
}

function parseCookies(header: string | null) {
  const cookies = new Map<string, string>()
  if (!header) return cookies

  for (const segment of header.split(";")) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf("=")
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    cookies.set(key, decodeURIComponent(value))
  }

  return cookies
}

function sanitizeNextPath(nextPath: string | null | undefined) {
  if (!nextPath || typeof nextPath !== "string") return "/"
  if (!nextPath.startsWith("/")) return "/"
  if (nextPath.startsWith("//")) return "/"
  if (nextPath.startsWith("/auth/login")) return "/"
  return nextPath
}

function forwardedProto(req: Request): "http" | "https" | null {
  const xfp = req.headers.get("x-forwarded-proto")
  if (!xfp) return null
  const value = xfp.split(",")[0]?.trim().toLowerCase()
  return value === "http" || value === "https" ? value : null
}

function effectiveOrigin(req: Request, trustProxy: boolean): string {
  const url = new URL(req.url)
  if (!trustProxy) return url.origin
  const proto = forwardedProto(req)
  const scheme = proto ?? url.protocol.replace(":", "")
  return `${scheme}://${url.host}`
}

function shouldUseSecureCookie(req: Request, trustProxy: boolean) {
  if (trustProxy) {
    const proto = forwardedProto(req)
    if (proto) return proto === "https"
  }
  return new URL(req.url).protocol === "https:"
}

function buildCookie(name: string, value: string, req: Request, trustProxy: boolean, extras: string[] = []) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ]

  if (shouldUseSecureCookie(req, trustProxy)) {
    parts.push("Secure")
  }

  parts.push(...extras)
  return parts.join("; ")
}

async function readLoginForm(req: Request) {
  const contentType = req.headers.get("content-type") ?? ""

  if (contentType.includes("application/json")) {
    const payload = await req.json() as { password?: unknown; next?: unknown }
    return {
      password: typeof payload.password === "string" ? payload.password : "",
      nextPath: sanitizeNextPath(typeof payload.next === "string" ? payload.next : "/"),
    }
  }

  const formData = await req.formData()
  return {
    password: String(formData.get("password") ?? ""),
    nextPath: sanitizeNextPath(String(formData.get("next") ?? "/")),
  }
}

export interface AuthManagerOptions {
  /**
   * When true, the auth layer trusts X-Forwarded-Proto to decide whether the
   * public origin is http or https. The hostname always comes from the Host
   * header (never X-Forwarded-Host) because X-Forwarded-Host is passed
   * through by some tunnels unmodified and would otherwise allow open
   * redirects.
   * Enable only when the server is reachable solely through a trusted reverse
   * proxy such as cloudflared.
   */
  trustProxy?: boolean
  sessionStorePath?: string
}

function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("base64url")
}

function getSessionStorePayload(salt: string, sessions: PersistedSession[]) {
  return JSON.stringify({
    v: SESSION_STORE_VERSION,
    salt,
    sessions,
  })
}

function getSessionStoreMac(password: string, salt: string, sessions: PersistedSession[]) {
  const key = scryptSync(password, Buffer.from(salt, "base64url"), 32)
  return createHmac("sha256", key).update(getSessionStorePayload(salt, sessions)).digest("base64url")
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<PersistedSession>
  return typeof candidate.tokenHash === "string"
    && candidate.tokenHash.length > 0
    && typeof candidate.expiresAt === "number"
    && Number.isFinite(candidate.expiresAt)
}

async function loadPersistedSessions(password: string, sessionStorePath?: string) {
  const empty = () => ({
    salt: randomBytes(16).toString("base64url"),
    sessions: new Map<string, number>(),
  })
  if (!sessionStorePath) return empty()

  let parsed: Partial<PersistedSessionStore>
  try {
    parsed = JSON.parse(await readFile(sessionStorePath, "utf8")) as Partial<PersistedSessionStore>
  } catch {
    return empty()
  }

  if (parsed.v !== SESSION_STORE_VERSION
    || typeof parsed.salt !== "string"
    || !Array.isArray(parsed.sessions)
    || typeof parsed.mac !== "string") {
    return empty()
  }

  const persistedSessions = parsed.sessions.filter(isPersistedSession)
  const expectedMac = getSessionStoreMac(password, parsed.salt, persistedSessions)
  const actualMac = Buffer.from(parsed.mac)
  const expectedMacBuffer = Buffer.from(expectedMac)
  if (actualMac.length !== expectedMacBuffer.length || !timingSafeEqual(actualMac, expectedMacBuffer)) {
    return empty()
  }

  const now = Date.now()
  const activeSessions = persistedSessions
    .filter((session) => session.expiresAt > now)
    .sort((left, right) => right.expiresAt - left.expiresAt)
    .slice(0, MAX_ACTIVE_SESSIONS)

  return {
    salt: parsed.salt,
    sessions: new Map(activeSessions.map((session) => [session.tokenHash, session.expiresAt])),
  }
}

export async function createAuthManager(password: string, options: AuthManagerOptions = {}): Promise<AuthManager> {
  const persisted = await loadPersistedSessions(password, options.sessionStorePath)
  const sessions = persisted.sessions
  const sessionSalt = persisted.salt
  const loginFailures = new Map<string, number[]>()
  const expectedPassword = Buffer.from(password)
  const trustProxy = options.trustProxy ?? false
  let sessionWriteChain = Promise.resolve()

  function persistSessions() {
    if (!options.sessionStorePath) return Promise.resolve()

    const persist = async () => {
      const entries = [...sessions.entries()]
        .map(([tokenHash, expiresAt]) => ({ tokenHash, expiresAt }))
        .sort((left, right) => left.tokenHash.localeCompare(right.tokenHash))
      const payload: PersistedSessionStore = {
        v: SESSION_STORE_VERSION,
        salt: sessionSalt,
        sessions: entries,
        mac: getSessionStoreMac(password, sessionSalt, entries),
      }
      const sessionStorePath = options.sessionStorePath!
      const tempPath = `${sessionStorePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
      await mkdir(path.dirname(sessionStorePath), { recursive: true })
      try {
        await writeFile(tempPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 })
        await rename(tempPath, sessionStorePath)
        await chmod(sessionStorePath, 0o600)
      } finally {
        await rm(tempPath, { force: true })
      }
    }

    sessionWriteChain = sessionWriteChain.then(persist, persist)
    return sessionWriteChain
  }

  function getSessionToken(req: Request) {
    return parseCookies(req.headers.get("cookie")).get(SESSION_COOKIE_NAME) ?? null
  }

  function isAuthenticated(req: Request) {
    const sessionToken = getSessionToken(req)
    if (!sessionToken) return false
    const tokenHash = hashSessionToken(sessionToken)
    const expiresAt = sessions.get(tokenHash)
    if (!expiresAt) return false
    if (expiresAt <= Date.now()) {
      sessions.delete(tokenHash)
      void persistSessions()
      return false
    }
    return true
  }

  function validateOrigin(req: Request) {
    const origin = req.headers.get("origin")
    if (!origin) return true
    if (origin === new URL(req.url).origin) return true
    if (!trustProxy) return false
    return origin === effectiveOrigin(req, trustProxy)
  }

  async function createSessionCookie(req: Request) {
    const sessionToken = randomBytes(32).toString("base64url")
    if (sessions.size >= MAX_ACTIVE_SESSIONS) {
      const oldest = [...sessions.entries()].sort((left, right) => left[1] - right[1])[0]?.[0]
      if (oldest) sessions.delete(oldest)
    }
    sessions.set(hashSessionToken(sessionToken), Date.now() + SESSION_TTL_MS)
    await persistSessions()
    return buildCookie(SESSION_COOKIE_NAME, sessionToken, req, trustProxy)
  }

  async function clearSessionCookie(req: Request) {
    const sessionToken = getSessionToken(req)
    if (sessionToken) {
      sessions.delete(hashSessionToken(sessionToken))
      await persistSessions()
    }
    return buildCookie(SESSION_COOKIE_NAME, "", req, trustProxy, ["Max-Age=0"])
  }

  function verifyPassword(candidate: string) {
    const actual = Buffer.from(candidate)
    if (actual.length !== expectedPassword.length) {
      return false
    }
    return timingSafeEqual(actual, expectedPassword)
  }

  function loginIdentity(req: Request) {
    if (!trustProxy) return "direct"
    return req.headers.get("cf-connecting-ip")
      ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      ?? "proxy"
  }

  function recentFailures(req: Request) {
    const identity = loginIdentity(req)
    const cutoff = Date.now() - LOGIN_WINDOW_MS
    const recent = (loginFailures.get(identity) ?? []).filter((timestamp) => timestamp >= cutoff)
    if (recent.length) loginFailures.set(identity, recent)
    else loginFailures.delete(identity)
    return { identity, recent }
  }

  function handleStatus(req: Request) {
    return Response.json({
      enabled: true,
      authenticated: isAuthenticated(req),
    } satisfies AuthStatusPayload)
  }

  function redirectToApp(req: Request) {
    const currentUrl = new URL(req.url)
    return Response.redirect(new URL(sanitizeNextPath(currentUrl.searchParams.get("next")), effectiveOrigin(req, trustProxy)), 302)
  }

  async function handleLogin(req: Request, fallbackNextPath: string) {
    if (!validateOrigin(req)) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    const { identity, recent } = recentFailures(req)
    if (recent.length >= MAX_LOGIN_FAILURES_PER_WINDOW) {
      return Response.json({ error: "Too many login attempts" }, { status: 429, headers: { "Retry-After": "60" } })
    }

    const { password: candidate, nextPath } = await readLoginForm(req)
    if (!verifyPassword(candidate)) {
      loginFailures.set(identity, [...recent, Date.now()])
      return Response.json({ error: "Invalid password" }, { status: 401 })
    }

    loginFailures.delete(identity)

    const response = Response.json({ ok: true, nextPath: sanitizeNextPath(nextPath || fallbackNextPath) })

    response.headers.set("Set-Cookie", await createSessionCookie(req))
    return response
  }

  async function handleLogout(req: Request) {
    if (!validateOrigin(req)) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    const response = Response.json({ ok: true })
    response.headers.set("Set-Cookie", await clearSessionCookie(req))
    return response
  }

  return {
    isAuthenticated,
    validateOrigin,
    redirectToApp,
    handleLogin,
    handleLogout,
    handleStatus,
  }
}
