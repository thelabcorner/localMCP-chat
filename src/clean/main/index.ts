import { app, shell } from 'electron';
import path from 'node:path';
import { initDurableStore } from '../../main/durable.js';
import { getLogFilePath, initLogFile, logError, logInfo, logWarn } from '../../main/logger.js';
import { pluginManager } from '../../main/plugins/manager.js';
import { initSecretsPath, setSecret } from '../../main/secrets.js';
import { backgroundJobs } from './tools/background.js';
import { unifiedExecManager } from './tools/exec.js';
import { launchedHidden, reconcileAutostart } from './autostart.js';
import { beginAutoConnect, connect, disconnect, getConnectionStatus, onConnectionStatus, shutdownConnection } from './connection.js';
import { registerIpc } from './ipc.js';
import { getConfig, initConfig, saveConfig, updateConfig } from './state.js';
import { createTray, destroyTray, hasTray, updateTray } from './tray.js';
import { closeWindowForQuit, createWindow, releaseForQuit, setCloseToTray, showWindow } from './window.js';
import {
  deploymentConfig,
  deploymentPathFromArgv,
  launchedHeadless,
  readDeploymentFile,
  shouldStoreOpenAiKeyFromEnv
} from './deployment.js';

let unregisterIpc: (() => void) | null = null;
let stopStatusMirror: (() => void) | null = null;
let quitting = false;
const deploymentPath = deploymentPathFromArgv(process.argv);
const headless = launchedHeadless(process.argv);
const storeOpenAiKeyFromEnv = shouldStoreOpenAiKeyFromEnv(process.argv);

// Electron still initializes Chromium even when no BrowserWindow is created. Ask Chromium for its
// headless platform before app.ready so a Linux service does not require DISPLAY/Wayland merely to
// host an HTTP server and tunnel child process.
if (headless && process.platform === 'linux') {
  app.commandLine.appendSwitch('headless');
  app.commandLine.appendSwitch('disable-gpu');
}

/**
 * One process owns the tunnel, the durable job store and the login item. A login item plus a
 * desktop shortcut makes a double launch ordinary rather than exotic, and a second process
 * would fight the first for all three. The loser hands its arguments to the winner and exits
 * without running teardown, since it never started anything to tear down.
 */
const isPrimaryInstance = app.requestSingleInstanceLock();

async function initialize(): Promise<void> {
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    throw new Error(`Unsupported platform ${process.platform}; localMCP-chat supports Windows and Linux only.`);
  }
  const userData = app.getPath('userData');
  initLogFile(path.join(userData, 'localmcp-chat.log'));
  initSecretsPath(userData);
  initDurableStore(userData);
  const config = await initConfig(userData);

  if (deploymentPath || storeOpenAiKeyFromEnv) {
    // Validate the complete declarative config first. No persisted state is touched until every
    // field/root/tunnel invariant has passed.
    const pendingConfig = deploymentPath ? await deploymentConfig(await readDeploymentFile(deploymentPath)) : null;
    if (storeOpenAiKeyFromEnv) {
      const value = process.env['LOCALMCP_OPENAI_API_KEY']?.trim();
      if (!value) throw new Error('--store-openai-key-from-env requires LOCALMCP_OPENAI_API_KEY in this process environment.');
      await setSecret('openaiApiKey', value);
      // Minimize the lifetime of plaintext in this process once DPAPI-backed storage commits.
      delete process.env['LOCALMCP_OPENAI_API_KEY'];
      logInfo('OpenAI API key stored in OS-backed secure storage');
    }
    if (pendingConfig) {
      const applied = await saveConfig(pendingConfig);
      logInfo(`deployment applied for connector ${applied.connectorName} with ${applied.roots.length} approved root(s)`);
    }
    // Deployment/credential import are one-shot configuration commands. Do not start plugins,
    // windows or tunnels. This makes them safe building blocks for an unattended installer.
    app.exit(0);
    return;
  }

  await backgroundJobs.initialize(userData);
  await pluginManager.initialize(userData);
  if (!headless) unregisterIpc = registerIpc();

  if (!headless) {
    createTray({
      show: () => showWindow(),
      connect: () => void connect(),
      disconnect: () => void disconnect(),
      openLogFile: () => {
        const file = getLogFilePath();
        if (file) void shell.openPath(file);
      },
      quit: () => app.quit()
    });
    setCloseToTray(config.preferences.closeToTray);
  }

  const status = getConnectionStatus();
  if (!headless) {
    updateTray(status.state, status.detail, status.connectorName);
    stopStatusMirror = onConnectionStatus((next) => updateTray(next.state, next.detail, next.connectorName));
  }

  // A hidden start is only honoured when there is a tray to reach the app through. Without one
  // the window is the entire user interface, and starting with no way to open it would look
  // exactly like the app failing to launch.
  const hidden = !headless && hasTray() && launchedHidden(process.argv) && config.preferences.startHidden;
  if (!headless) createWindow(!hidden);
  if (hidden) logInfo('started hidden at login; the control window is available from the tray');

  logInfo(`localMCP-chat initialized${headless ? ` headless as ${config.connectorName}` : ''}`);

  if (headless) {
    await connect();
    const connected = getConnectionStatus();
    if (connected.state === 'disconnected' || connected.state === 'auth-failed' || connected.state === 'tunnel-unavailable') {
      throw new Error(`Headless connector could not start: ${connected.detail}`);
    }
    return;
  }

  // Deliberately after the window exists, so the log of what happens next has somewhere to go.
  const autostart = await reconcileAutostart(config.preferences, async (launchAtLogin) => {
    await updateConfig((draft) => { draft.preferences.launchAtLogin = launchAtLogin; });
  });
  if (autostart.detail && config.preferences.launchAtLogin) logWarn(`launch at login: ${autostart.detail}`);

  beginAutoConnect();
}

async function shutdown(): Promise<void> {
  if (quitting) return;
  quitting = true;
  releaseForQuit();
  stopStatusMirror?.();
  stopStatusMirror = null;
  unregisterIpc?.();
  unregisterIpc = null;
  await Promise.allSettled([
    shutdownConnection(),
    pluginManager.close(),
    backgroundJobs.close(),
    unifiedExecManager.terminateAllProcesses()
  ]);
  destroyTray();
  closeWindowForQuit();
}

if (!isPrimaryInstance) {
  // exit rather than quit: `before-quit` teardown must not run against services this process
  // never initialized.
  if (deploymentPath || storeOpenAiKeyFromEnv) {
    console.error('localMCP-chat is already running. Stop the existing instance before applying deployment/credential changes.');
  }
  app.exit(deploymentPath || storeOpenAiKeyFromEnv ? 2 : 0);
} else {
  app.on('second-instance', () => {
    // Someone launched the app again — a shortcut, or the installer's "run now". Whatever they
    // wanted, the answer is the window they already have.
    if (!headless) showWindow();
    else logWarn('second launch ignored because this instance is running headless');
  });

  app.whenReady().then(initialize).catch((error) => {
    logError(`startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    app.exit(1);
  });

  app.on('activate', () => { if (!headless) showWindow(); });

  app.on('window-all-closed', () => {
    // With a tray and close-to-tray on, the window hides instead of closing, so reaching here
    // means the user really did close the last window.
    if (quitting) return;
    if (headless) return;
    if (getConfig().preferences.closeToTray && hasTray()) return;
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    void shutdown().finally(() => app.quit());
  });

  // systemd and ordinary terminal supervisors stop services with SIGTERM/SIGINT. Route both
  // through the same owned-process teardown as a desktop Quit action.
  process.once('SIGTERM', () => app.quit());
  process.once('SIGINT', () => app.quit());
}
