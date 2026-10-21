import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DriveError, createJsonFile, driveFetch, listFiles, putUpload, shareAnyone, startUpload, setTokenSource, trash, updateFile, writeJsonFile } from './drive'

const res = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status })

const tokens = { get: vi.fn(async () => 't1'), refresh: vi.fn(async () => 't2') }
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  tokens.refresh.mockClear()
  setTokenSource(tokens)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// Runs a call to completion under fake timers, returning its settled outcome.
async function settle<T>(p: Promise<T>) {
  const out = p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  )
  await vi.runAllTimersAsync()
  return out
}

describe('driveFetch', () => {
  it('retries 429 then succeeds', async () => {
    fetchMock.mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200, { ok: 1 }))
    const r = await settle(driveFetch('/files'))
    expect(r).toEqual({ ok: true, v: { ok: 1 } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after 5 attempts on 503', async () => {
    fetchMock.mockImplementation(async () => res(503))
    const r = await settle(driveFetch('/files'))
    expect(r.ok).toBe(false)
    expect((r as { e: DriveError }).e).toMatchObject({ status: 503 })
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('retries 403 userRateLimitExceeded', async () => {
    fetchMock
      .mockResolvedValueOnce(res(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }))
      .mockResolvedValueOnce(res(200, { ok: 1 }))
    const r = await settle(driveFetch('/files'))
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails fast on 403 insufficientPermissions', async () => {
    fetchMock.mockResolvedValue(res(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }))
    const r = await settle(driveFetch('/files'))
    expect((r as { e: DriveError }).e).toMatchObject({ status: 403, reason: 'insufficientPermissions' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries network errors', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('x')).mockResolvedValueOnce(res(200, { ok: 1 }))
    const r = await settle(driveFetch('/files'))
    expect(r.ok).toBe(true)
  })

  it('refreshes token once on 401 and retries', async () => {
    fetchMock.mockResolvedValueOnce(res(401)).mockResolvedValueOnce(res(200, { ok: 1 }))
    const r = await settle(driveFetch('/files'))
    expect(r.ok).toBe(true)
    expect(tokens.refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer t2')
  })

  it('throws after second 401', async () => {
    fetchMock.mockImplementation(async () => res(401))
    const r = await settle(driveFetch('/files'))
    expect((r as { e: DriveError }).e).toMatchObject({ status: 401 })
    expect(tokens.refresh).toHaveBeenCalledTimes(1)
  })
})

describe('trash', () => {
  it('PATCHes trashed:true', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { id: 'abc', trashed: true }))
    await settle(trash('abc'))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://www.googleapis.com/drive/v3/files/abc?fields=id%2Ctrashed')
    expect(init.method).toBe('PATCH')
    expect(init.body).toBe('{"trashed":true}')
  })
})

describe('listFiles', () => {
  it('pages and excludes trashed', async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { files: [{ id: 'a' }], nextPageToken: 'n' }))
      .mockResolvedValueOnce(res(200, { files: [{ id: 'b' }] }))
    const r = await settle(listFiles("name='x'"))
    expect(r).toMatchObject({ ok: true, v: [{ id: 'a' }, { id: 'b' }] })
    const [u1, u2] = fetchMock.mock.calls.map((c) => c[0] as string)
    for (const u of [u1, u2]) {
      expect(u).toContain('trashed%3Dfalse')
      expect(u).toContain('pageSize=1000')
    }
    expect(u2).toContain('pageToken=n')
  })
})

describe('write helpers', () => {
  const call = () => fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
  beforeEach(() => fetchMock.mockImplementation(async () => res(200, { id: 'x' })))

  it('updateFile rename+move', async () => {
    await settle(updateFile('f', { name: 'b', addParents: 'c2', removeParents: 'c1' }))
    const [url, init] = call()
    expect(url).toBe('https://www.googleapis.com/drive/v3/files/f?fields=id%2Cname%2Cparents&addParents=c2&removeParents=c1')
    expect(init.method).toBe('PATCH')
    expect(init.body).toBe('{"name":"b"}')
  })
  it('updateFile move only sends empty body', async () => {
    await settle(updateFile('f', { addParents: 'c2', removeParents: 'c1' }))
    expect(call()[1].body).toBe('{}')
  })
  it('createJsonFile multipart', async () => {
    await settle(createJsonFile('details.json', 'p', { a: 1 }))
    const [url, init] = call()
    expect(url).toContain('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/)
    const b = init.body as string
    expect(b).toContain('"parents":["p"]')
    expect(b).toContain('"name":"details.json"')
    expect(b).toContain('"a": 1')
  })
  it('writeJsonFile media update', async () => {
    await settle(writeJsonFile('d', { a: 1 }))
    const [url, init] = call()
    expect(url).toBe('https://www.googleapis.com/upload/drive/v3/files/d?uploadType=media&fields=id%2CmodifiedTime')
    expect(init.method).toBe('PATCH')
    expect(init.headers['Content-Type']).toBe('application/json')
  })
})

type Reply = { status: number; text?: string; headers?: Record<string, string>; progress?: number; error?: boolean }
class FakeXHR {
  static sent: FakeXHR[] = []
  static replies: Reply[] = []
  url = ''; method = ''; reqHeaders: Record<string, string> = {}; body: unknown
  status = 0; responseText = ''; resHeaders: Record<string, string> = {}
  upload: { onprogress?: (e: { loaded: number }) => void } = {}
  onload?: () => void; onerror?: () => void
  open(m: string, u: string) { this.method = m; this.url = u }
  setRequestHeader(k: string, v: string) { this.reqHeaders[k] = v }
  getResponseHeader(k: string) { return this.resHeaders[k] ?? null }
  send(b: unknown) {
    this.body = b; FakeXHR.sent.push(this)
    const r = FakeXHR.replies.shift()!
    Promise.resolve().then(() => {
      if (r.error) return this.onerror?.()
      if (r.progress !== undefined) this.upload.onprogress?.({ loaded: r.progress })
      Object.assign(this, { status: r.status, responseText: r.text ?? '', resHeaders: r.headers ?? {} })
      this.onload?.()
    })
  }
}

describe('uploads', () => {
  const file = new File(['0123456789'], 'a.jpg', { type: 'image/jpeg' })
  const prog = vi.fn()
  beforeEach(() => {
    FakeXHR.sent = []; FakeXHR.replies = []; prog.mockClear()
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
  })
  const reply = (...r: Reply[]) => FakeXHR.replies.push(...r)

  it('startUpload returns session Location', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { Location: 'https://up/s1' } }))
    const r = await settle(startUpload(file, 'item1'))
    expect(r).toEqual({ ok: true, v: 'https://up/s1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=resumable/)
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'X-Upload-Content-Type': 'image/jpeg', 'X-Upload-Content-Length': '10', Authorization: 'Bearer t1' })
    expect(JSON.parse(init.body)).toEqual({ name: 'a.jpg', parents: ['item1'], mimeType: 'image/jpeg' })
  })
  it('startUpload without Location rejects', async () => {
    fetchMock.mockResolvedValueOnce(res(200))
    const r = await settle(startUpload(file, 'item1'))
    expect((r as { e: DriveError }).e).toMatchObject({ reason: 'noLocation' })
  })
  it('shareAnyone posts reader/anyone', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { id: 'p' }))
    await settle(shareAnyone('f1'))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://www.googleapis.com/drive/v3/files/f1/permissions?fields=id')
    expect(init.body).toBe('{"role":"reader","type":"anyone"}')
  })
  it('putUpload fresh with progress', async () => {
    reply({ status: 200, text: '{"id":"f1","name":"a.jpg"}', progress: 5 })
    const r = await settle(putUpload('https://up/s1', file, prog))
    expect(r).toEqual({ ok: true, v: { id: 'f1', name: 'a.jpg' } })
    expect(FakeXHR.sent).toHaveLength(1)
    expect(FakeXHR.sent[0]).toMatchObject({ method: 'PUT', url: 'https://up/s1', reqHeaders: { 'Content-Range': 'bytes 0-9/10' } })
    expect(prog).toHaveBeenCalledWith(5)
  })
  it('resume finds finished upload, sends no bytes', async () => {
    reply({ status: 201, text: '{"id":"f1"}' })
    const r = await settle(putUpload('https://up/s1', file, prog, true))
    expect(r).toEqual({ ok: true, v: { id: 'f1' } })
    expect(FakeXHR.sent).toHaveLength(1)
    expect(FakeXHR.sent[0].reqHeaders['Content-Range']).toBe('bytes */10')
    expect(FakeXHR.sent[0].body).toBeNull()
  })
  it('resume continues from Range', async () => {
    reply({ status: 308, headers: { Range: 'bytes=0-3' } }, { status: 200, text: '{"id":"f1"}', progress: 2 })
    await settle(putUpload('https://up/s1', file, prog, true))
    expect(FakeXHR.sent[1].reqHeaders['Content-Range']).toBe('bytes 4-9/10')
    expect((FakeXHR.sent[1].body as Blob).size).toBe(6)
    expect(prog).toHaveBeenCalledWith(6)
  })
  it('resume without Range restarts at 0', async () => {
    reply({ status: 308 }, { status: 200, text: '{"id":"f1"}' })
    await settle(putUpload('https://up/s1', file, prog, true))
    expect(FakeXHR.sent[1].reqHeaders['Content-Range']).toBe('bytes 0-9/10')
  })
  it('404 rejects with status', async () => {
    reply({ status: 404 })
    const r = await settle(putUpload('https://up/s1', file, prog))
    expect((r as { e: DriveError }).e).toMatchObject({ status: 404 })
  })
  it('network error rejects', async () => {
    reply({ status: 0, error: true })
    const r = await settle(putUpload('https://up/s1', file, prog))
    expect((r as { e: DriveError }).e).toMatchObject({ status: 0, reason: 'network' })
  })
})
