/**
 * The control window's whole channel surface.
 *
 * Reads used to be a 2.5-second poll of one fat snapshot that carried the log with it. That is
 * gone: config, connection and plugin managers all publish changes already, so the renderer is
 * told when something happens and otherwise sits still. Log lines travel on their own channel
 * because they are high-frequency and append-only, and rebuilding the entire panel for each one
 * is what made the old UI lose scroll position and input focus.
 *
 * Nothing here returns a secret value. `hasApiKey` reports presence only, and plugin credential
 * material never enters a snapshot.
 */

import { clipboard, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import type { LogEntry } from '../../shared/types.js';
import type { PluginConfigPatch, PluginInstallRequest } from '../../shared/plugins.js';
import {
  clearLog,
  formatLogAsJson,
  formatLogForClipboard,
  getLog,
  getLogFilePath,
  logWarn,
  onLog
} from '../../main/logger.js';
import { pluginManager } from '../../main/plugins/manager.js';
import { getSecret, secureStorageStatus, setSecret } from '../../main/secrets.js';
import { uniqueRootName, validateNewRoot } from '../../main/sandbox.js';
import { applyAutostart, autostartSupported, readAutostart, type AutostartStatus } from './autostart.js';
import { connect, disconnect, getConnectionStatus, onConnectionStatus } from './connection.js';
import { metricsSnapshot, onMetricsChanged, resetMetrics } from './metrics.js';
import { toolsFor } from './tools/registry.js';
import { getConfig, onConfigChanged, saveConfig, updateConfig, validateConnectorName, type Preferences, type ToolPermissions } from './state.js';
import { hasTray } from './tray.js';
import { broadcast, setCloseToTray, showWindow, USES_TITLE_BAR_OVERLAY } from './window.js';

const channels = [
  'localmcp:get-state', 'localmcp:get-log', 'localmcp:add-root', 'localmcp:remove-root',
  'localmcp:set-connector-name', 'localmcp:set-permissions', 'localmcp:set-tunnel', 'localmcp:set-preferences', 'localmcp:set-api-key',
  'localmcp:connect', 'localmcp:disconnect',
  'localmcp:clear-log', 'localmcp:copy-log', 'localmcp:export-log', 'localmcp:open-log-file',
  'localmcp:reveal-log-file', 'localmcp:open-external', 'localmcp:reveal-root', 'localmcp:reset-metrics',
  'localmcp:plugin-install', 'localmcp:plugin-configure', 'localmcp:plugin-enabled',
  'localmcp:plugin-tool-enabled', 'localmcp:plugin-uninstall', 'localmcp:plugin-authenticate',
  'localmcp:plugin-cancel-auth', 'localmcp:plugin-restart'
] as const;

export const STATE_CHANNEL = 'localmcp:state';
export const LOG_CHANNEL = 'localmcp:log';

/** Coalescing window for pushes. Long enough to batch a burst, short enough to feel live. */
const PUSH_INTERVAL_MS = 80;
const PENDING_LOG_BUDGET_BYTES = 2 * 1024 * 1024;

async function stateSnapshot() {
  const config = getConfig();
  const support = autostartSupported();
  const autostart: AutostartStatus = support.supported
    ? { supported: true, enabled: await readAutostart(config.preferences.startHidden), detail: null }
    : { supported: false, enabled: false, detail: support.detail };
  return {
    config,
    connection: getConnectionStatus(),
    plugins: pluginManager.snapshot(),
    // The live model-facing projection, so the Tools view shows what ChatGPT can actually call
    // rather than a list maintained by hand in the renderer. Schemas are dropped: the panel only
    // needs identity and intent, and they are the bulk of the payload.
    //
    // Call counters are merged in here, and any tool with recorded calls that is no longer
    // published is appended as `withdrawn`. Dropping those would quietly lose the history of a
    // tool that was disabled — often the very thing being investigated.
    tools: mergeToolStats(config),
    hasApiKey: Boolean(await getSecret('openaiApiKey')),
    secureStorage: await secureStorageStatus(),
    metrics: metricsSnapshot(),
    autostart,
    runtime: {
      platform: process.platform,
      tray: hasTray(),
      titleBarOverlay: USES_TITLE_BAR_OVERLAY,
      logFile: getLogFilePath()
    }
  };
}

export type ControlState = Awaited<ReturnType<typeof stateSnapshot>>;

interface ToolRow {
  name: string;
  description: string;
  withdrawn: boolean;
  calls: number;
  failures: number;
  lastAt: number | null;
  avgMs: number | null;
  lastError: string | null;
}

function mergeToolStats(config: ReturnType<typeof getConfig>): ToolRow[] {
  const stats = new Map(metricsSnapshot().tools.map((stat) => [stat.name, stat]));
  const rows: ToolRow[] = toolsFor(config).map((entry) => {
    const stat = stats.get(entry.name);
    stats.delete(entry.name);
    return {
      name: entry.name,
      description: entry.description ?? '',
      withdrawn: false,
      calls: stat?.calls ?? 0,
      failures: stat?.failures ?? 0,
      lastAt: stat?.lastAt ?? null,
      avgMs: stat && stat.calls > 0 ? Math.round(stat.totalDurationMs / stat.calls) : null,
      lastError: stat?.lastError ?? null
    };
  });
  for (const stat of stats.values()) {
    rows.push({
      name: stat.name,
      description: 'Called during this run but not part of the current published surface.',
      withdrawn: true,
      calls: stat.calls,
      failures: stat.failures,
      lastAt: stat.lastAt,
      avgMs: stat.calls > 0 ? Math.round(stat.totalDurationMs / stat.calls) : null,
      lastError: stat.lastError
    });
  }
  return rows;
}

let statePushQueued = false;
let pendingLog: LogEntry[] = [];
let pendingLogBytes = 0;
let logPushTimer: ReturnType<typeof setTimeout> | null = null;

function logEntryBytes(entry: LogEntry): number {
  return 128 + Buffer.byteLength(entry.message, 'utf8');
}

function queueStatePush(): void {
  if (statePushQueued) return;
  statePushQueued = true;
  setTimeout(() => {
    statePushQueued = false;
    // A snapshot reads secure storage, so it is async and can reject; a failed push must not
    // become an unhandled rejection in the main process.
    void stateSnapshot().then(
      (snapshot) => broadcast(STATE_CHANNEL, snapshot),
      () => undefined
    );
  }, PUSH_INTERVAL_MS).unref?.();
}

/**
 * Tool calls can arrive far faster than a panel needs to update, and every snapshot reads secure
 * storage. This is a trailing throttle rather than a coalescing one: at most one push per second,
 * and the final call in a burst always lands within that second.
 */
let metricsPushTimer: ReturnType<typeof setTimeout> | null = null;

function queueMetricsPush(): void {
  if (metricsPushTimer) return;
  metricsPushTimer = setTimeout(() => {
    metricsPushTimer = null;
    queueStatePush();
  }, 1000);
  metricsPushTimer.unref?.();
}

function flushLog(): void {
  logPushTimer = null;
  if (pendingLog.length === 0) return;
  const batch = pendingLog;
  pendingLog = [];
  pendingLogBytes = 0;
  broadcast(LOG_CHANNEL, batch);
}

/**
 * Log listeners run synchronously on the stack of whatever wrote the line, including teardown
 * code. Buffering here rather than sending inline keeps IPC — and a possibly dying window —
 * off that stack entirely.
 */
function queueLogPush(entry: LogEntry): void {
  pendingLog.push(entry);
  pendingLogBytes += logEntryBytes(entry);
  // Bound by actual payload pressure rather than an arbitrary number of log lines.
  while (pendingLogBytes > PENDING_LOG_BUDGET_BYTES && pendingLog.length > 1) {
    const removed = pendingLog.shift();
    if (removed) pendingLogBytes -= logEntryBytes(removed);
  }
  if (logPushTimer) return;
  logPushTimer = setTimeout(flushLog, PUSH_INTERVAL_MS);
  logPushTimer.unref?.();
}

/**
 * Applies a preferences patch and reports the login-item state the operating system ended up
 * in. The preference is only stored once the OS has accepted it, so the checkbox can never
 * show an autostart that does not exist.
 */
async function applyPreferences(patch: Partial<Preferences>): Promise<void> {
  const before = getConfig().preferences;
  const next: Preferences = { ...before, ...patch };

  const registrationChanged = next.launchAtLogin !== before.launchAtLogin || next.startHidden !== before.startHidden;
  if (registrationChanged) {
    // Remove the old registration first when the hidden flag moved, so a stale entry with the
    // previous arguments cannot be left behind on platforms keyed by command line.
    if (before.launchAtLogin && next.startHidden !== before.startHidden) {
      await applyAutostart(false, before.startHidden).catch(() => undefined);
    }
    await applyAutostart(next.launchAtLogin, next.startHidden);
    const confirmed = await readAutostart(next.startHidden);
    if (confirmed !== next.launchAtLogin) {
      throw new Error('The operating system did not accept the startup entry.');
    }
  }

  await updateConfig((draft) => { draft.preferences = next; });
  setCloseToTray(next.closeToTray);
}

export function registerIpc(): () => void {
  ipcMain.handle('localmcp:get-state', stateSnapshot);
  ipcMain.handle('localmcp:get-log', () => getLog());
  ipcMain.handle('localmcp:set-connector-name', async (_event, value: string) => {
    const connectorName = validateConnectorName(value);
    await updateConfig((draft) => { draft.connectorName = connectorName; });
    return stateSnapshot();
  });

  ipcMain.handle('localmcp:add-root', async () => {
    const picked = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Approve a local folder' });
    const selected = picked.filePaths[0];
    if (!selected) return stateSnapshot();
    const current = getConfig();
    const canonical = await validateNewRoot(selected, current.roots);
    if (!current.roots.some((root) => root.path === canonical)) {
      current.roots.push({ name: uniqueRootName(canonical, current.roots), path: canonical });
      await saveConfig(current);
    }
    return stateSnapshot();
  });
  ipcMain.handle('localmcp:remove-root', async (_event, name: string) => {
    await updateConfig((draft) => { draft.roots = draft.roots.filter((root) => root.name !== name); });
    return stateSnapshot();
  });
  ipcMain.handle('localmcp:reveal-root', async (_event, name: string) => {
    // Only ever opens a path the user already approved, resolved from config rather than from
    // whatever the renderer sent.
    const root = getConfig().roots.find((entry) => entry.name === name);
    if (root) shell.showItemInFolder(path.normalize(root.path));
    return stateSnapshot();
  });
  ipcMain.handle('localmcp:set-permissions', async (_event, permissions: Partial<ToolPermissions>) => {
    await updateConfig((draft) => { draft.permissions = { ...draft.permissions, ...permissions }; });
    return stateSnapshot();
  });
  ipcMain.handle('localmcp:set-tunnel', async (_event, patch: { kind?: 'openai' | 'cloudflared' | 'manual'; tunnelId?: string; binaryPath?: string }) => {
    await updateConfig((draft) => {
      if (patch.kind) draft.tunnel.kind = patch.kind;
      if (typeof patch.tunnelId === 'string') draft.tunnel.tunnelId = patch.tunnelId.trim();
      if (typeof patch.binaryPath === 'string') draft.tunnel.binaryPath = patch.binaryPath.trim();
    });
    return stateSnapshot();
  });
  ipcMain.handle('localmcp:set-preferences', async (_event, patch: Partial<Preferences>) => {
    await applyPreferences({
      ...(typeof patch?.launchAtLogin === 'boolean' ? { launchAtLogin: patch.launchAtLogin } : {}),
      ...(typeof patch?.startHidden === 'boolean' ? { startHidden: patch.startHidden } : {}),
      ...(typeof patch?.autoConnect === 'boolean' ? { autoConnect: patch.autoConnect } : {}),
      ...(typeof patch?.closeToTray === 'boolean' ? { closeToTray: patch.closeToTray } : {})
    });
    return stateSnapshot();
  });
  ipcMain.handle('localmcp:set-api-key', async (_event, value: string) => { await setSecret('openaiApiKey', value); return stateSnapshot(); });
  ipcMain.handle('localmcp:connect', async () => { await connect(); return stateSnapshot(); });
  ipcMain.handle('localmcp:disconnect', async () => { await disconnect(); return stateSnapshot(); });

  // The log channel carries appended lines only, so a clear is reported through the reply
  // instead: the caller resets its buffer from the empty ring it gets back.
  ipcMain.handle('localmcp:clear-log', () => { clearLog(); return getLog(); });
  ipcMain.handle('localmcp:copy-log', () => { clipboard.writeText(formatLogForClipboard()); });
  ipcMain.handle('localmcp:export-log', async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const picked = await dialog.showSaveDialog({
      title: 'Export activity log',
      defaultPath: `localmcp-chat-log-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'Text', extensions: ['txt', 'log'] }]
    });
    if (picked.canceled || !picked.filePath) return null;
    const asText = /\.(txt|log)$/i.test(picked.filePath);
    const { promises: fs } = await import('node:fs');
    await fs.writeFile(picked.filePath, asText ? formatLogForClipboard() : formatLogAsJson(), 'utf8');
    return picked.filePath;
  });
  ipcMain.handle('localmcp:open-log-file', async () => {
    const file = getLogFilePath();
    if (!file) return false;
    const failure = await shell.openPath(file);
    if (failure) logWarn(`could not open the log file: ${failure}`);
    return failure === '';
  });
  ipcMain.handle('localmcp:reveal-log-file', () => {
    const file = getLogFilePath();
    if (!file) return false;
    shell.showItemInFolder(file);
    return true;
  });
  ipcMain.handle('localmcp:reset-metrics', () => { resetMetrics(); return stateSnapshot(); });
  ipcMain.handle('localmcp:open-external', async (_event, url: string) => {
    // The renderer can name a destination but not a scheme: anything but https stays here.
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('localmcp:plugin-install', async (_event, request: PluginInstallRequest) => { await pluginManager.install(request); return stateSnapshot(); });
  ipcMain.handle('localmcp:plugin-configure', async (_event, id: string, patch: PluginConfigPatch) => { await pluginManager.configure(id, patch); return stateSnapshot(); });
  ipcMain.handle('localmcp:plugin-enabled', async (_event, id: string, enabled: boolean) => { await pluginManager.setEnabled(id, enabled); return stateSnapshot(); });
  ipcMain.handle('localmcp:plugin-tool-enabled', async (_event, id: string, name: string, enabled: boolean) => { await pluginManager.setToolEnabled(id, name, enabled); return stateSnapshot(); });
  ipcMain.handle('localmcp:plugin-uninstall', async (_event, id: string) => { await pluginManager.uninstall(id); return stateSnapshot(); });
  ipcMain.handle('localmcp:plugin-authenticate', async (_event, id: string) => {
    // Authentication opens a browser window the user has to act in; make sure the control
    // window is in front of them when it comes back.
    showWindow();
    await pluginManager.authenticate(id);
    return stateSnapshot();
  });
  ipcMain.handle('localmcp:plugin-cancel-auth', async (_event, id: string) => { await pluginManager.cancelAuthentication(id); return stateSnapshot(); });
  ipcMain.handle('localmcp:plugin-restart', async (_event, id: string) => { await pluginManager.restart(id); return stateSnapshot(); });

  const unsubscribe = [
    onConfigChanged(() => queueStatePush()),
    onConnectionStatus(() => queueStatePush()),
    pluginManager.onChanged(() => queueStatePush()),
    onLog(queueLogPush),
    onMetricsChanged(queueMetricsPush)
  ];

  return () => {
    for (const stop of unsubscribe) stop();
    if (logPushTimer) clearTimeout(logPushTimer);
    logPushTimer = null;
    if (metricsPushTimer) clearTimeout(metricsPushTimer);
    metricsPushTimer = null;
    pendingLog = [];
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
