import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'

interface Thread { thread_id: string; title: string }
interface Message { message_id: string; author_id: string; body: string; posted_at: string }
interface ThreadView { threadId: string; streamVersion: number; messages: Message[] }

const uuid = (): string =>
  (crypto as any).randomUUID ? crypto.randomUUID() : '00000000-0000-7000-8000-' + Date.now().toString(16).padStart(12, '0')

export function Chat() {
  const [threads, setThreads] = useState<Thread[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [view, setView] = useState<ThreadView | null>(null)
  const [draft, setDraft] = useState('')
  const activeRef = useRef<string | null>(null)
  activeRef.current = active

  const loadThreads = useCallback(async () => {
    const t = await api.get<Thread[]>('/projections/threads')
    setThreads(t)
    if (!activeRef.current && t[0]) setActive(t[0].thread_id)
  }, [])

  const loadThread = useCallback(async (id: string) => {
    setView(await api.get<ThreadView>(`/projections/chat?thread=${id}`))
  }, [])

  useEffect(() => { void loadThreads() }, [loadThreads])
  useEffect(() => { if (active) void loadThread(active) }, [active, loadThread])
  useEffect(() => api.sse(() => {
    void loadThreads()
    if (activeRef.current) void loadThread(activeRef.current)
  }), [loadThreads, loadThread])

  const newThread = async () => {
    const title = prompt('Thread title?')?.trim()
    if (!title) return
    const id = uuid()
    await api.post('/events', { type: 'chat.thread.created@1', subjectId: id, streamId: id, streamSeq: 1, payload: { title } })
    await loadThreads(); setActive(id)
  }

  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    const body = draft.trim()
    if (!body || !active) return
    setDraft('')
    const post = async (): Promise<void> => {
      const v = view && view.threadId === active ? view : await api.get<ThreadView>(`/projections/chat?thread=${active}`)
      await api.post('/events', {
        type: 'chat.message.posted@1', subjectId: uuid(), streamId: active,
        streamSeq: v.streamVersion + 1, payload: { body },
      })
    }
    try { await post() }
    catch (err: any) { if (err.status === 409) { await loadThread(active); await post() } else throw err }
    await loadThread(active)
  }

  return (
    <div className="chat">
      <div className="threads">
        <button onClick={() => void newThread()}>+ New thread</button>
        {threads.map((t) => (
          <button key={t.thread_id} className={t.thread_id === active ? 'active' : ''}
            onClick={() => setActive(t.thread_id)}>{t.title}</button>
        ))}
      </div>
      <div>
        <div className="messages">
          {view?.messages.map((m) => (
            <div className="msg" key={m.message_id}>{m.body}</div>
          ))}
          {!view?.messages.length && <div className="msg">No messages yet.</div>}
        </div>
        <form className="composer" onSubmit={send}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message…" disabled={!active} />
          <button type="submit" disabled={!active}>Send</button>
        </form>
      </div>
    </div>
  )
}
