import { useReducer, useRef, useState } from 'react'
import type { Image, Item } from './catalog'
import { deleteImage, imageBlobUrl, imageUrl, moveImage, newJobs, runUploads, type UploadJob } from './images'
import { CheckCircle2, ChevronLeft, ChevronRight, ImagePlus, RotateCcw, Trash2 } from 'lucide-react'
import { ask, Spinner } from './ui'

// Public lh3 URL first; on error fall back once to a signed-in Drive download (blob URL), then hide.
// Fades in on load over a shimmer placeholder instead of popping in.
export function Img({ img, purpose }: { img: Image; purpose: 'thumb' | 'view' }) {
  return (
    <img
      loading="lazy"
      decoding="async"
      alt={img.name}
      src={imageUrl(img.id, purpose)}
      onLoad={(e) => e.currentTarget.classList.add('loaded')}
      onError={(e) => {
        const el = e.currentTarget
        if (el.src.startsWith('blob:')) return el.classList.add('failed')
        imageBlobUrl(img.id).then(
          (u) => (el.src = u),
          () => el.classList.add('failed'),
        )
      }}
    />
  )
}

export default function Gallery({ item, disabled = false }: { item: Item; disabled?: boolean }) {
  const jobs = useRef<UploadJob[]>([])
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const run = (p: () => Promise<unknown>) => {
    setBusy(true)
    setErr(null)
    p()
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setBusy(false))
  }
  const upload = () => run(() => runUploads(item.id, jobs.current, bump))
  const add = (fs: FileList | null | undefined) => {
    const imgs = Array.from(fs ?? []).filter((f) => f.type.startsWith('image/'))
    if (!imgs.length || off) return
    jobs.current.push(...newJobs(imgs))
    upload()
  }
  const off = busy || disabled
  const js = jobs.current

  return (
    <section className="gallery-wrap" aria-busy={busy}>
      <label
        className={`dropzone${drag ? ' over' : ''}${off ? ' off' : ''}`}
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          add(e.dataTransfer.files)
        }}
      >
        {busy ? <Spinner size={22} /> : <ImagePlus size={22} />}
        <span>
          <strong>{busy ? 'Working…' : 'Add images'}</strong>
          <small>Drop files here or click to browse</small>
        </span>
        <input
          type="file"
          accept="image/*"
          multiple
          disabled={off}
          onChange={(e) => {
            add(e.currentTarget.files)
            e.currentTarget.value = ''
          }}
        />
      </label>
      {js.length > 0 && (
        <div className="uploads-box">
          <ul className="uploads">
            {js.map((j, i) => (
              <li key={i} className={j.status}>
                <span className="up-name">{j.file.name}</span>
                <progress max={j.file.size} value={j.sent} />
                {j.status === 'error' ? (
                  <span className="error">{j.error}</span>
                ) : j.status === 'done' ? (
                  <CheckCircle2 size={16} className="ok" aria-label="done" />
                ) : (
                  <small>{j.status}</small>
                )}
              </li>
            ))}
          </ul>
          {js.some((j) => j.status === 'error' || (j.status === 'done' && !j.listed)) ? (
            <button className="sm" onClick={upload} disabled={off}>
              <RotateCcw size={14} /> Retry failed
            </button>
          ) : (
            js.every((j) => j.status === 'done' && j.listed) && (
              <button
                className="ghost sm"
                onClick={() => {
                  jobs.current = []
                  bump()
                }}
              >
                Clear
              </button>
            )
          )}
        </div>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      {item.images.length > 0 && (
        <ul className={`gallery${busy ? ' working' : ''}`}>
          {item.images.map((m, i) => (
            <li key={m.id}>
              <a className="media" href={`https://drive.google.com/file/d/${m.id}/view`} target="_blank" rel="noreferrer">
                <Img img={m} purpose="view" />
              </a>
              <div className="actions">
                {i === 0 ? <strong>Primary</strong> : <span className="grow" />}
                <button className="icon" aria-label="Move earlier" disabled={off || i === 0} onClick={() => run(() => moveImage(item.id, m.id, -1))}>
                  <ChevronLeft size={16} />
                </button>
                <button
                  className="icon"
                  aria-label="Move later"
                  disabled={off || i === item.images.length - 1}
                  onClick={() => run(() => moveImage(item.id, m.id, 1))}
                >
                  <ChevronRight size={16} />
                </button>
                <button
                  className="icon danger"
                  aria-label={`Delete ${m.name}`}
                  disabled={off}
                  onClick={() =>
                    ask({
                      title: 'Delete image?',
                      body: `"${m.name}" moves to Drive trash.`,
                      confirm: 'Delete image',
                      danger: true,
                      run: () => deleteImage(item.id, m.id),
                      done: 'Image moved to trash',
                    })
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
