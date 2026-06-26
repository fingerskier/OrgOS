const json = { 'Content-Type': 'application/json' }

export const api = {
  async get<T>(path: string): Promise<T> {
    const r = await fetch(path, { credentials: 'include' })
    if (!r.ok) throw Object.assign(new Error(`GET ${path} ${r.status}`), { status: r.status })
    return r.json() as Promise<T>
  },
  async post<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(path, { method: 'POST', credentials: 'include', headers: json, body: JSON.stringify(body) })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      throw Object.assign(new Error(e.error ?? `POST ${path} ${r.status}`), { status: r.status, body: e })
    }
    return r.json() as Promise<T>
  },
  sse(onSeq: (seq: string) => void): () => void {
    const es = new EventSource('/stream', { withCredentials: true })
    es.addEventListener('append', (ev) => onSeq((ev as MessageEvent).data))
    return () => es.close()
  },
}
