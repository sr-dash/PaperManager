import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  CHANNELS,
  EVENT_PREFIX,
  INVOKE_PREFIX,
  type IpcContract,
  type IpcEvents
} from '../shared/ipc'

/** Every contract method, forwarded as-is; the types come from IpcContract. */
type Api = {
  [K in keyof IpcContract]: (...args: IpcContract[K]['args']) => Promise<IpcContract[K]['result']>
}

const calls = {} as Api
for (const name of CHANNELS) {
  ;(calls as Record<string, unknown>)[name] = (...args: unknown[]) =>
    ipcRenderer.invoke(INVOKE_PREFIX + name, ...args)
}

const api = {
  ...calls,

  /** Absolute path of a dropped file (File.path no longer exists in sandboxed renderers). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  on<K extends keyof IpcEvents>(event: K, callback: (payload: IpcEvents[K]) => void): () => void {
    const listener = (_e: IpcRendererEvent, payload: IpcEvents[K]) => callback(payload)
    ipcRenderer.on(EVENT_PREFIX + event, listener)
    return () => ipcRenderer.removeListener(EVENT_PREFIX + event, listener)
  }
}

export type PaperManagerApi = typeof api

// Only this typed surface is exposed; the renderer gets no raw ipcRenderer or Node access.
contextBridge.exposeInMainWorld('pm', api)
