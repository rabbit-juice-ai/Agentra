import type { AgentraApi } from '../shared/api'

declare global {
  interface Window {
    agentra: AgentraApi
  }
}
