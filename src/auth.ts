import { setTokenSource } from './drive'

// Full scope: drive.file cannot see hand-made folders.
const SCOPE = 'https://www.googleapis.com/auth/drive'

export type AuthState = 'loading' | 'signedOut' | 'signedIn' | 'reconnect'

let state: AuthState = 'loading'
const listeners = new Set<() => void>()
const setState = (s: AuthState) => {
  state = s
  listeners.forEach((fn) => fn())
}
export function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}
export const getAuthState = () => state

// Token lives in memory only.
let token: string | null = null
let expiresAt = 0
let client: google.accounts.oauth2.TokenClient
let pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null
let refreshing: Promise<string> | null = null
const waiters: { res: (t: string) => void; rej: (e: Error) => void }[] = []

function request(silent = false) {
  return new Promise<string>((resolve, reject) => {
    pending = { resolve, reject }
    client.requestAccessToken(silent ? { prompt: '' } : {})
  })
}

const refresh = () =>
  (refreshing ??= request(true)
    .catch(() => {
      setState('reconnect')
      return new Promise<string>((res, rej) => waiters.push({ res, rej }))
    })
    .finally(() => {
      refreshing = null
    }))

const get = () => (token && Date.now() < expiresAt ? Promise.resolve(token) : refresh())

// Env var wins; otherwise the ID pasted in the UI (this browser only).
const CID_KEY = 'googleClientId'
export const envClientId = !!import.meta.env.VITE_GOOGLE_CLIENT_ID
export function clientId(): string {
  if (envClientId) return import.meta.env.VITE_GOOGLE_CLIENT_ID
  try {
    return localStorage.getItem(CID_KEY) ?? ''
  } catch {
    return ''
  }
}
export function setClientId(id: string) {
  if (id.trim()) localStorage.setItem(CID_KEY, id.trim())
  else localStorage.removeItem(CID_KEY)
  location.reload() // GIS client is created once at startup
}

export async function initAuth() {
  if (!clientId()) return
  if (!globalThis.google?.accounts?.oauth2) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script')
      s.src = 'https://accounts.google.com/gsi/client'
      s.async = true
      s.onload = () => resolve()
      s.onerror = () => reject(new Error('Failed to load Google Identity Services'))
      document.head.append(s)
    })
  }
  client = google.accounts.oauth2.initTokenClient({
    client_id: clientId(),
    scope: SCOPE,
    callback: (r) => {
      if (r.error) return pending?.reject(new Error(r.error))
      token = r.access_token
      expiresAt = Date.now() + Number(r.expires_in) * 1000 - 60_000
      setState('signedIn')
      pending?.resolve(token)
    },
    error_callback: (e) => pending?.reject(new Error(e.type)),
  })
  setTokenSource({ get, refresh })
  setState('signedOut')
}

// Both must be called from a click (popup).
export async function signIn() {
  const t = await request()
  waiters.splice(0).forEach((w) => w.res(t))
}
export const reconnect = signIn

export function signOut() {
  if (token) google.accounts.oauth2.revoke(token, () => {})
  token = null
  expiresAt = 0
  waiters.splice(0).forEach((w) => w.rej(new Error('signed out')))
  setState('signedOut')
}

// Manual expiry testing from DevTools.
if (import.meta.env.DEV) (globalThis as { __expireToken?: () => void }).__expireToken = () => (expiresAt = 0)
