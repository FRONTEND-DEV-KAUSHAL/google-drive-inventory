import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TokenSource } from './drive'

let source: TokenSource
let mode: 'ok' | 'fail'
let n: number
let request: ReturnType<typeof vi.fn>
let revoke: ReturnType<typeof vi.fn>
let auth: typeof import('./auth')

vi.mock('./drive', () => ({ setTokenSource: (t: TokenSource) => (source = t) }))

beforeEach(async () => {
  mode = 'ok'
  n = 0
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'cid')
  request = vi.fn()
  revoke = vi.fn((_t: string, cb?: () => void) => cb?.())
  vi.stubGlobal('google', {
    accounts: {
      oauth2: {
        initTokenClient: (cfg: any) => ({
          requestAccessToken: request.mockImplementation(() =>
            mode === 'ok'
              ? cfg.callback({ access_token: 'tok' + ++n, expires_in: 3599 })
              : cfg.error_callback({ type: 'popup_failed_to_open' }),
          ),
        }),
        revoke,
      },
    },
  })
  vi.resetModules()
  auth = await import('./auth')
  await auth.initAuth()
})

afterEach(() => vi.useRealTimers())

describe('auth', () => {
  it('signs in', async () => {
    expect(auth.getAuthState()).toBe('signedOut')
    await auth.signIn()
    expect(auth.getAuthState()).toBe('signedIn')
    expect(await source.get()).toBe('tok1')
  })

  it('refreshes silently with prompt ""', async () => {
    await auth.signIn()
    expect(await source.refresh()).toBe('tok2')
    expect(request).toHaveBeenLastCalledWith({ prompt: '' })
  })

  it('silently re-requests after expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await auth.signIn()
    vi.setSystemTime(Date.now() + 3600_000)
    expect(await source.get()).toBe('tok2')
  })

  it('goes to reconnect on silent failure and resumes after reconnect', async () => {
    await auth.signIn()
    mode = 'fail'
    const p = source.refresh()
    await vi.waitFor(() => expect(auth.getAuthState()).toBe('reconnect'))
    mode = 'ok'
    await auth.reconnect()
    expect(await p).toBe('tok2')
    expect(auth.getAuthState()).toBe('signedIn')
  })

  it('dedupes concurrent refreshes', async () => {
    await auth.signIn()
    request.mockClear()
    await Promise.all([source.refresh(), source.refresh()])
    expect(request).toHaveBeenCalledOnce()
  })

  it('signs out and revokes', async () => {
    await auth.signIn()
    auth.signOut()
    expect(revoke).toHaveBeenCalledWith('tok1', expect.any(Function))
    expect(auth.getAuthState()).toBe('signedOut')
  })
})
