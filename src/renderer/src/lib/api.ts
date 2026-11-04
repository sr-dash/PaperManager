import type { PaperManagerApi } from '../../../preload/index'

declare global {
  interface Window {
    pm: PaperManagerApi
  }
}

export const api: PaperManagerApi = window.pm
