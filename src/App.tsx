import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { clientId, envClientId, getAuthState, reconnect, setClientId, signIn, signOut, subscribe } from './auth'
import { chooseInventory, resolveInventory } from './inventory'
import type { DriveFile } from './drive'
import Browse, { ShellSkeleton } from './Browse'
import { AlertTriangle, FolderOpen, LogIn, LogOut, RefreshCw } from 'lucide-react'
import { Spinner, toastError } from './ui'

type Inv = { id: string } | { choices: DriveFile[] } | { error: string } | null
const link = (id: string) => `https://drive.google.com/drive/folders/${id}`

// Google popup can take seconds; show it's in progress. Closing the popup rejects, which clears it.
function AuthButton({ fn, children, className = 'primary' }: { fn: () => Promise<void>; children: React.ReactNode; className?: string }) {
  const [pending, setPending] = useState(false)
  return (
    <button
      className={className}
      disabled={pending}
      onClick={() => {
        setPending(true)
        fn()
          .catch((e) => !/popup_closed/.test(String(e?.message)) && toastError(e))
          .finally(() => setPending(false))
      }}
    >
      {pending ? <Spinner /> : <LogIn size={16} />}
      {pending ? 'Waiting for Google…' : children}
    </button>
  )
}

export default function App() {
  const auth = useSyncExternalStore(subscribe, getAuthState)
  const [inv, setInv] = useState<Inv>(null)
  const prev = useRef(auth)

  const load = useCallback(() => {
    setInv(null)
    resolveInventory().then(setInv, (e) => setInv({ error: String(e?.message ?? e) }))
  }, [])

  const wasIn = prev.current === 'signedIn' || prev.current === 'reconnect'
  useEffect(() => {
    if (auth === 'signedIn' && !wasIn) load()
    if (auth === 'signedOut') setInv(null)
    prev.current = auth
  }, [auth, wasIn, load])

  if (!clientId())
    return (
      <form
        className="splash"
        onSubmit={(e) => {
          e.preventDefault()
          setClientId(String(new FormData(e.currentTarget).get('cid')))
        }}
      >
        <h1>Drive Inventory</h1>
        <p>Paste your Google OAuth Web client ID. It is saved in this browser only.</p>
        <input
          name="cid"
          aria-label="Google OAuth client ID"
          placeholder="1234-abc.apps.googleusercontent.com"
          pattern=".+\.apps\.googleusercontent\.com"
          required
        />
        <button className="primary">Save</button>
      </form>
    )
  if (auth === 'loading')
    return (
      <div className="splash" aria-busy="true">
        <Spinner size={28} />
      </div>
    )
  if (auth === 'signedOut')
    return (
      <div className="splash">
        <h1>Drive Inventory</h1>
        <p>Your inventory, stored in your own Google Drive.</p>
        <AuthButton fn={signIn}>Sign in with Google</AuthButton>
        {!envClientId && (
          <button className="ghost sm" onClick={() => setClientId('')}>
            Change client ID
          </button>
        )}
      </div>
    )

  return (
    <>
      <header className="topbar">
        <h1>Drive Inventory</h1>
        {inv && 'id' in inv && (
          <a className="btn ghost" href={link(inv.id)} target="_blank" rel="noreferrer">
            <FolderOpen size={16} /> Open in Drive
          </a>
        )}
        <button className="ghost" onClick={signOut}>
          <LogOut size={16} /> Sign out
        </button>
      </header>
      {auth === 'reconnect' && (
        <p className="banner">
          Session expired{' '}
          <AuthButton fn={reconnect}>Reconnect</AuthButton>
        </p>
      )}
      {inv === null && <ShellSkeleton status="Finding your Inventory folder…" />}
      {inv && 'id' in inv && <Browse rootId={inv.id} />}
      {inv && 'choices' in inv && (
        <div className="choices">
          <h2>Several Inventory folders found</h2>
          <p>Pick the one to use. You can open each in Drive to check.</p>
          {inv.choices.map((f) => (
            <div key={f.id} className="choice">
              <span>
                <strong>{f.name}</strong>
                <small>Created {f.createdTime ? new Date(f.createdTime).toLocaleString() : '—'}</small>
              </span>
              <a className="btn ghost" href={link(f.id)} target="_blank" rel="noreferrer">
                <FolderOpen size={16} /> Open
              </a>
              <button
                className="primary"
                onClick={() => {
                  chooseInventory(f.id)
                  setInv({ id: f.id })
                }}
              >
                Use this
              </button>
            </div>
          ))}
        </div>
      )}
      {inv && 'error' in inv && (
        <div className="layout">
          <div className="empty" style={{ gridColumn: '1 / -1' }}>
            <AlertTriangle size={28} />
            <h3>Couldn't find your Inventory folder</h3>
            <p>{inv.error}</p>
            <button className="primary" onClick={load}>
              <RefreshCw size={16} /> Try again
            </button>
          </div>
        </div>
      )}
    </>
  )
}
