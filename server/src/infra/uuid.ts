import { uuidv7 } from 'uuidv7'
/** App-side uuid v7: time-sortable identity, federation-safe (per-node). */
export function newId(): string {
  return uuidv7()
}
