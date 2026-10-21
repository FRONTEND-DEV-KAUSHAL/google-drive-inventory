const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const MAX_ATTEMPTS = 5

export const FOLDER_MIME = 'application/vnd.google-apps.folder'

export type DriveFile = {
  id: string
  name: string
  mimeType?: string
  parents?: string[]
  createdTime?: string
  modifiedTime?: string
  trashed?: boolean
  thumbnailLink?: string
}

export class DriveError extends Error {
  readonly status: number
  readonly reason: string
  constructor(status: number, reason: string, message: string) {
    super(message)
    this.status = status
    this.reason = reason
  }
}

export type TokenSource = { get(): Promise<string>; refresh(): Promise<string> }

let tokens: TokenSource
export function setTokenSource(t: TokenSource): void {
  tokens = t
}

// Deliberately no destructive verb (SAFE-01)
type Method = 'GET' | 'POST' | 'PATCH'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ponytail: no in-flight cap here; bulk callers use the 6-slot pool in catalog.ts
export async function driveFetch<T>(
  path: string,
  opts: {
    method?: Method
    query?: Record<string, string>
    body?: unknown
    upload?: boolean
    raw?: { body: BodyInit; type: string }
    headers?: Record<string, string>
    read?: (res: Response) => T | Promise<T>
  } = {},
): Promise<T> {
  const { method = 'GET', query, body, upload, raw, headers: extra, read } = opts
  const url = (upload ? UPLOAD : API) + path + (query ? '?' + new URLSearchParams(query) : '')
  let token = await tokens.get()
  let refreshed = false

  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (raw) headers['Content-Type'] = raw.type
    else if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (extra) Object.assign(headers, extra)

    let status = 0
    let reason = 'network'
    let message = 'Network error'
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      })
      if (res.ok) return read ? await read(res) : ((res.status === 204 ? undefined : await res.json()) as T)

      if (res.status === 401 && !refreshed) {
        token = await tokens.refresh()
        refreshed = true
        attempt-- // refresh does not consume an attempt
        continue
      }
      const b = await res.json().catch(() => ({}))
      status = res.status
      reason = b.error?.errors?.[0]?.reason ?? ''
      message = b.error?.message ?? res.statusText
      const retryable =
        status === 429 ||
        status >= 500 ||
        (status === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'))
      if (!retryable) throw new DriveError(status, reason, message)
    } catch (e) {
      if (e instanceof DriveError) throw e
      if (!(e instanceof TypeError)) throw e // refresh() failures etc. propagate
    }
    if (attempt + 1 >= MAX_ATTEMPTS) throw new DriveError(status, reason, message)
    await sleep(Math.min(32_000, 1000 * 2 ** attempt) + Math.random() * 1000)
  }
}

export async function listFiles(
  q: string,
  fields = 'files(id,name,mimeType,parents,createdTime,modifiedTime)',
): Promise<DriveFile[]> {
  const out: DriveFile[] = []
  let pageToken: string | undefined
  do {
    const query: Record<string, string> = {
      q: q + ' and trashed=false',
      fields: 'nextPageToken,' + fields,
      pageSize: '1000',
    }
    if (pageToken) query.pageToken = pageToken
    const page = await driveFetch<{ files: DriveFile[]; nextPageToken?: string }>('/files', { query })
    out.push(...page.files)
    pageToken = page.nextPageToken
  } while (pageToken)
  return out
}

export const getFile = (id: string, fields = 'id,name,mimeType,parents,trashed') =>
  driveFetch<DriveFile>(`/files/${id}`, { query: { fields } })

export const createFolder = (name: string, parentId: string) =>
  driveFetch<DriveFile>('/files', {
    method: 'POST',
    query: { fields: 'id,name,mimeType,parents,createdTime' },
    body: { name, mimeType: FOLDER_MIME, parents: [parentId] },
  })

// SAFE-01: the only removal path. Never add a permanent-delete or empty-trash call.
export const trash = (id: string) =>
  driveFetch<DriveFile>(`/files/${id}`, {
    method: 'PATCH',
    query: { fields: 'id,trashed' },
    body: { trashed: true },
  })

export const getStartPageToken = () =>
  driveFetch<{ startPageToken: string }>('/changes/startPageToken').then((r) => r.startPageToken)

export const getContent = <T = unknown>(id: string) => driveFetch<T>(`/files/${id}`, { query: { alt: 'media' } })
export const getBlob = (id: string) => driveFetch<Blob>(`/files/${id}`, { query: { alt: 'media' }, read: (r) => r.blob() })

// Rename and/or move. Parents go in the query (Drive rejects `parents` in an update body).
// Deliberately no `trashed` field: trash() stays the only removal path (SAFE-01).
export const updateFile = (id: string, p: { name?: string; addParents?: string; removeParents?: string }) => {
  const query: Record<string, string> = { fields: 'id,name,parents' }
  if (p.addParents) query.addParents = p.addParents
  if (p.removeParents) query.removeParents = p.removeParents
  return driveFetch<DriveFile>(`/files/${id}`, { method: 'PATCH', query, body: p.name === undefined ? {} : { name: p.name } })
}

const BOUNDARY = 'inventory-boundary-7f3a'
export const createJsonFile = (name: string, parentId: string, data: unknown) =>
  driveFetch<DriveFile>('/files', {
    method: 'POST',
    upload: true,
    query: { uploadType: 'multipart', fields: 'id,name,parents,modifiedTime' },
    raw: {
      type: `multipart/related; boundary=${BOUNDARY}`,
      body: `--${BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parentId], mimeType: 'application/json' })}\r\n--${BOUNDARY}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data, null, 2)}\r\n--${BOUNDARY}--`,
    },
  })

export const writeJsonFile = (id: string, data: unknown) =>
  driveFetch<DriveFile>(`/files/${id}`, {
    method: 'PATCH',
    upload: true,
    query: { uploadType: 'media', fields: 'id,modifiedTime' },
    raw: { type: 'application/json', body: JSON.stringify(data, null, 2) },
  })

// Resumable session init (IMG-01). Same path for every size: progress for all files, and a retry on the
// same session URI can never create a second file (IMG-03).
export const startUpload = (file: File, parentId: string) =>
  driveFetch<string>('/files', {
    method: 'POST',
    upload: true,
    query: { uploadType: 'resumable', fields: 'id,name' },
    headers: { 'X-Upload-Content-Type': file.type, 'X-Upload-Content-Length': String(file.size) },
    body: { name: file.name, parents: [parentId], mimeType: file.type },
    read: (r) => {
      const loc = r.headers.get('Location')
      if (!loc) throw new DriveError(r.status, 'noLocation', 'Upload session URL missing from response')
      return loc
    },
  })

type Put = { status: number; text: string; range: string | null }
// XHR because fetch has no upload progress. The session URI authorises the PUT; no bearer token needed.
function xhrPut(url: string, body: Blob | null, range: string, onProgress?: (n: number) => void): Promise<Put> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('PUT', url)
    x.setRequestHeader('Content-Range', range)
    if (onProgress) x.upload.onprogress = (e) => onProgress(e.loaded)
    x.onload = () => resolve({ status: x.status, text: x.responseText, range: x.getResponseHeader('Range') })
    x.onerror = () => reject(new DriveError(0, 'network', 'Network error during upload'))
    x.send(body)
  })
}
const done = (r: Put) => r.status === 200 || r.status === 201
const putFail = (r: Put) => new DriveError(r.status, 'upload', `Upload failed (${r.status})`)

// ponytail: no auto-retry on the PUT; the user's per-file Retry calls this again with resume=true.
export async function putUpload(session: string, file: Blob, onProgress: (sent: number) => void, resume = false): Promise<DriveFile> {
  let from = 0
  if (resume) {
    const s = await xhrPut(session, null, `bytes */${file.size}`)
    if (done(s)) return JSON.parse(s.text) // earlier attempt actually finished: reuse that file
    if (s.status !== 308) throw putFail(s) // 404/410 = session expired; caller starts a new one
    const m = s.range?.match(/bytes=0-(\d+)/)
    from = m ? Number(m[1]) + 1 : 0
  }
  const r = await xhrPut(session, file.slice(from), `bytes ${from}-${file.size - 1}/${file.size}`, (n) => onProgress(from + n))
  if (done(r)) return JSON.parse(r.text)
  throw putFail(r)
}

// IMG-02: share a single image file. Never call this for folders or details.json.
export const shareAnyone = (id: string) =>
  driveFetch<{ id: string }>(`/files/${id}/permissions`, { method: 'POST', query: { fields: 'id' }, body: { role: 'reader', type: 'anyone' } })
