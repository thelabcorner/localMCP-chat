/**
 * The only bridge between the control window and the main process.
 *
 * Every method is a fixed channel with no caller-supplied channel name, and the two push
 * subscriptions hand the renderer the payload only — never the Electron event object, which
 * carries a live `sender` the renderer has no business holding.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('localMcp', {
  getState: () => ipcRenderer.invoke('localmcp:get-state'),
  getLog: () => ipcRenderer.invoke('localmcp:get-log'),
  setConnectorName: (value: string) => ipcRenderer.invoke('localmcp:set-connector-name', value),

  addRoot: () => ipcRenderer.invoke('localmcp:add-root'),
  removeRoot: (name: string) => ipcRenderer.invoke('localmcp:remove-root', name),
  revealRoot: (name: string) => ipcRenderer.invoke('localmcp:reveal-root', name),
  setPermissions: (patch: Record<string, boolean>) => ipcRenderer.invoke('localmcp:set-permissions', patch),
  setTunnel: (patch: Record<string, string>) => ipcRenderer.invoke('localmcp:set-tunnel', patch),
  setPreferences: (patch: Record<string, boolean>) => ipcRenderer.invoke('localmcp:set-preferences', patch),
  setApiKey: (value: string) => ipcRenderer.invoke('localmcp:set-api-key', value),
  connect: () => ipcRenderer.invoke('localmcp:connect'),
  disconnect: () => ipcRenderer.invoke('localmcp:disconnect'),

  clearLog: () => ipcRenderer.invoke('localmcp:clear-log'),
  copyLog: () => ipcRenderer.invoke('localmcp:copy-log'),
  exportLog: () => ipcRenderer.invoke('localmcp:export-log'),
  openLogFile: () => ipcRenderer.invoke('localmcp:open-log-file'),
  revealLogFile: () => ipcRenderer.invoke('localmcp:reveal-log-file'),
  openExternal: (url: string) => ipcRenderer.invoke('localmcp:open-external', url),
  resetMetrics: () => ipcRenderer.invoke('localmcp:reset-metrics'),

  installPlugin: (request: unknown) => ipcRenderer.invoke('localmcp:plugin-install', request),
  configurePlugin: (id: string, patch: unknown) => ipcRenderer.invoke('localmcp:plugin-configure', id, patch),
  setPluginEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('localmcp:plugin-enabled', id, enabled),
  setPluginToolEnabled: (id: string, name: string, enabled: boolean) => ipcRenderer.invoke('localmcp:plugin-tool-enabled', id, name, enabled),
  uninstallPlugin: (id: string) => ipcRenderer.invoke('localmcp:plugin-uninstall', id),
  authenticatePlugin: (id: string) => ipcRenderer.invoke('localmcp:plugin-authenticate', id),
  cancelPluginAuth: (id: string) => ipcRenderer.invoke('localmcp:plugin-cancel-auth', id),
  restartPlugin: (id: string) => ipcRenderer.invoke('localmcp:plugin-restart', id),

  onState: (listener: (payload: unknown) => void) => subscribe('localmcp:state', listener),
  onLogEntries: (listener: (payload: unknown) => void) => subscribe('localmcp:log', listener)
});
