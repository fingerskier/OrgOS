import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Login, SessionProvider, useSession, type Actor } from './auth.js'
import { mockFetch } from './test-helpers.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const ada: Actor = {
  actor_id: 'a1',
  handle: 'ada',
  display_name: 'Ada',
  email: 'ada@example.com',
  roles: [],
}

function Probe() {
  const { actor, loading, signOut } = useSession()
  return (
    <div>
      <span data-testid="state">{loading ? 'loading' : actor ? `hi ${actor.display_name}` : 'anon'}</span>
      <button onClick={() => void signOut()}>out</button>
    </div>
  )
}

describe('SessionProvider', () => {
  it('resolves the current actor from /auth/me on mount', async () => {
    mockFetch((url) => {
      if (url === '/auth/me') return { json: { actor: ada } }
      throw new Error(`unexpected ${url}`)
    })
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    )
    expect(screen.getByTestId('state').textContent).toBe('loading')
    await screen.findByText('hi Ada')
  })

  it('falls back to anonymous when /auth/me is unauthorized', async () => {
    mockFetch((url) => {
      if (url === '/auth/me') return { ok: false, status: 401 }
      throw new Error(`unexpected ${url}`)
    })
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    )
    await screen.findByText('anon')
  })

  it('clears the actor on signOut and posts /auth/logout', async () => {
    const fetchMock = mockFetch((url) => {
      if (url === '/auth/me') return { json: { actor: ada } }
      if (url === '/auth/logout') return { json: { ok: true } }
      throw new Error(`unexpected ${url}`)
    })
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    )
    await screen.findByText('hi Ada')
    fireEvent.click(screen.getByText('out'))
    await screen.findByText('anon')
    expect(fetchMock.mock.calls.some(([url]) => url === '/auth/logout')).toBe(true)
  })
})

describe('useSession', () => {
  it('throws when used outside a SessionProvider', () => {
    expect(() => render(<Probe />)).toThrow(/no SessionProvider/)
  })
})

describe('Login', () => {
  it('requests a magic link and shows the dev link returned in dev mode', async () => {
    const link = 'http://localhost:5173/auth/callback?token=abc'
    const fetchMock = mockFetch((url) => {
      if (url === '/auth/request') return { json: { ok: true, devLink: link } }
      throw new Error(`unexpected ${url}`)
    })
    render(<Login />)
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'ada@example.com' } })
    fireEvent.click(screen.getByText('Send magic link'))

    await screen.findByText('Check your email')
    expect(screen.getByText(/token=abc/)).toBeTruthy()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/auth/request')
    expect(JSON.parse(init!.body as string)).toEqual({ email: 'ada@example.com' })
  })
})
