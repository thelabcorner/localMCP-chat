/**
 * Login-item registration for the two platforms this app supports.
 *
 * The stored preference is a *request*; the operating system holds the truth. A user can remove
 * the entry from Task Manager's Startup tab or delete the XDG autostart file at any time, and
 * nothing tells the app about it. So every read here inspects the real registration and the UI
 * reports that, not the wish. `reconcileAutostart` is what closes the gap on startup: it
 * re-asserts an enabled preference, and when the OS says the entry is gone and we cannot put it
 * back, it clears the preference rather than leaving a checkbox that lies.
 *
 * Registration is refused outside a packaged app. In development `process.execPath` is the
 * Electron binary inside node_modules, and pointing the user's login at it would outlive this
 * checkout being deleted.
 */

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Passed to a login-item launch so startup knows to skip showing the control window. */
export const HIDDEN_FLAG = '--hidden';

export interface AutostartStatus {
  /** Whether this build can register a login item at all. */
  supported: boolean;
  /** True only when the operating system currently holds a registration for us. */
  enabled: boolean;
  /** Set when `supported` is false, or when the last apply failed. */
  detail: string | null;
}

function desktopFile(): string {
  return path.join(os.homedir(), '.config', 'autostart', 'dev.localmcp.chat.desktop');
}

/**
 * The command a login item should run. An AppImage is mounted at a fresh temporary path on
 * every launch, so `process.execPath` inside one names a directory that will not exist next
 * boot; `APPIMAGE` is the stable file the user actually keeps.
 */
function launchTarget(): string {
  const appImage = process.env['APPIMAGE'];
  if (process.platform === 'linux' && appImage) return appImage;
  return process.execPath;
}

export function autostartSupported(): { supported: boolean; detail: string | null } {
  if (!app.isPackaged) {
    return { supported: false, detail: 'Available in the installed app only, not in a development run.' };
  }
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    return { supported: false, detail: `Not supported on ${process.platform}.` };
  }
  return { supported: true, detail: null };
}

function loginItemOptions(hidden: boolean): { path: string; args: string[] } {
  return { path: launchTarget(), args: hidden ? [HIDDEN_FLAG] : [] };
}

/**
 * Escapes one argument for a Desktop Entry Exec line.
 *
 * Two escaping passes apply, and honouring only the first is a well-known way to turn an
 * unusual home directory into a broken login command. The Exec parser wants a backslash before
 * a double quote, a backtick, a dollar sign or a backslash inside a quoted argument, and reads
 * a percent sign as the start of a field code, so a literal one is doubled. On top of that the
 * whole line is a desktop-entry *value*, unescaped before Exec is ever parsed — so every
 * backslash the Exec parser must see has to be doubled again to survive that earlier pass.
 */
function execArgument(value: string): string {
  const quoted = value.replace(/([\\"`$])/g, '\\$1').replace(/%/g, '%%');
  return '"' + quoted.replace(/\\/g, '\\\\') + '"';
}

function desktopEntry(hidden: boolean): string {
  const exec = [launchTarget(), ...(hidden ? [HIDDEN_FLAG] : [])].map(execArgument).join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=localMCP-chat',
    'Comment=Local MCP capability router for ChatGPT',
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n');
}

/** Reads the registration the operating system actually holds, never the stored preference. */
export async function readAutostart(hidden: boolean): Promise<boolean> {
  const support = autostartSupported();
  if (!support.supported) return false;
  try {
    if (process.platform === 'win32') {
      // Windows keys the entry by executable and arguments, so it has to be read back with the
      // same shape it was written with.
      return app.getLoginItemSettings(loginItemOptions(hidden)).openAtLogin;
    }
    await fs.access(desktopFile());
    return true;
  } catch {
    return false;
  }
}

/** Writes or removes the registration. Throws with a reportable message when the OS refuses. */
export async function applyAutostart(enabled: boolean, hidden: boolean): Promise<void> {
  const support = autostartSupported();
  if (!support.supported) {
    if (!enabled) return;
    throw new Error(support.detail ?? 'Launching at login is unavailable in this build.');
  }
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: enabled, ...loginItemOptions(hidden) });
    return;
  }
  const file = desktopFile();
  if (!enabled) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, desktopEntry(hidden), 'utf8');
  await fs.rename(temp, file);
}

/**
 * Brings the operating system in line with the stored preference and reports what is really
 * registered afterwards. `persist` is called only when the preference has to change to stay
 * truthful, so an ordinary startup writes nothing.
 */
export async function reconcileAutostart(
  preference: { launchAtLogin: boolean; startHidden: boolean },
  persist: (launchAtLogin: boolean) => Promise<void>
): Promise<AutostartStatus> {
  const support = autostartSupported();
  if (!support.supported) {
    // Running an installed app's config from a checkout must not keep claiming the login item
    // is on. The stored preference is left alone even so: it is still the user's intent for the
    // installed copy, and clearing it here would silently disable startup for that build.
    return { supported: false, enabled: false, detail: support.detail };
  }
  try {
    const actual = await readAutostart(preference.startHidden);
    if (preference.launchAtLogin === actual) {
      return { supported: true, enabled: actual, detail: null };
    }
    await applyAutostart(preference.launchAtLogin, preference.startHidden);
    const confirmed = await readAutostart(preference.startHidden);
    if (confirmed !== preference.launchAtLogin) {
      await persist(confirmed);
      return {
        supported: true,
        enabled: confirmed,
        detail: 'The operating system rejected the startup entry, so the setting was turned off.'
      };
    }
    return { supported: true, enabled: confirmed, detail: null };
  } catch (error) {
    return {
      supported: true,
      enabled: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

/** True when this process was launched by a login item that asked for a hidden start. */
export function launchedHidden(argv: readonly string[]): boolean {
  return argv.includes(HIDDEN_FLAG);
}

export const __testing = { desktopEntry, execArgument };
