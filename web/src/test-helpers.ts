import { vi } from 'vitest'

export interface ResSpec {
  ok?: boolean
  status?: number
  json?: unknown | (() => unknown)
}

/**
 * Stub global `fetch`; `handler` maps each request (url, init) to a response
 * spec. Returns the vi mock so tests can assert call arguments. The fake
 * Response only implements `ok`, `status`, and `json()` — all api.ts touches.
 */
export function mockFetch(handler: (url: string, init: RequestInit | undefined) => ResSpec) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const spec = handler(String(input), init)
    const ok = spec.ok ?? true
    const status = spec.status ?? (ok ? 200 : 400)
    const j = typeof spec.json === 'function' ? (spec.json as () => unknown) : () => spec.json
    return { ok, status, json: async () => j() } as Response
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/**
 * Minimal EventSource stand-in — jsdom ships none. Records the most recent
 * instance so tests can drive `emit(...)` to simulate server-sent events and
 * assert that cleanup closed the stream.
 */
export class FakeEventSource {
  static last: FakeEventSource | null = null
  url: string
  withCredentials: boolean
  closed = false
  private listeners: Record<string, ((ev: { data: string }) => void)[]> = {}
  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url
    this.withCredentials = init?.withCredentials ?? false
    FakeEventSource.last = this
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  emit(type: string, data: string) {
    for (const fn of this.listeners[type] ?? []) fn({ data })
  }
  close() {
    this.closed = true
  }
}

export function installEventSource(): typeof FakeEventSource {
  FakeEventSource.last = null
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
  return FakeEventSource
}
