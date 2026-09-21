/** Composable pieces every view is built from, so the dense scale stays consistent. */

import { el, icon, on } from './dom.js';
import type { ConnectionState } from './types.js';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger';

export interface Card {
  node: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  setFoot(text: string | null): void;
}

export function card(spec: { title: string; copy?: string; actions?: HTMLElement[]; flush?: boolean }): Card {
  const body = el('div', { class: spec.flush ? 'card-body flush' : 'card-body' });
  const foot = el('div', { class: 'card-foot' });
  foot.style.display = 'none';
  const node = el(
    'section',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('div', {}, el('div', { class: 'card-title', text: spec.title }), spec.copy ? el('div', { class: 'card-copy', text: spec.copy }) : null),
      spec.actions?.length ? el('div', { class: 'item-actions' }, ...spec.actions) : null
    ),
    body,
    foot
  );
  return {
    node,
    body,
    foot,
    setFoot(text) {
      foot.style.display = text ? '' : 'none';
      if (text) foot.textContent = text;
    }
  };
}

export function button(
  label: string,
  spec: { variant?: 'default' | 'primary' | 'ghost' | 'danger'; iconName?: string; onClick?: () => void; title?: string; small?: boolean } = {}
): HTMLButtonElement {
  const node = el(
    'button',
    { class: `btn ${spec.variant ?? 'default'}${spec.small ? ' sm' : ''}`, type: 'button', ...(spec.title ? { title: spec.title } : {}) },
    spec.iconName ? icon(spec.iconName, spec.small ? 12 : 14) : null,
    label ? el('span', { class: 'label', text: label }) : null
  );
  if (!label) node.classList.add('icon');
  if (spec.onClick) on(node, 'click', spec.onClick);
  return node;
}

export function iconButton(iconName: string, title: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', { class: 'btn ghost icon', type: 'button', title, 'aria-label': title }, icon(iconName, 14));
  on(node, 'click', onClick);
  return node;
}

export function badge(text: string, tone: Tone = 'neutral'): HTMLElement {
  return el('span', { class: tone === 'neutral' ? 'badge' : `badge ${tone}`, text });
}

export function field(spec: { label: string; control: HTMLElement; hint?: string }): HTMLElement {
  return el(
    'label',
    { class: 'field' },
    el('span', { class: 'field-label', text: spec.label }),
    spec.control,
    spec.hint ? el('span', { class: 'field-hint', text: spec.hint }) : null
  );
}

export interface ToggleRow {
  node: HTMLElement;
  input: HTMLInputElement;
  setCopy(text: string): void;
  setState(spec: { checked: boolean; disabled?: boolean }): void;
}

export function toggleRow(spec: { title: string; copy: string; onChange: (checked: boolean) => void }): ToggleRow {
  const input = el('input', { class: 'switch', type: 'checkbox', 'aria-label': spec.title });
  const copy = el('div', { class: 'item-meta', text: spec.copy });
  on(input, 'change', () => spec.onChange(input.checked));
  const node = el(
    'label',
    { class: 'item' },
    el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: spec.title }), copy),
    input
  );
  return {
    node,
    input,
    setCopy(text) { if (copy.textContent !== text) copy.textContent = text; },
    setState({ checked, disabled }) {
      // Never move a control the user is mid-interaction with.
      if (document.activeElement !== input && input.checked !== checked) input.checked = checked;
      else if (document.activeElement !== input) input.checked = checked;
      input.disabled = disabled === true;
    }
  };
}

export function emptyState(spec: { title: string; copy: string; action?: HTMLElement }): HTMLElement {
  return el(
    'div',
    { class: 'empty' },
    el('div', { class: 'empty-title', text: spec.title }),
    el('div', { text: spec.copy }),
    spec.action ? el('div', { class: 'row', role: 'group' }, el('div', { class: 'spacer' }), spec.action, el('div', { class: 'spacer' })) : null
  );
}

export function facts(pairs: Array<[string, HTMLElement | string]>): HTMLElement {
  const list = el('dl', { class: 'facts' });
  for (const [term, value] of pairs) {
    list.appendChild(el('dt', { text: term }));
    list.appendChild(typeof value === 'string' ? el('dd', { class: 'selectable', text: value }) : value);
  }
  return list;
}

export function stat(label: string): { node: HTMLElement; set(value: string): void } {
  const value = el('div', { class: 'stat-value', text: '—' });
  return {
    node: el('div', { class: 'stat' }, value, el('div', { class: 'stat-label', text: label })),
    set(next) { if (value.textContent !== next) value.textContent = next; }
  };
}

/* ---------------------------------------------------------------- formatting */

/** Maps a connection state onto the three visual tones the whole app uses for it. */
export function connectionTone(state: ConnectionState): 'connected' | 'pending' | 'error' | '' {
  switch (state) {
    case 'connected': return 'connected';
    case 'starting-server':
    case 'connecting-tunnel': return 'pending';
    case 'offline':
    case 'auth-failed':
    case 'tunnel-unavailable': return 'error';
    default: return '';
  }
}

export function stateLabel(state: ConnectionState): string {
  switch (state) {
    case 'connected': return 'Connected';
    case 'starting-server': return 'Starting server';
    case 'connecting-tunnel': return 'Connecting';
    case 'offline': return 'Offline';
    case 'auth-failed': return 'Auth failed';
    case 'tunnel-unavailable': return 'Tunnel unavailable';
    default: return 'Disconnected';
  }
}

export function relativeTime(value: number | null): string {
  if (!value) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function countdown(value: number | null): string | null {
  if (!value) return null;
  const seconds = Math.max(0, Math.round((value - Date.now()) / 1000));
  return seconds <= 0 ? 'now' : `${seconds}s`;
}
