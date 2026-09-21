/**
 * Control-window lifetime, kept separate from startup orchestration because the window is now
 * optional: with a tray present the connector runs with no window at all, and the window is
 * recreated on demand rather than being the thing that keeps the process alive.
 *
 * Two rules make that safe. Hiding instead of closing only ever happens when a tray really
 * exists, so the app can never end up running with no way to reach it. And a quit always wins:
 * `releaseForQuit` disarms the hide behaviour before teardown asks the window to close.
 */

import { BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { hasTray } from './tray.js';

/** Windows draws its own caption over the renderer; other desktops keep the native frame. */
export const USES_TITLE_BAR_OVERLAY = process.platform === 'win32';
const TITLE_BAR_HEIGHT = 36;

let window: BrowserWindow | null = null;
let quitting = false;
let shouldCloseToTray = false;

export function setCloseToTray(value: boolean): void {
  shouldCloseToTray = value;
}

export function releaseForQuit(): void {
  quitting = true;
}

export function createWindow(show: boolean): BrowserWindow {
  if (window && !window.isDestroyed()) {
    if (show) revealWindow();
    return window;
  }
  const created = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    show: false,
    title: 'localMCP-chat',
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    ...(USES_TITLE_BAR_OVERLAY
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#09090b', symbolColor: '#a1a1aa', height: TITLE_BAR_HEIGHT }
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window = created;

  created.once('ready-to-show', () => {
    if (show) created.show();
  });
  created.on('close', (event) => {
    if (quitting || !shouldCloseToTray || !hasTray()) return;
    event.preventDefault();
    created.hide();
  });
  created.on('closed', () => {
    if (window === created) window = null;
  });
  // A control panel has no business navigating anywhere, and any link it does contain is
  // documentation meant for the user's real browser.
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  created.webContents.on('will-navigate', (event, url) => {
    if (url !== created.webContents.getURL()) event.preventDefault();
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void created.loadURL(devUrl);
  else void created.loadFile(path.join(__dirname, '../renderer/index.html'));
  return created;
}

function revealWindow(): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** Brings the control window to the user, recreating it if it was closed outright. */
export function showWindow(): void {
  if (!window || window.isDestroyed()) {
    createWindow(true);
    return;
  }
  revealWindow();
}

export function closeWindowForQuit(): void {
  releaseForQuit();
  if (window && !window.isDestroyed()) window.destroy();
  window = null;
}

/**
 * Fire-and-forget push to the renderer. Sends are routinely attempted while the window is
 * being torn down — teardown logs, and log lines are broadcast — so a destroyed target is an
 * expected outcome here, not an error.
 */
export function broadcast(channel: string, payload: unknown): void {
  if (!window || window.isDestroyed()) return;
  const contents = window.webContents;
  if (contents.isDestroyed()) return;
  try {
    contents.send(channel, payload);
  } catch {
    // The window went away between the check and the send.
  }
}

export function windowExists(): boolean {
  return window !== null && !window.isDestroyed();
}
