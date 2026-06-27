import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import App from './App.js'
import { installEventSource, mockFetch } from './test-helpers.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const actor = {
  actor_id: 'a1',
  handle: 'ada',
  display_name: 'Ada',
  email: 'ada@example.com',
  roles: [],
}

describe('App shell', () => {
  it('shows the sign-in form when no session exists', async () => {
    mockFetch((url) => {
      if (url === '/auth/me') return { ok: false, status: 401 }
      throw new Error(`unexpected ${url}`)
    })
    installEventSource()
    render(<App />)
    await screen.findByText('Sign in to OrgOS')
  })

  it('renders the chat shell with the actor name when authenticated', async () => {
    mockFetch((url) => {
      if (url === '/auth/me') return { json: { actor } }
      if (url === '/projections/threads') return { json: [] }
      if (url.startsWith('/projections/chat')) return { json: { threadId: '', streamVersion: 0, messages: [] } }
      throw new Error(`unexpected ${url}`)
    })
    installEventSource()
    render(<App />)
    await screen.findByText(/Ada/)
    expect(screen.getByText('+ New thread')).toBeTruthy()
  })

  it('returns to the sign-in form after sign out', async () => {
    mockFetch((url) => {
      if (url === '/auth/me') return { json: { actor } }
      if (url === '/projections/threads') return { json: [] }
      if (url.startsWith('/projections/chat')) return { json: { threadId: '', streamVersion: 0, messages: [] } }
      if (url === '/auth/logout') return { json: { ok: true } }
      throw new Error(`unexpected ${url}`)
    })
    installEventSource()
    render(<App />)
    await screen.findByText('Sign out')
    fireEvent.click(screen.getByText('Sign out'))
    await screen.findByText('Sign in to OrgOS')
  })
})
