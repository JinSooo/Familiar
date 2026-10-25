import type { FamiliarAPI } from '../shared'
declare global {
  interface Window {
    familiar: FamiliarAPI
  }
}
