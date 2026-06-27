import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Chat } from './Chat.js'
import { installEventSource, mockFetch } from './test-helpers.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type Thread = { thread_id: string; title: string }
type Msg = { message_id: string; author_id: string; body: string; posted_at: string }
const msg = (id: string, body: string): Msg => ({ message_id: id, author_id: 'a', body, posted_at: 'now' })

describe('Chat', () => {
  it('lists threads and renders the active thread’s messages', async () => {
    const threads: Thread[] = [{ thread_id: 't1', title: 'General' }]
    const view = { threadId: 't1', streamVersion: 1, messages: [msg('m1', 'hello')] }
    mockFetch((url) => {
      if (url === '/projections/threads') return { json: threads }
      if (url.startsWith('/projections/chat')) return { json: view }
      throw new Error(`unexpected ${url}`)
    })
    installEventSource()

    render(<Chat />)
    await screen.findByText('General')
    await screen.findByText('hello')
  })

  it('creates a thread from the prompt title and selects it', async () => {
    const threads: Thread[] = []
    let view = { threadId: '', streamVersion: 0, messages: [] as Msg[] }
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Roadmap')
    mockFetch((url, init) => {
      if (url === '/projections/threads') return { json: threads }
      if (url.startsWith('/projections/chat')) return { json: view }
      if (url === '/events') {
        const ev = JSON.parse(init!.body as string)
        threads.push({ thread_id: ev.streamId, title: ev.payload.title })
        view = { threadId: ev.streamId, streamVersion: 1, messages: [] }
        return { json: { id: 'e1', seq: '1' } }
      }
      throw new Error(`unexpected ${url}`)
    })
    installEventSource()

    render(<Chat />)
    fireEvent.click(screen.getByText('+ New thread'))
    await screen.findByText('Roadmap')
    expect(promptSpy).toHaveBeenCalled()
  })

  it('sends a message at streamVersion+1 and shows it', async () => {
    const threads: Thread[] = [{ thread_id: 't1', title: 'General' }]
    let messages: Msg[] = []
    let version = 1
    const fetchMock = mockFetch((url, init) => {
      if (url === '/projections/threads') return { json: threads }
      if (url.startsWith('/projections/chat')) return { json: { threadId: 't1', streamVersion: version, messages } }
      if (url === '/events') {
        const ev = JSON.parse(init!.body as string)
        messages = [...messages, msg(ev.subjectId, ev.payload.body)]
        version = ev.streamSeq
        return { json: { id: 'e', seq: String(version) } }
      }
      throw new Error(`unexpected ${url}`)
    })
    installEventSource()

    render(<Chat />)
    await screen.findByText('General')
    fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: 'first post' } })
    fireEvent.click(screen.getByText('Send'))

    await screen.findByText('first post')
    const posted = fetchMock.mock.calls.find(([u]) => u === '/events')
    expect(JSON.parse(posted![1]!.body as string)).toMatchObject({
      type: 'chat.message.posted@1',
      streamId: 't1',
      streamSeq: 2,
      payload: { body: 'first post' },
    })
  })

  it('refetches the active thread when an SSE append arrives', async () => {
    const threads: Thread[] = [{ thread_id: 't1', title: 'General' }]
    let messages: Msg[] = [msg('m1', 'one')]
    const ES = installEventSource()
    mockFetch((url) => {
      if (url === '/projections/threads') return { json: threads }
      if (url.startsWith('/projections/chat')) return { json: { threadId: 't1', streamVersion: messages.length, messages } }
      throw new Error(`unexpected ${url}`)
    })

    render(<Chat />)
    await screen.findByText('one')

    // another client posts; the server pushes an append over the stream
    messages = [...messages, msg('m2', 'two')]
    await act(async () => {
      ES.last!.emit('append', '2')
    })
    await screen.findByText('two')
  })

  it('retries once on a 409 conflict and then succeeds', async () => {
    const threads: Thread[] = [{ thread_id: 't1', title: 'General' }]
    let messages: Msg[] = []
    let version = 1
    let posts = 0
    mockFetch((url, init) => {
      if (url === '/projections/threads') return { json: threads }
      if (url.startsWith('/projections/chat')) return { json: { threadId: 't1', streamVersion: version, messages } }
      if (url === '/events') {
        const ev = JSON.parse(init!.body as string)
        posts++
        if (posts === 1) return { ok: false, status: 409, json: { error: 'conflict', currentVersion: version } }
        messages = [...messages, msg(ev.subjectId, ev.payload.body)]
        version = ev.streamSeq
        return { json: { id: 'e', seq: String(version) } }
      }
      throw new Error(`unexpected ${url}`)
    })
    installEventSource()

    render(<Chat />)
    await screen.findByText('General')
    fireEvent.change(screen.getByPlaceholderText('Message…'), { target: { value: 'retry me' } })
    fireEvent.click(screen.getByText('Send'))

    await screen.findByText('retry me')
    expect(posts).toBe(2)
  })
})
