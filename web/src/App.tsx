import { SessionProvider, useSession, Login } from './auth.js'
import { Chat } from './Chat.js'

function Shell() {
  const { actor, loading, signOut } = useSession()
  if (loading) return <div className="card">Loading…</div>
  if (!actor) return <Login />
  return (
    <div className="app">
      <header><b>OrgOS</b> <span>· {actor.display_name}</span>
        <button onClick={() => void signOut()}>Sign out</button></header>
      <Chat />
    </div>
  )
}
export default function App() { return <SessionProvider><Shell /></SessionProvider> }
