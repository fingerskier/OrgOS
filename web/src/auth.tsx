import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from './api.js'

export interface Actor { actor_id: string; handle: string; display_name: string; email: string; roles: string[] }
interface Session { actor: Actor | null; loading: boolean; refresh(): Promise<void>; signOut(): Promise<void> }

const Ctx = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [actor, setActor] = useState<Actor | null>(null)
  const [loading, setLoading] = useState(true)
  const refresh = async () => {
    setLoading(true)
    try { const r = await api.get<{ actor: Actor }>('/auth/me'); setActor(r.actor) }
    catch { setActor(null) } finally { setLoading(false) }
  }
  const signOut = async () => { await api.post('/auth/logout', {}); setActor(null) }
  useEffect(() => { void refresh() }, [])
  return <Ctx.Provider value={{ actor, loading, refresh, signOut }}>{children}</Ctx.Provider>
}
export const useSession = (): Session => {
  const c = useContext(Ctx); if (!c) throw new Error('no SessionProvider'); return c
}

export function Login() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState<{ devLink?: string } | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const r = await api.post<{ ok: boolean; devLink?: string }>('/auth/request', { email })
    setSent({ devLink: r.devLink })
  }
  if (sent) return (
    <div className="card">
      <h2>Check your email</h2>
      <p>We sent a sign-in link to <b>{email}</b>.</p>
      {sent.devLink && <p>Dev link: <a href={sent.devLink}>{sent.devLink}</a></p>}
    </div>
  )
  return (
    <form className="card" onSubmit={submit}>
      <h2>Sign in to OrgOS</h2>
      <input type="email" required placeholder="you@example.com" value={email}
        onChange={(e) => setEmail(e.target.value)} />
      <button type="submit">Send magic link</button>
    </form>
  )
}
