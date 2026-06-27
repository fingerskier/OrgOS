import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// globals:false, so RTL's auto-cleanup is not installed — unmount manually
// between tests to keep the jsdom document and React trees isolated.
afterEach(cleanup)
