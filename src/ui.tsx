import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, X } from 'lucide-react'

export const Spinner = ({ size = 16 }: { size?: number }) => (
  <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />
)

const errText = (e: unknown) => String((e as Error)?.message ?? e)

// Tiny module store shared by toasts and the dialog host.
function store<T>(init: T) {
  let v = init
  const subs = new Set<() => void>()
  return {
    get: () => v,
    set: (n: T) => {
      v = n
      subs.forEach((f) => f())
    },
    sub: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  }
}

type Toast = { id: number; text: string; kind: 'ok' | 'err' }
const toasts = store<Toast[]>([])
let seq = 0
export function toast(text: string, kind: Toast['kind'] = 'ok') {
  const t = { id: ++seq, text, kind }
  toasts.set([...toasts.get(), t])
  setTimeout(() => toasts.set(toasts.get().filter((x) => x !== t)), kind === 'err' ? 6000 : 3000)
}
export const toastError = (e: unknown) => toast(errText(e), 'err')

function Toasts() {
  const list = useSyncExternalStore(toasts.sub, toasts.get)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'ok' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span>{t.text}</span>
          <button className="icon" aria-label="Dismiss" onClick={() => toasts.set(toasts.get().filter((x) => x !== t))}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

// In-app replacement for prompt/confirm. With `run`, the dialog stays open showing a spinner until
// the Drive call finishes, so the user always sees the action happening; errors show inline.
export type Ask = {
  title: string
  body?: ReactNode
  input?: string // present => text field with this initial value
  placeholder?: string
  confirm: string
  danger?: boolean
  validate?: (v: string) => string | null
  run?: (v: string) => Promise<unknown>
  done?: string // success toast
}
type Open = Ask & { resolve: (v: string | null) => void }
const dialog = store<Open | null>(null)
export const ask = (a: Ask) => new Promise<string | null>((resolve) => dialog.set({ ...a, resolve }))

function DialogHost() {
  const a = useSyncExternalStore(dialog.sub, dialog.get)
  const ref = useRef<HTMLDialogElement>(null)
  const [v, setV] = useState('')
  const [pending, setPending] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!a) return
    setV(a.input ?? '')
    setErr(null)
    setPending(false)
    ref.current?.showModal()
  }, [a])

  if (!a) return null
  const invalid = a.input !== undefined ? a.validate?.(v) ?? (v.trim() ? null : 'Required') : null
  const close = (r: string | null) => {
    ref.current?.close()
    dialog.set(null)
    a.resolve(r)
  }
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (pending || invalid || !a) return
    if (!a.run) return close(v)
    setPending(true)
    setErr(null)
    try {
      await a.run(v.trim())
      if (a.done) toast(a.done)
      close(v)
    } catch (e) {
      setErr(errText(e))
      setPending(false)
    }
  }

  return (
    <dialog ref={ref} className="dialog" onCancel={(e) => (e.preventDefault(), !pending && close(null))}>
      <form onSubmit={submit}>
        <h3>{a.title}</h3>
        {a.body && <div className="dialog-body">{a.body}</div>}
        {a.input !== undefined && (
          <label className="field">
            <input autoFocus value={v} placeholder={a.placeholder} disabled={pending} onChange={(e) => setV(e.target.value)} />
            {v !== (a.input ?? '') && invalid && <small className="error">{invalid}</small>}
          </label>
        )}
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={pending} onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className={a.danger ? 'solid-danger' : 'primary'} disabled={pending || !!invalid} autoFocus={a.input === undefined}>
            {pending && <Spinner />}
            {a.confirm}
          </button>
        </div>
      </form>
    </dialog>
  )
}

export const Overlays = () => (
  <>
    <Toasts />
    <DialogHost />
  </>
)
