import type { PacsApi } from '../shared/types'

declare global {
  interface Window {
    api: PacsApi
  }
}

export {}
