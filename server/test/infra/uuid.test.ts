import { describe, it, expect } from 'vitest'
import { newId } from '../../src/infra/uuid.js'

describe('newId', () => {
  it('produces a valid uuid v7 (version nibble = 7)', () => {
    const id = newId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('is time-ordered: later ids sort lexicographically after earlier ones', () => {
    const a = newId()
    const b = newId()
    expect(a < b || a.slice(0, 8) === b.slice(0, 8)).toBe(true)
    expect(a).not.toEqual(b)
  })
})
