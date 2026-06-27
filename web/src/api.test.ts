import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api.js'
import { installEventSource, mockFetch } from './test-helpers.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('api.get', () => {
  it('sends cookies and returns parsed json', async () => {
    const fetchMock = mockFetch(() => ({ json: { hello: 'world' } }))
    const out = await api.get<{ hello: string }>('/projections/threads')
    expect(out).toEqual({ hello: 'world' })
    expect(fetchMock).toHaveBeenCalledWith('/projections/threads', { credentials: 'include' })
  })

  it('throws an error carrying the status on non-2xx', async () => {
    mockFetch(() => ({ ok: false, status: 401 }))
    await expect(api.get('/auth/me')).rejects.toMatchObject({ status: 401 })
  })
})

describe('api.post', () => {
  it('posts json with credentials and content-type', async () => {
    const fetchMock = mockFetch(() => ({ json: { id: '1', seq: '7' } }))
    const out = await api.post('/events', { type: 'x' })
    expect(out).toEqual({ id: '1', seq: '7' })
    const [, init] = fetchMock.mock.calls[0]!
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'x' }),
    })
  })

  it('surfaces server error message, status, and body on 409', async () => {
    mockFetch(() => ({ ok: false, status: 409, json: { error: 'conflict', currentVersion: 2 } }))
    await expect(api.post('/events', {})).rejects.toMatchObject({
      message: 'conflict',
      status: 409,
      body: { currentVersion: 2 },
    })
  })

  it('falls back to a generic message when the error body is not json', async () => {
    mockFetch(() => ({
      ok: false,
      status: 500,
      json: () => {
        throw new Error('boom')
      },
    }))
    await expect(api.post('/x', {})).rejects.toMatchObject({ message: 'POST /x 500', status: 500 })
  })
})

describe('api.sse', () => {
  it('opens an authenticated stream, forwards append data, and closes on cleanup', () => {
    const ES = installEventSource()
    const seqs: string[] = []
    const close = api.sse((seq) => seqs.push(seq))
    const es = ES.last!
    expect(es.url).toBe('/stream')
    expect(es.withCredentials).toBe(true)
    es.emit('append', '10')
    es.emit('message', 'ignored') // only the 'append' event is wired
    expect(seqs).toEqual(['10'])
    close()
    expect(es.closed).toBe(true)
  })
})
