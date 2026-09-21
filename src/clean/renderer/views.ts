/**
 * The five configuration views. Each one is built once and then updated in place; none of them
 * ever re-creates their DOM, which is what keeps text selections, open dropdowns and half-typed
 * fields intact while the connection status keeps changing underneath.
 */

import { el, on, reconcile, setAttr, setClass, setText, setValueIfIdle } from './dom.js';
import { api } from './bridge.js';
import type { ControlState, PermissionKey, Plugin, PreferenceKey, ToolRow } from './types.js';
import {
  badge, button, card, connectionTone, countdown, emptyState, facts, field,
  iconButton, relativeTime, stat, stateLabel, toggleRow, type Tone
} from './ui.js';

export interface Ctx {
  /** Runs an action, reporting any failure as a toast rather than an alert box. */
  run(work: () => Promise<unknown>): void;
  toast(message: string, kind?: 'info' | 'error'): void;
  navigate(id: string): void;
}

export interface View {
  node: HTMLElement;
  update(state: ControlState): void;
}

function viewShell(title: string, copy: string, actions: HTMLElement[] = []): { node: HTMLElement; head: HTMLElement } {
  const head = el(
    'div',
    { class: 'view-head' },
    el('div', {}, el('div', { class: 'view-title', text: title }), el('div', { class: 'view-copy', text: copy })),
    actions.length ? el('div', { class: 'item-actions' }, ...actions) : null
  );
  return { node: el('div', { class: 'view scroll' }, head), head };
}

/* ------------------------------------------------------------------ overview */

export function overviewView(ctx: Ctx): View {
  let connected = false;

  const connectButton = button('Connect', { variant: 'primary', iconName: 'power', onClick: () => ctx.run(() => (connected ? api.disconnect() : api.connect())) });
  const shell = viewShell(
    'Overview',
    'One connector, one endpoint. Built-in coding tools and any enabled MCP integrations are published together through it.',
    [connectButton]
  );

  const dot = el('span', { class: 'dot' });
  const stateText = el('div', { class: 'item-title' });
  const detailText = el('div', { class: 'item-meta' });
  const status = card({ title: 'Connection' });
  status.body.appendChild(el('div', { class: 'row' }, dot, el('div', { class: 'item-main' }, stateText, detailText)));

  const publicUrl = el('dd', { class: 'mono selectable' });
  const connectorName = el('dd', { class: 'mono selectable' });
  const localUrl = el('dd', { class: 'mono selectable' });
  const handshake = el('dd', { class: 'selectable' });
  const lastRequest = el('dd', { class: 'selectable' });
  const lastCall = el('dd', { class: 'selectable' });
  status.body.appendChild(
    facts([
      ['Connector', connectorName],
      ['Public URL', publicUrl],
      ['Local URL', localUrl],
      ['Handshake', handshake],
      ['Last request', lastRequest],
      ['Last tool call', lastCall]
    ])
  );

  const statFolders = stat('Approved folders');
  const statTools = stat('Published tools');
  const statPlugins = stat('Integrations ready');
  const statPermissions = stat('Capabilities on');
  const stats = card({ title: 'At a glance', flush: true });
  stats.body.appendChild(el('div', { class: 'stats' }, statFolders.node, statTools.node, statPlugins.node, statPermissions.node));

  const transportSelect = el(
    'select',
    { class: 'select', 'aria-label': 'Transport' },
    el('option', { value: 'openai', text: 'OpenAI Secure MCP Tunnel' }),
    el('option', { value: 'cloudflared', text: 'Cloudflared quick tunnel' }),
    el('option', { value: 'manual', text: 'Manual / local only' })
  );
  on(transportSelect, 'change', () => ctx.run(() => api.setTunnel({ kind: transportSelect.value })));

  const tunnelInput = el('input', { class: 'input mono', placeholder: 'tunnel_…', 'aria-label': 'Tunnel ID' });
  const commitTunnelId = (): void => {
    const value = tunnelInput.value.trim();
    if (value === lastKnownTunnelId) return;
    ctx.run(() => api.setTunnel({ tunnelId: value }));
  };
  on(tunnelInput, 'change', commitTunnelId);
  on(tunnelInput, 'blur', commitTunnelId);
  let lastKnownTunnelId = '';

  const apiKeyInput = el('input', { class: 'input', type: 'password', placeholder: 'sk-…', 'aria-label': 'OpenAI API key' });
  const saveKey = button('Save', {
    onClick: () => {
      const value = apiKeyInput.value.trim();
      if (!value) { ctx.toast('Enter an API key first.', 'error'); return; }
      apiKeyInput.value = '';
      ctx.run(async () => {
        await api.setApiKey(value);
        ctx.toast('API key stored in OS-backed secure storage.');
      });
    }
  });
  on(apiKeyInput, 'keydown', (event) => { if (event.key === 'Enter') saveKey.click(); });

  const tunnelField = field({ label: 'Tunnel ID', control: tunnelInput, hint: 'Format tunnel_ followed by 32 hex characters.' });
  const transport = card({ title: 'Transport', copy: 'How ChatGPT reaches this machine.' });
  transport.body.appendChild(el('div', { class: 'grid-2' }, field({ label: 'Transport', control: transportSelect }), tunnelField));
  transport.body.appendChild(field({
    label: 'OpenAI API key',
    control: el('div', { class: 'row tight' }, apiKeyInput, saveKey),
    hint: 'Stored with OS-backed encryption. OpenAI Files API actions use this same protected credential; ChatGPT-native signed file downloads do not.'
  }));

  const statCalls = stat('Tool calls');
  const statFailed = stat('Failed');
  const statRate = stat('Failure rate');
  const statAvg = stat('Average');
  const usage = card({
    title: 'Tool calls',
    copy: 'Counted for this run of the app, across every reconnect.',
    actions: [button('Reset', { variant: 'ghost', iconName: 'eraser', small: true, onClick: () => ctx.run(() => api.resetMetrics()) })],
    flush: true
  });
  usage.body.appendChild(el('div', { class: 'stats' }, statCalls.node, statFailed.node, statRate.node, statAvg.node));

  shell.node.appendChild(el('div', { class: 'grid-2' }, status.node, stats.node));
  shell.node.appendChild(usage.node);
  shell.node.appendChild(transport.node);

  return {
    node: shell.node,
    update(state) {
      const { connection, config } = state;
      connected = connection.state !== 'disconnected';
      setText(connectButton.querySelector('.label')!, connected ? 'Disconnect' : 'Connect');
      setClass(connectButton, connected ? 'btn default' : 'btn primary');

      setClass(dot, `dot ${connectionTone(connection.state)}`.trim());
      setText(stateText, stateLabel(connection.state));
      const retry = countdown(connection.autoRetryAt);
      setText(detailText, retry ? `${connection.detail} Retrying in ${retry}.` : connection.detail);

      setText(publicUrl, connection.publicUrl ?? '—');
      setText(connectorName, connection.connectorName);
      setText(localUrl, connection.localUrl ?? '—');
      setText(handshake, relativeTime(connection.handshakeAt));
      setText(lastRequest, relativeTime(connection.lastRequestAt));
      setText(lastCall, relativeTime(connection.lastToolCallAt));

      statFolders.set(String(config.roots.length));
      // Withdrawn entries are history, not surface: they must not inflate the published count.
      statTools.set(String(state.tools.filter((tool) => !tool.withdrawn).length));
      statPlugins.set(`${state.plugins.plugins.filter((plugin) => plugin.status === 'ready').length}/${state.plugins.plugins.length}`);
      statPermissions.set(`${Object.values(config.permissions).filter(Boolean).length}/${Object.keys(config.permissions).length}`);

      if (document.activeElement !== transportSelect) transportSelect.value = config.tunnel.kind;
      lastKnownTunnelId = config.tunnel.tunnelId;
      setValueIfIdle(tunnelInput, config.tunnel.tunnelId);
      tunnelField.style.display = config.tunnel.kind === 'openai' ? '' : 'none';
      setAttr(apiKeyInput, 'placeholder', state.hasApiKey ? 'Saved — enter a new key to replace it' : 'sk-…');

      status.setFoot(
        state.secureStorage.available
          ? null
          : `Secure storage unavailable: ${state.secureStorage.detail ?? 'unknown reason'}. Credentials cannot be saved until this is resolved.`
      );

      const metrics = state.metrics;
      statCalls.set(metrics.calls.toLocaleString());
      statFailed.set(metrics.failures.toLocaleString());
      statRate.set(metrics.calls === 0 ? '—' : `${((metrics.failures / metrics.calls) * 100).toFixed(metrics.failures === 0 ? 0 : 1)}%`);
      statAvg.set(metrics.calls === 0 ? '—' : formatDuration(Math.round(metrics.totalDurationMs / metrics.calls)));
      usage.setFoot(
        [
          `${metrics.requests.toLocaleString()} endpoint ${metrics.requests === 1 ? 'request' : 'requests'}`,
          metrics.requestErrors > 0 ? `${metrics.requestErrors} rejected` : null,
          // Almost always a client replaying a tools/list it cached before a capability changed.
          metrics.unknownTools > 0 ? `${metrics.unknownTools} for an unpublished tool` : null,
          metrics.slowestTool ? `slowest ${metrics.slowestTool} at ${formatDuration(metrics.slowestMs)}` : null,
          `counting since ${new Date(metrics.since).toLocaleTimeString()}`
        ]
          .filter(Boolean)
          .join(' · ')
      );
    }
  };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/* --------------------------------------------------------------------- roots */

export function rootsView(ctx: Ctx): View {
  const addButton = button('Add folder', { variant: 'primary', iconName: 'plus', onClick: () => ctx.run(() => api.addRoot()) });
  const shell = viewShell(
    'Approved folders',
    'Filesystem tools resolve every path through these roots and cannot leave them, including by way of a symlink or junction. Shell sessions start here but remain real host shells.',
    [addButton]
  );

  const holder = card({ title: 'Roots', flush: true });
  const list = el('div', { class: 'list' });
  const empty = emptyState({
    title: 'No folders approved',
    copy: 'Coding tools stay unavailable until at least one folder is approved.',
    action: button('Add folder', { variant: 'primary', iconName: 'plus', onClick: () => ctx.run(() => api.addRoot()) })
  });
  holder.body.appendChild(list);
  holder.body.appendChild(empty);
  shell.node.appendChild(holder.node);

  return {
    node: shell.node,
    update(state) {
      const roots = state.config.roots;
      empty.style.display = roots.length === 0 ? '' : 'none';
      list.style.display = roots.length === 0 ? 'none' : '';
      reconcile(
        list,
        roots,
        (root) => root.name,
        (root) =>
          el(
            'div',
            { class: 'item' },
            el(
              'div',
              { class: 'item-main' },
              el('div', { class: 'item-title selectable', text: `/${root.name}` }),
              el('div', { class: 'item-meta mono selectable', text: root.path })
            ),
            el(
              'div',
              { class: 'item-actions' },
              iconButton('external', 'Show in file manager', () => ctx.run(() => api.revealRoot(root.name))),
              iconButton('trash', `Remove /${root.name}`, () => ctx.run(() => api.removeRoot(root.name)))
            )
          )
      );
      holder.setFoot(`${roots.length} of 32 roots approved. The model addresses these by alias only; the native path never crosses the MCP boundary.`);
    }
  };
}

/* --------------------------------------------------------------------- tools */

const PERMISSIONS: Array<{ key: PermissionKey; title: string; copy: string }> = [
  { key: 'read', title: 'Read and search', copy: 'Bounded file inspection, grep, outlines and project discovery.' },
  { key: 'write', title: 'Edit and patch', copy: 'Precise single-file mutation and atomic multi-file patches with rollback.' },
  // FILE_TRANSFER: keep ingress and egress visibly distinct. filesSend is deliberately opt-in.
  { key: 'filesReceive', title: 'Receive files', copy: 'Save ChatGPT and OpenAI files into approved folders. Still requires local Write access.' },
  { key: 'filesSend', title: 'Send files to OpenAI', copy: 'Upload files from approved folders to the OpenAI Files API. This is network egress and still requires local Read access.' },
  { key: 'git', title: 'Git', copy: 'Typed repository modes, with confirmation required for broad writes.' },
  { key: 'shell', title: 'Shell', copy: 'Live PTY sessions and durable background jobs on the host.' },
  { key: 'plugins', title: 'External MCP tools', copy: 'Publish tools from enabled integrations through this connector.' }
];

export function toolsView(ctx: Ctx): View {
  const shell = viewShell(
    'Capabilities',
    'Policy is rechecked at every call, not just when the tool list is built. Turning a capability off withdraws its tools from the published surface.',
    []
  );

  const permissions = card({ title: 'Tool authority', copy: 'What ChatGPT is allowed to ask this machine to do.', flush: true });
  const permissionList = el('div', { class: 'list' });
  const rows = new Map<PermissionKey, ReturnType<typeof toggleRow>>();
  for (const entry of PERMISSIONS) {
    const row = toggleRow({
      title: entry.title,
      copy: entry.copy,
      onChange: (checked) => ctx.run(() => api.setPermissions({ [entry.key]: checked }))
    });
    rows.set(entry.key, row);
    permissionList.appendChild(row.node);
  }
  permissions.body.appendChild(permissionList);

  const surfaceCount = badge('0 tools');
  const surface = card({ title: 'Published surface', copy: 'The exact tool list ChatGPT can currently call.', actions: [surfaceCount], flush: true });
  const surfaceList = el('div', { class: 'list' });
  surface.body.appendChild(surfaceList);

  shell.node.appendChild(permissions.node);
  shell.node.appendChild(surface.node);

  return {
    node: shell.node,
    update(state) {
      for (const [key, row] of rows) row.setState({ checked: state.config.permissions[key] });
      const published = state.tools.filter((tool) => !tool.withdrawn).length;
      setText(surfaceCount, `${published} ${published === 1 ? 'tool' : 'tools'}`);
      reconcile(surfaceList, state.tools, (tool) => tool.name, createToolRow, updateToolRow);
      permissions.setFoot(
        state.config.roots.length === 0
          ? 'No folders are approved, so filesystem, git and shell tools stay withheld regardless of these switches.'
          : null
      );
    }
  };
}

function createToolRow(tool: ToolRow): HTMLElement {
  const node = el(
    'div',
    { class: 'item' },
    el(
      'div',
      { class: 'item-main' },
      el('div', { class: 'row tight' }, el('div', { class: 'item-title mono selectable', text: tool.name }), badge('withdrawn')),
      el('div', { class: 'item-meta' })
    ),
    el(
      'div',
      { class: 'item-actions tool-usage' },
      el('span', { class: 'usage-count' }),
      badge('0 failed', 'danger'),
      el('span', { class: 'item-meta usage-detail' })
    )
  );
  updateToolRow(node, tool);
  return node;
}

function updateToolRow(node: HTMLElement, tool: ToolRow): void {
  const withdrawn = node.querySelector('.badge') as HTMLElement;
  withdrawn.style.display = tool.withdrawn ? '' : 'none';
  setText(node.querySelector('.item-meta')!, firstSentence(tool.description));

  const count = node.querySelector('.usage-count') as HTMLElement;
  setText(count, tool.calls === 0 ? 'never called' : `${tool.calls.toLocaleString()} ${tool.calls === 1 ? 'call' : 'calls'}`);
  setClass(count, tool.calls === 0 ? 'usage-count muted' : 'usage-count');

  const failed = node.querySelectorAll('.badge')[1] as HTMLElement;
  failed.style.display = tool.failures > 0 ? '' : 'none';
  setText(failed, `${tool.failures} failed`);
  // The most recent failure message is the fastest way to see why a tool keeps refusing.
  setAttr(failed, 'title', tool.lastError);

  const detail = node.querySelector('.usage-detail') as HTMLElement;
  setText(
    detail,
    tool.calls === 0
      ? ''
      : [tool.avgMs === null ? null : `avg ${formatDuration(tool.avgMs)}`, relativeTime(tool.lastAt)].filter(Boolean).join(' · ')
  );
}

/** Tool descriptions are written for the model and run long; the panel only needs the gist. */
function firstSentence(description: string): string {
  const trimmed = description.trim();
  if (trimmed === '') return 'No description.';
  const stop = trimmed.search(/\.\s/);
  const sentence = stop === -1 ? trimmed : trimmed.slice(0, stop + 1);
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}

/* --------------------------------------------------------------- integrations */

const PLUGIN_TONES: Record<Plugin['status'], Tone> = {
  ready: 'success',
  connecting: 'warning',
  authenticating: 'warning',
  'needs-auth': 'warning',
  error: 'danger',
  installed: 'neutral',
  disabled: 'neutral'
};

export function pluginsView(ctx: Ctx): View {
  const shell = viewShell(
    'Integrations',
    'External MCP servers and compiled local capabilities, published through one connector. Credentials live in OS-backed secure storage, and conflicting tool names are withheld rather than ambiguously routed.',
    []
  );

  const installed = card({ title: 'Installed', flush: true });
  const list = el('div', { class: 'list' });
  const empty = emptyState({ title: 'No integrations installed', copy: 'Add one from the catalog below, or point at any MCP server you run.' });
  installed.body.appendChild(list);
  installed.body.appendChild(empty);

  const catalogCard = card({ title: 'Catalog', copy: 'Reviewed servers with their license recorded.', flush: true });
  const catalogList = el('div', { class: 'list' });
  catalogCard.body.appendChild(catalogList);

  const kindSelect = el(
    'select',
    { class: 'select', 'aria-label': 'Source kind' },
    ...['npm', 'remote', 'command', 'python', 'github', 'mcpb'].map((kind) => el('option', { value: kind, text: kind }))
  );
  const valueInput = el('input', { class: 'input mono', placeholder: '@scope/server, https://…, or a path', 'aria-label': 'Package, URL, command or path' });
  const installCustom = (): void => {
    const value = valueInput.value.trim();
    if (!value) { ctx.toast('Enter a package, URL, command or path first.', 'error'); return; }
    const kind = kindSelect.value;
    const source: Record<string, unknown> = { kind };
    if (kind === 'remote') source['url'] = value;
    else if (kind === 'command') source['command'] = value;
    else if (kind === 'mcpb') source['path'] = value;
    else source['package'] = value;
    valueInput.value = '';
    ctx.run(() => api.installPlugin({ source }));
  };
  on(valueInput, 'keydown', (event) => { if (event.key === 'Enter') installCustom(); });

  const custom = card({ title: 'Add a custom server', copy: 'Anything the catalog does not cover.' });
  custom.body.appendChild(
    el(
      'div',
      { class: 'row tight' },
      el('div', { class: 'select-holder', style: 'width:130px;flex:none' }, kindSelect),
      valueInput,
      button('Install', { iconName: 'plus', onClick: installCustom })
    )
  );

  shell.node.appendChild(installed.node);
  shell.node.appendChild(catalogCard.node);
  shell.node.appendChild(custom.node);

  function pluginRow(plugin: Plugin): HTMLElement {
    const title = el('div', { class: 'item-title', text: plugin.name });
    const status = badge(plugin.status, PLUGIN_TONES[plugin.status]);
    status.classList.add('status-badge');
    const meta = el('div', { class: 'item-meta' });
    const tools = el('div', { class: 'row wrap tight' });
    const actions = el('div', { class: 'item-actions' });
    const configure = el('div', { class: 'integration-config', hidden: true });
    const node = el(
      'div',
      { class: 'item integration-item' },
      el('div', { class: 'item-main' }, el('div', { class: 'row tight' }, title, status), meta, tools),
      actions,
      configure
    );
    updatePluginRow(node, plugin);
    return node;
  }

  function updatePluginRow(node: HTMLElement, plugin: Plugin): void {
    const title = node.querySelector('.item-title') as HTMLElement;
    const status = node.querySelector('.status-badge') as HTMLElement;
    setText(title, plugin.name);
    setText(status, plugin.status);
    setClass(status, `badge ${PLUGIN_TONES[plugin.status]} status-badge`);

    const published = plugin.tools.filter((tool) => tool.published).length;
    const meta = node.querySelector('.item-meta') as HTMLElement;
    setText(
      meta,
      [
        plugin.version ? `v${plugin.version}` : null,
        `${published}/${plugin.tools.length} tools published`,
        plugin.license || null,
        plugin.error || null
      ]
        .filter(Boolean)
        .join(' · ')
    );
    setClass(meta, plugin.error ? 'item-meta danger' : 'item-meta');

    const toolRow = node.querySelector('.row.wrap') as HTMLElement;
    reconcile(
      toolRow,
      plugin.tools,
      (tool) => tool.name,
      (tool) => {
        const box = el('input', { class: 'checkbox', type: 'checkbox' });
        on(box, 'change', () => ctx.run(() => api.setPluginToolEnabled(plugin.id, tool.name, box.checked)));
        const label = el('label', { class: 'badge' }, box, el('span', { text: tool.name }));
        box.checked = tool.enabled;
        if (tool.exposureError) label.title = tool.exposureError;
        return label;
      },
      (label, tool) => {
        const box = label.firstElementChild as HTMLInputElement;
        if (document.activeElement !== box) box.checked = tool.enabled;
        setAttr(label, 'title', tool.exposureError ?? null);
      }
    );

    const configure = node.querySelector('.integration-config') as HTMLElement;
    const fieldShape = JSON.stringify((plugin.fields ?? []).map(field => [
      field.key,
      field.label,
      !!field.secret,
      !!field.required,
      field.secret ? plugin.credentialKeys.includes(field.key) : false,
      field.control,
      field.defaultValue,
      field.min,
      field.max,
    ]));
    if (configure.dataset['shape'] !== fieldShape) {
      configure.dataset['shape'] = fieldShape;
      configure.replaceChildren();
      const inputs = new Map<string, HTMLInputElement>();
      for (const descriptor of plugin.fields ?? []) {
        const stored = descriptor.secret && plugin.credentialKeys.includes(descriptor.key);
        const isBoolean = descriptor.control === 'boolean' && !descriptor.secret;
        const inputType = descriptor.secret ? 'password' : descriptor.control === 'number' ? 'number' : isBoolean ? 'checkbox' : 'text';
        const input = el('input', {
          class: isBoolean ? 'switch' : 'input mono',
          type: inputType,
          placeholder: stored ? 'Stored securely · enter a new value to replace' : (descriptor.placeholder ?? ''),
          'aria-label': descriptor.label,
          autocomplete: 'off',
          ...(descriptor.control === 'number' && descriptor.min !== undefined ? { min: descriptor.min } : {}),
          ...(descriptor.control === 'number' && descriptor.max !== undefined ? { max: descriptor.max } : {}),
          ...(descriptor.control === 'number' ? { step: 1 } : {}),
        });
        const storedValue = plugin.config[descriptor.key] ?? descriptor.defaultValue ?? '';
        if (isBoolean) input.checked = storedValue.toLowerCase() === 'true';
        else if (!descriptor.secret) input.value = storedValue;
        inputs.set(descriptor.key, input);
        const controls = isBoolean
          ? el(
              'div',
              { class: 'integration-toggle' },
              el('span', { class: 'item-meta', text: descriptor.placeholder ?? '' }),
              input,
            )
          : el('div', { class: 'row tight' }, input);
        if (descriptor.secret && stored) {
          controls.appendChild(button('Clear', {
            small: true,
            onClick: () => ctx.run(async () => {
              await api.configurePlugin(plugin.id, { credentials: { [descriptor.key]: '' } });
              ctx.toast(`${descriptor.label} cleared.`);
            })
          }));
        }
        configure.appendChild(field({
          label: `${descriptor.label}${descriptor.required ? ' · required' : ''}`,
          control: controls,
          hint: isBoolean
            ? undefined
            : descriptor.secret
            ? (stored ? 'Stored with OS-backed encryption. The saved value is never sent to this window.' : 'Stored with OS-backed encryption when saved.')
            : descriptor.placeholder,
        }));
      }
      if ((plugin.fields ?? []).length) {
        configure.appendChild(
          el(
            'div',
            { class: 'integration-config-actions' },
            button('Save & reconnect', {
              variant: 'primary',
              iconName: 'refresh',
              onClick: () => {
                const config: Record<string, string> = {};
                const credentials: Record<string, string> = {};
                for (const descriptor of plugin.fields ?? []) {
                  const control = inputs.get(descriptor.key);
                  const value = descriptor.control === 'boolean' && !descriptor.secret
                    ? String(control?.checked === true)
                    : control?.value.trim() ?? '';
                  if (descriptor.secret) {
                    if (value) credentials[descriptor.key] = value;
                    if (descriptor.required && !value && !plugin.credentialKeys.includes(descriptor.key)) {
                      ctx.toast(`${descriptor.label} is required.`, 'error');
                      return;
                    }
                  } else {
                    if (descriptor.required && !value) {
                      ctx.toast(`${descriptor.label} is required.`, 'error');
                      return;
                    }
                    if (descriptor.control === 'number') {
                      const numeric = Number(value);
                      if (
                        !Number.isInteger(numeric) ||
                        (descriptor.min !== undefined && numeric < descriptor.min) ||
                        (descriptor.max !== undefined && numeric > descriptor.max)
                      ) {
                        const range = descriptor.min !== undefined || descriptor.max !== undefined
                          ? ` from ${descriptor.min ?? '−∞'} to ${descriptor.max ?? '∞'}`
                          : '';
                        ctx.toast(`${descriptor.label} must be an integer${range}.`, 'error');
                        return;
                      }
                    }
                    config[descriptor.key] = value;
                  }
                }
                ctx.run(async () => {
                  await api.configurePlugin(plugin.id, { config, credentials });
                  configure.hidden = true;
                  ctx.toast(`${plugin.name} configuration saved.`);
                });
              }
            }),
            button('Cancel', { small: true, onClick: () => { configure.hidden = true; } })
          )
        );
      }
    } else {
      // Config values are non-sensitive and can stay current while the panel is closed. Never
      // overwrite an input the user is actively editing.
      for (const descriptor of plugin.fields ?? []) {
        if (descriptor.secret) continue;
        const input = configure.querySelector<HTMLInputElement>(`input[aria-label="${CSS.escape(descriptor.label)}"]`);
        if (!input || document.activeElement === input) continue;
        const value = plugin.config[descriptor.key] ?? descriptor.defaultValue ?? '';
        if (descriptor.control === 'boolean') input.checked = value.toLowerCase() === 'true';
        else input.value = value;
      }
    }

    const actions = node.querySelector('.item-actions') as HTMLElement;
    const hasConfig = (plugin.fields?.length ?? 0) > 0;
    const wanted = [
      plugin.status === 'needs-auth' && plugin.source.kind === 'remote' && plugin.source.auth === 'oauth' ? 'auth' : null,
      plugin.status === 'authenticating' ? 'cancel' : null,
      hasConfig ? 'configure' : null,
      'restart',
      'toggle',
      'remove'
    ].filter(Boolean).join(',');
    if (actions.dataset['shape'] === wanted && actions.dataset['enabled'] === String(plugin.enabled)) return;
    actions.dataset['shape'] = wanted;
    actions.dataset['enabled'] = String(plugin.enabled);
    actions.replaceChildren(
      ...(plugin.status === 'needs-auth'
        && plugin.source.kind === 'remote' && plugin.source.auth === 'oauth'
        ? [button('Sign in', { variant: 'primary', iconName: 'key', small: true, onClick: () => ctx.run(() => api.authenticatePlugin(plugin.id)) })]
        : []),
      ...(plugin.status === 'authenticating'
        ? [button('Cancel', { small: true, onClick: () => ctx.run(() => api.cancelPluginAuth(plugin.id)) })]
        : []),
      ...(hasConfig
        ? [button('Configure', {
            variant: plugin.status === 'needs-auth' || plugin.status === 'error' ? 'primary' : undefined,
            iconName: 'settings',
            small: true,
            onClick: () => { configure.hidden = !configure.hidden; }
          })]
        : []),
      iconButton('refresh', 'Restart', () => ctx.run(() => api.restartPlugin(plugin.id))),
      button(plugin.enabled ? 'Disable' : 'Enable', { small: true, onClick: () => ctx.run(() => api.setPluginEnabled(plugin.id, !plugin.enabled)) }),
      iconButton('trash', 'Remove integration and its stored credentials', () => {
        if (!confirm(`Remove ${plugin.name} and any credentials stored for it?`)) return;
        ctx.run(() => api.uninstallPlugin(plugin.id));
      })
    );
  }

  return {
    node: shell.node,
    update(state) {
      const plugins = state.plugins.plugins;
      empty.style.display = plugins.length === 0 ? '' : 'none';
      list.style.display = plugins.length === 0 ? 'none' : '';
      reconcile(list, plugins, (plugin) => plugin.id, pluginRow, updatePluginRow);

      const installedIds = new Set(plugins.map((plugin) => plugin.id));
      const available = state.plugins.catalog.filter((entry) => !installedIds.has(entry.id));
      catalogCard.node.style.display = available.length === 0 ? 'none' : '';
      reconcile(
        catalogList,
        available,
        (entry) => entry.id,
        (entry) =>
          el(
            'div',
            { class: 'item' },
            el(
              'div',
              { class: 'item-main' },
              el('div', { class: 'item-title', text: entry.name }),
              el('div', { class: 'item-meta', text: `${entry.description} · ${entry.license}` })
            ),
            el(
              'div',
              { class: 'item-actions' },
              entry.homepage ? iconButton('external', 'Open homepage', () => void api.openExternal(entry.homepage)) : el('span'),
              button(entry.fields?.length ? 'Set up' : 'Install', {
                small: true,
                variant: entry.fields?.length ? 'primary' : undefined,
                onClick: () => ctx.run(async () => {
                  await api.installPlugin({ catalogId: entry.id });
                  if (entry.fields?.length) ctx.toast(`${entry.name} installed. Open Configure to finish setup.`);
                })
              })
            )
          )
      );

      installed.setFoot(
        state.config.permissions.plugins
          ? null
          : 'Integration tools are turned off under Capabilities, so nothing here is published right now.'
      );
    }
  };
}

/* ------------------------------------------------------------------ settings */

export function settingsView(ctx: Ctx): View {
  const shell = viewShell('Settings', 'Machine identity and startup behavior. Capability authority remains configured separately.', []);

  const connectorInput = el('input', {
    class: 'input mono',
    placeholder: 'localMCP-homelab',
    'aria-label': 'Connector name'
  });
  let lastConnectorName = '';
  const saveConnector = button('Save', {
    onClick: () => {
      const value = connectorInput.value.trim();
      if (!value || value === lastConnectorName) return;
      ctx.run(async () => {
        await api.setConnectorName(value);
        ctx.toast(`Connector identity changed to ${value}.`);
      });
    }
  });
  on(connectorInput, 'keydown', (event) => { if (event.key === 'Enter') saveConnector.click(); });
  const identity = card({
    title: 'Connector identity',
    copy: 'Give each machine a distinct MCP identity, for example localMCP-workstation and localMCP-homelab. A connected instance reconnects when this changes.'
  });
  identity.body.appendChild(field({
    label: 'Connector name',
    control: el('div', { class: 'row tight' }, connectorInput, saveConnector),
    hint: '1-48 characters. Letters, numbers, dot, underscore and hyphen only.'
  }));

  const startup = card({ title: 'Startup', copy: 'Have the connector ready before ChatGPT asks for it.', flush: true });
  const startupList = el('div', { class: 'list' });
  const prefRows = new Map<PreferenceKey, ReturnType<typeof toggleRow>>();

  const definitions: Array<{ key: PreferenceKey; title: string; copy: string }> = [
    { key: 'launchAtLogin', title: 'Start when I sign in', copy: 'Registers a per-user login item for the installed app.' },
    { key: 'startHidden', title: 'Start hidden in the tray', copy: 'Skips the control window at login; open it from the tray icon.' },
    { key: 'autoConnect', title: 'Connect automatically', copy: 'Connects once startup settles, retrying a few times if the network is not up yet.' },
    { key: 'closeToTray', title: 'Keep running when the window is closed', copy: 'Closing the window hides it instead of quitting the connector.' }
  ];
  for (const entry of definitions) {
    const row = toggleRow({
      title: entry.title,
      copy: entry.copy,
      onChange: (checked) => {
        // Turning on start-at-login without close-to-tray gives a connector that quits the
        // moment the window is closed. Flip both, visibly, and say so.
        const alsoTray = entry.key === 'launchAtLogin' && checked && !currentPreferences.closeToTray && trayAvailable;
        ctx.run(async () => {
          await api.setPreferences(alsoTray ? { launchAtLogin: true, closeToTray: true } : { [entry.key]: checked });
          if (alsoTray) ctx.toast('Also keeping localMCP-chat in the tray when the window is closed.');
        });
      }
    });
    prefRows.set(entry.key, row);
    startupList.appendChild(row.node);
  }
  startup.body.appendChild(startupList);

  let currentPreferences: Record<PreferenceKey, boolean> = { launchAtLogin: false, startHidden: false, autoConnect: false, closeToTray: false };
  let trayAvailable = false;

  const diagnostics = card({ title: 'Diagnostics', copy: 'The activity log is mirrored to a bounded file so a run can be read after the app has quit.' });
  const logPath = el('div', { class: 'item-meta mono selectable' });
  diagnostics.body.appendChild(logPath);
  diagnostics.body.appendChild(
    el(
      'div',
      { class: 'row tight' },
      button('Open log file', { iconName: 'external', onClick: () => ctx.run(() => api.openLogFile()) }),
      button('Show in folder', { iconName: 'folder', onClick: () => ctx.run(() => api.revealLogFile()) }),
      button('Export…', { iconName: 'download', onClick: () => ctx.run(async () => {
        const saved = await api.exportLog();
        if (saved) ctx.toast(`Exported to ${saved}`);
      }) })
    )
  );

  shell.node.appendChild(identity.node);
  shell.node.appendChild(startup.node);
  shell.node.appendChild(diagnostics.node);

  return {
    node: shell.node,
    update(state) {
      lastConnectorName = state.config.connectorName;
      setValueIfIdle(connectorInput, state.config.connectorName);
      currentPreferences = state.config.preferences;
      trayAvailable = state.runtime.tray;
      const { autostart } = state;

      // What the operating system actually holds wins over the stored wish. Where it cannot be
      // read at all, the stored preference is shown — it is still the user's intent for the
      // installed copy — but the copy has to say plainly that it is not in effect here, or a
      // checked-and-disabled switch reads as "on".
      const launchRow = prefRows.get('launchAtLogin')!;
      launchRow.setState({ checked: autostart.supported ? autostart.enabled : state.config.preferences.launchAtLogin, disabled: !autostart.supported });
      launchRow.setCopy(
        autostart.supported
          ? autostart.detail ?? 'Registers a per-user login item for the installed app.'
          : state.config.preferences.launchAtLogin
            ? `Saved for the installed app, but not in effect here. ${autostart.detail ?? ''}`.trim()
            : autostart.detail ?? 'Unavailable in this build.'
      );

      const hiddenRow = prefRows.get('startHidden')!;
      hiddenRow.setState({ checked: state.config.preferences.startHidden, disabled: !autostart.enabled || !trayAvailable });
      hiddenRow.setCopy(
        !trayAvailable
          ? 'Needs a tray icon, which this desktop did not provide. The window would have no way to be reopened.'
          : !autostart.enabled
            ? 'Applies to launches at sign-in; turn on "Start when I sign in" first.'
            : 'Skips the control window at login; open it from the tray icon.'
      );

      prefRows.get('autoConnect')!.setState({ checked: state.config.preferences.autoConnect });

      const trayRow = prefRows.get('closeToTray')!;
      trayRow.setState({ checked: state.config.preferences.closeToTray, disabled: !trayAvailable });
      trayRow.setCopy(
        trayAvailable
          ? 'Closing the window hides it instead of quitting the connector.'
          : 'Needs a tray icon, which is not available on this desktop.'
      );

      startup.setFoot(
        state.config.preferences.launchAtLogin && !state.config.preferences.closeToTray
          ? 'localMCP-chat starts at sign-in but quits when you close the window, which stops the connector until the next sign-in.'
          : null
      );

      setText(logPath, state.runtime.logFile ?? 'The log file has not been opened yet.');
    }
  };
}

/* ------------------------------------------------------------------ activity */

export function activityView(pane: HTMLElement): View {
  // The pane is fed by the app's shared log buffer, so there is nothing to update from state.
  return { node: el('div', { class: 'view-fill' }, pane), update() {} };
}
