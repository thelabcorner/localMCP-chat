/**
 * The control window shell: title bar, navigation, the console drawer and the command menu.
 *
 * State arrives two ways and both are push-based. `onState` delivers a full snapshot whenever
 * config, connection or plugin state changes in the main process, and `onLogEntries` delivers
 * appended log lines. Nothing here polls. The one interval is a one-second tick that re-renders
 * the active view so relative times ("2m ago") and the retry countdown stay honest — it reads
 * the snapshot already in hand and never touches IPC.
 */

import { el, icon, on, setAttr, setClass, setText } from './dom.js';
import { createLogPane } from './log-pane.js';
import { LOG_CAPACITY, mergeLog } from './log-store.js';
import { api } from './bridge.js';
import { type ControlState, type LogEntry } from './types.js';
import { button, connectionTone, iconButton, stateLabel } from './ui.js';
import { activityView, overviewView, pluginsView, rootsView, settingsView, toolsView, type Ctx, type View } from './views.js';

type ViewId = 'overview' | 'roots' | 'tools' | 'plugins' | 'activity' | 'settings';

interface NavEntry { id: ViewId; label: string; iconName: string; count?: (state: ControlState) => number }

const NAV: NavEntry[] = [
  { id: 'overview', label: 'Overview', iconName: 'gauge' },
  { id: 'roots', label: 'Folders', iconName: 'folder', count: (state) => state.config.roots.length },
  { id: 'tools', label: 'Capabilities', iconName: 'shield', count: (state) => state.tools.filter((tool) => !tool.withdrawn).length },
  { id: 'plugins', label: 'Integrations', iconName: 'puzzle', count: (state) => state.plugins.plugins.length },
  { id: 'activity', label: 'Activity', iconName: 'activity' },
  { id: 'settings', label: 'Settings', iconName: 'settings' }
];

const DRAWER_MIN_PX = 90;
const DRAWER_DEFAULT_PX = 190;
const STORAGE_HEIGHT = 'localmcp.console.height';
const STORAGE_COLLAPSED = 'localmcp.console.collapsed';

/** `navigator.windowControlsOverlay` is not in the DOM lib this project compiles against. */
interface WindowControlsOverlay {
  visible: boolean;
  getTitlebarAreaRect(): DOMRect;
  addEventListener(type: 'geometrychange', listener: () => void): void;
}

export function mount(root: HTMLElement): void {
  let state: ControlState | null = null;
  let logEntries: LogEntry[] = [];
  let active: ViewId = 'overview';

  /* ------------------------------------------------------------- feedback */

  const toasts = el('div', { class: 'toasts' });

  function toast(message: string, kind: 'info' | 'error' = 'info'): void {
    const node = el(
      'div',
      { class: kind === 'error' ? 'toast error' : 'toast', role: 'status' },
      icon(kind === 'error' ? 'alert' : 'check', 14),
      el('div', { class: 'toast-text', text: message })
    );
    toasts.appendChild(node);
    setTimeout(() => node.remove(), kind === 'error' ? 9000 : 4500);
  }

  function run(work: () => Promise<unknown>): void {
    void work().then(
      (result) => {
        // Handlers reply with a fresh snapshot. Applying it here makes the click feel immediate
        // instead of waiting for the push that is also on its way.
        if (result && typeof result === 'object' && 'config' in result && 'connection' in result) {
          applyState(result as ControlState);
        }
      },
      (error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error')
    );
  }

  const ctx: Ctx = { run, toast, navigate: (id) => navigate(id as ViewId) };

  /* --------------------------------------------------------------- console */

  const drawerToggle = el(
    'button',
    { class: 'console-toggle', type: 'button', 'aria-expanded': 'true' },
    el('span', { class: 'chev' }, icon('chevron', 12)),
    'Console'
  );
  const drawerPane = createLogPane({ leading: drawerToggle, actions: logActions(), compact: true });
  const resizeHandle = el('div', { class: 'console-resize', role: 'separator', 'aria-label': 'Resize console' });
  const console_ = el('div', { class: 'console' }, resizeHandle, drawerPane.node);

  let drawerHeight = readNumber(STORAGE_HEIGHT, DRAWER_DEFAULT_PX);
  let collapsedByUser = localStorage.getItem(STORAGE_COLLAPSED) === '1';

  function logActions(): HTMLElement[] {
    return [
      iconButton('copy', 'Copy the whole log', () => run(async () => { await api.copyLog(); toast('Log copied to the clipboard.'); })),
      iconButton('download', 'Export the log', () => run(async () => {
        const saved = await api.exportLog();
        if (saved) toast(`Exported to ${saved}`);
      })),
      iconButton('eraser', 'Clear the panel (the log file is kept)', () => run(async () => {
        logEntries = await api.clearLog();
        publishLog();
      }))
    ];
  }

  function applyDrawer(): void {
    // The Activity view is the same log at full height; showing it twice is just noise.
    const collapsed = collapsedByUser || active === 'activity';
    console_.classList.toggle('collapsed', collapsed);
    console_.style.height = collapsed ? '' : `${drawerHeight}px`;
    resizeHandle.style.display = collapsed ? 'none' : '';
    setAttr(drawerToggle, 'aria-expanded', collapsed ? 'false' : 'true');
    drawerPane.setVisible(!collapsed);
    activityPane.setVisible(active === 'activity');
  }

  on(drawerToggle, 'click', () => {
    if (active === 'activity') { navigate('overview'); return; }
    collapsedByUser = !collapsedByUser;
    localStorage.setItem(STORAGE_COLLAPSED, collapsedByUser ? '1' : '0');
    applyDrawer();
  });

  on(resizeHandle, 'pointerdown', (event) => {
    event.preventDefault();
    resizeHandle.setPointerCapture(event.pointerId);
    resizeHandle.classList.add('dragging');
    const startY = event.clientY;
    const startHeight = drawerHeight;
    const maxHeight = Math.max(DRAWER_MIN_PX, window.innerHeight - 200);

    const move = (moveEvent: PointerEvent): void => {
      drawerHeight = Math.min(maxHeight, Math.max(DRAWER_MIN_PX, startHeight - (moveEvent.clientY - startY)));
      console_.style.height = `${drawerHeight}px`;
    };
    const up = (): void => {
      resizeHandle.classList.remove('dragging');
      resizeHandle.releasePointerCapture(event.pointerId);
      resizeHandle.removeEventListener('pointermove', move);
      resizeHandle.removeEventListener('pointerup', up);
      resizeHandle.removeEventListener('pointercancel', up);
      localStorage.setItem(STORAGE_HEIGHT, String(Math.round(drawerHeight)));
    };
    resizeHandle.addEventListener('pointermove', move);
    resizeHandle.addEventListener('pointerup', up);
    resizeHandle.addEventListener('pointercancel', up);
  });

  /* ----------------------------------------------------------------- views */

  const activityPane = createLogPane({ actions: logActions() });
  const views: Record<ViewId, View> = {
    overview: overviewView(ctx),
    roots: rootsView(ctx),
    tools: toolsView(ctx),
    plugins: pluginsView(ctx),
    activity: activityView(activityPane.node),
    settings: settingsView(ctx)
  };

  const main = el('main', { class: 'main' });
  for (const view of Object.values(views)) {
    view.node.style.display = 'none';
    main.appendChild(view.node);
  }

  /* --------------------------------------------------------------- chrome */

  const navButtons = new Map<ViewId, { node: HTMLButtonElement; count: HTMLElement }>();
  const nav = el('nav', { class: 'nav', 'aria-label': 'Sections' });
  NAV.forEach((entry, index) => {
    const count = el('span', { class: 'count' });
    count.style.display = 'none';
    const node = el(
      'button',
      { class: 'nav-item', type: 'button' },
      icon(entry.iconName, 14),
      el('span', { class: 'label', text: entry.label }),
      count,
      el('span', { class: 'kbd', text: String(index + 1) })
    );
    on(node, 'click', () => navigate(entry.id));
    navButtons.set(entry.id, { node, count });
    nav.appendChild(node);
  });

  const sidebar = el(
    'aside',
    { class: 'sidebar' },
    el('div', { class: 'nav-label label', text: 'Control' }),
    nav,
    el(
      'div',
      { class: 'sidebar-foot' },
      button('Command menu', { variant: 'ghost', iconName: 'search', onClick: () => openCommands() })
    )
  );

  const statusDot = el('span', { class: 'dot' });
  const statusLabel = el('span', { class: 'label', text: 'Starting…' });
  const statusPill = el('div', { class: 'status-pill', role: 'status' }, statusDot, statusLabel);
  const brandTitle = el('div', { class: 'title', text: 'localMCP-chat' });
  const titlebar = el(
    'header',
    { class: 'titlebar' },
    el('div', { class: 'brand' }, el('div', { class: 'mark', text: 'LM' }), brandTitle),
    el('div', { class: 'drag-filler' }),
    statusPill
  );

  root.replaceChildren(el('div', { class: 'app' }, titlebar, el('div', { class: 'body' }, sidebar, main), console_), toasts);

  reserveCaptionArea(titlebar);

  /* ------------------------------------------------------------ navigation */

  function navigate(id: ViewId): void {
    active = id;
    for (const [viewId, view] of Object.entries(views) as Array<[ViewId, View]>) {
      view.node.style.display = viewId === id ? '' : 'none';
    }
    for (const [viewId, entry] of navButtons) setAttr(entry.node, 'aria-current', viewId === id ? 'page' : null);
    applyDrawer();
    if (state) views[id].update(state);
  }

  /* ---------------------------------------------------------------- state */

  function applyState(next: ControlState): void {
    state = next;
    views[active].update(next);

    setClass(statusDot, `dot ${connectionTone(next.connection.state)}`.trim());
    setText(brandTitle, next.config.connectorName === 'localMCP-chat' ? 'localMCP-chat' : `localMCP-chat · ${next.config.connectorName}`);
    // The detail already opens with the state in most cases ("Connected. ChatGPT reached…"), so
    // prefixing the label as well just reads as a stutter. The dot carries the state visually and
    // the tooltip carries the full sentence when the pill has to clip it.
    setText(statusLabel, next.connection.detail);
    setAttr(statusPill, 'title', `${stateLabel(next.connection.state)} — ${next.connection.detail}`);

    for (const entry of NAV) {
      const target = navButtons.get(entry.id);
      if (!target || !entry.count) continue;
      const value = entry.count(next);
      target.count.style.display = value > 0 ? '' : 'none';
      setText(target.count, String(value));
    }
  }

  function publishLog(): void {
    drawerPane.setEntries(logEntries);
    activityPane.setEntries(logEntries);
  }

  /* ------------------------------------------------------- command menu */

  let commandOverlay: HTMLElement | null = null;

  function commands(): Array<{ label: string; hint?: string; run: () => void }> {
    const connected = state ? state.connection.state !== 'disconnected' : false;
    return [
      ...NAV.map((entry) => ({ label: `Go to ${entry.label}`, hint: 'View', run: () => navigate(entry.id) })),
      connected
        ? { label: 'Disconnect', hint: 'Connection', run: () => run(() => api.disconnect()) }
        : { label: 'Connect', hint: 'Connection', run: () => run(() => api.connect()) },
      { label: 'Add approved folder…', hint: 'Folders', run: () => run(() => api.addRoot()) },
      { label: 'Toggle console drawer', hint: 'Console', run: () => drawerToggle.click() },
      { label: 'Copy activity log', hint: 'Log', run: () => run(async () => { await api.copyLog(); toast('Log copied to the clipboard.'); }) },
      { label: 'Export activity log…', hint: 'Log', run: () => run(async () => { const saved = await api.exportLog(); if (saved) toast(`Exported to ${saved}`); }) },
      { label: 'Clear log panel', hint: 'Log', run: () => run(async () => { logEntries = await api.clearLog(); publishLog(); }) },
      { label: 'Open log file', hint: 'Log', run: () => run(() => api.openLogFile()) }
    ];
  }

  function openCommands(): void {
    if (commandOverlay) return;
    const all = commands();
    let matches = all;
    let index = 0;

    const input = el('input', { class: 'command-input', placeholder: 'Type a command…', 'aria-label': 'Command menu' });
    const list = el('div', { class: 'command-list scroll', role: 'listbox' });

    const paint = (): void => {
      list.replaceChildren(
        ...matches.map((command, position) => {
          const item = el(
            'button',
            { class: 'command-item', type: 'button', role: 'option', 'data-active': position === index ? 'true' : 'false' },
            icon('play', 12),
            el('span', { text: command.label }),
            command.hint ? el('span', { class: 'hint', text: command.hint }) : null
          );
          on(item, 'click', () => { close(); command.run(); });
          on(item, 'mousemove', () => { if (index === position) return; index = position; paint(); });
          return item;
        })
      );
      if (matches.length === 0) list.replaceChildren(el('div', { class: 'log-empty', text: 'No matching command.' }));
    };

    const close = (): void => {
      commandOverlay?.remove();
      commandOverlay = null;
    };

    on(input, 'input', () => {
      const needle = input.value.trim().toLowerCase();
      matches = needle === '' ? all : all.filter((command) => command.label.toLowerCase().includes(needle));
      index = 0;
      paint();
    });
    on(input, 'keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); index = Math.min(matches.length - 1, index + 1); paint(); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); index = Math.max(0, index - 1); paint(); return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        const chosen = matches[index];
        if (!chosen) return;
        close();
        chosen.run();
      }
    });

    const panel = el('div', { class: 'command', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command menu' }, input, list);
    commandOverlay = el('div', { class: 'overlay' }, panel);
    on(commandOverlay, 'pointerdown', (event) => { if (event.target === commandOverlay) close(); });
    document.body.appendChild(commandOverlay);
    paint();
    input.focus();
  }

  /* ------------------------------------------------------------ shortcuts */

  on(document.body, 'keydown', (event) => {
    const accel = event.ctrlKey || event.metaKey;
    if (accel && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommands(); return; }
    if (commandOverlay) return;
    if (accel && event.key === '`') { event.preventDefault(); drawerToggle.click(); return; }
    if (accel && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      if (active === 'activity') activityPane.focusSearch();
      else { if (collapsedByUser) drawerToggle.click(); drawerPane.focusSearch(); }
      return;
    }
    if (accel && /^[1-6]$/.test(event.key)) {
      const entry = NAV[Number(event.key) - 1];
      if (entry) { event.preventDefault(); navigate(entry.id); }
    }
  });

  /* ------------------------------------------------------------ bootstrap */

  navigate('overview');
  applyDrawer();

  // Subscribe before the first read. A line emitted between the two would otherwise be lost;
  // sequence numbers let `mergeLog` fold the overlap back together without duplicates.
  api.onState((next) => applyState(next));
  api.onLogEntries((entries) => {
    logEntries = mergeLog(logEntries, entries, LOG_CAPACITY);
    publishLog();
  });

  void api
    .getState()
    .then(applyState)
    .catch((error: unknown) => toast(`Could not read the current state: ${String(error)}`, 'error'));
  void api
    .getLog()
    .then((entries) => {
      logEntries = mergeLog(entries, logEntries, LOG_CAPACITY);
      publishLog();
    })
    .catch(() => undefined);

  // Relative timestamps and the auto-connect countdown age between pushes.
  setInterval(() => { if (state) views[active].update(state); }, 1000);
}

function readNumber(key: string, fallback: number): number {
  const raw = Number(localStorage.getItem(key));
  return Number.isFinite(raw) && raw >= DRAWER_MIN_PX ? raw : fallback;
}

/**
 * On Windows the caption buttons are drawn over the top-right of the renderer. Reserve exactly
 * the space the platform reports, and re-reserve it when the window is maximised or the DPI
 * changes, so the status pill never ends up underneath the close button.
 */
function reserveCaptionArea(titlebar: HTMLElement): void {
  const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay;
  if (!overlay) return;
  const apply = (): void => {
    if (!overlay.visible) { titlebar.style.paddingRight = ''; return; }
    const rect = overlay.getTitlebarAreaRect();
    titlebar.style.paddingRight = `${Math.max(0, Math.round(window.innerWidth - rect.right) + 8)}px`;
  };
  overlay.addEventListener('geometrychange', apply);
  window.addEventListener('resize', apply);
  apply();
}
