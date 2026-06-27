import { describe, it, expect, vi } from 'vitest'
import { makeCommands, AuthzError } from '../../src/app/commands.js'
import { ValidationError } from '../../src/infra/appender.js'

const fakeAppender = () => ({ append: vi.fn(async () => ({ id: 'id1', seq: '7' })) })

describe('appendEvent command', () => {
  it('validates, appends, and syncs projections', async () => {
    const appender = fakeAppender()
    const sync = vi.fn(async () => {})
    const cmd = makeCommands({ appender: appender as any, syncProjections: sync })
    const r = await cmd.appendEvent({ actorId: 'a1', orgId: 'o1', roles: [] }, {
      type: 'chat.message.posted@1', subjectId: 'm1', streamId: 't1', streamSeq: 2, payload: { body: 'hi' },
    })
    expect(r).toEqual({ id: 'id1', seq: '7' })
    expect(appender.append).toHaveBeenCalledOnce()
    expect(sync).toHaveBeenCalledOnce()
  })
  it('rejects an invalid payload before appending', async () => {
    const appender = fakeAppender()
    const cmd = makeCommands({ appender: appender as any, syncProjections: vi.fn() })
    await expect(cmd.appendEvent({ actorId: 'a1', orgId: 'o1', roles: [] }, {
      type: 'chat.message.posted@1', subjectId: 'm1', streamId: 't1', streamSeq: 2, payload: { body: '' },
    })).rejects.toBeInstanceOf(ValidationError)
    expect(appender.append).not.toHaveBeenCalled()
  })
  it('rejects an unauthorized type without appending', async () => {
    const appender = fakeAppender()
    const cmd = makeCommands({ appender: appender as any, syncProjections: vi.fn() })
    await expect(cmd.appendEvent({ actorId: 'a1', orgId: 'o1', roles: [] }, {
      type: 'identity.role.granted@1', subjectId: 'a1', streamId: 'a1', streamSeq: 1, payload: { role: 'admin' },
    })).rejects.toBeInstanceOf(AuthzError)
    expect(appender.append).not.toHaveBeenCalled()   // authz must gate BEFORE the append
  })
})
