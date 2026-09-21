import os from 'node:os';
import path from 'node:path';
import type { ShellType } from '../../../main/codex/shell.js';

const BLOCK_MESSAGE = 'Blocked catastrophic recursive delete: target resolves to a filesystem root or the user-home root. Narrow the target and retry.';

function tokenize(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; current += char; continue; }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (/\s/.test(char)) { if (current) { out.push(current); current = ''; } continue; }
    if (';&|'.includes(char)) { if (current) { out.push(current); current = ''; } out.push(char); continue; }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

function unquote(value: string): string {
  const text = value.trim();
  return text.length >= 2 && ((text[0] === '"' && text.at(-1) === '"') || (text[0] === "'" && text.at(-1) === "'")) ? text.slice(1, -1) : text;
}

function dangerousPath(raw: string, cwd: string): boolean {
  let value = unquote(raw)
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/^\$HOME(?=$|[\\/])/i, os.homedir())
    .replace(/^\$env:USERPROFILE(?=$|[\\/])/i, os.homedir())
    .replace(/^%USERPROFILE%(?=$|[\\/])/i, os.homedir());
  if (!value || /[$%`]/.test(value)) return false;
  value = value.replace(/[*?]+$/, '');
  const flavor = /^[A-Za-z]:[\\/]/.test(cwd) || /^[A-Za-z]:[\\/]/.test(os.homedir()) ? path.win32 : path.posix;
  const resolved = flavor.resolve(cwd, flavor === path.win32 ? value.replaceAll('/', '\\') : value).replaceAll('\\', '/').replace(/\/$/, '');
  const home = flavor.resolve(os.homedir()).replaceAll('\\', '/').replace(/\/$/, '');
  return resolved === '/' || /^[A-Za-z]:$/i.test(resolved) || resolved.toLowerCase() === home.toLowerCase() || (/^[A-Za-z]:[\\/]/.test(os.homedir()) && /^\/[A-Za-z]$/i.test(resolved));
}

/** Narrow YOLO guard: normal development commands are untouched; only obvious root/home recursive deletes are blocked. */
export function catastrophicDeleteReason(command: string, shell: ShellType, cwd: string): string | null {
  const commands = command.split(/(?:&&|\|\||;|\r?\n)/);
  for (const statement of commands) {
    const tokens = tokenize(statement).filter((token) => token !== ';' && token !== '&' && token !== '|');
    if (!tokens.length) continue;
    const name = path.basename(unquote(tokens[0]!).replaceAll('\\', '/')).replace(/\.exe$/i, '').toLowerCase();
    const args = tokens.slice(1);
    let recursiveDelete = false;
    if (shell === 'powershell') {
      recursiveDelete = ['remove-item', 'rm', 'ri', 'del', 'erase', 'rmdir'].includes(name) && args.some((arg) => /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(unquote(arg)));
    } else if (shell === 'cmd') {
      recursiveDelete = ['rd', 'rmdir', 'del', 'erase'].includes(name) && args.some((arg) => /^\/s$/i.test(unquote(arg)));
    } else {
      recursiveDelete = name === 'rm' && args.some((arg) => arg === '--recursive' || /^-[^-]*[rR][^-]*$/.test(arg));
    }
    if (!recursiveDelete) continue;
    const targets = args.filter((arg) => shell === 'cmd' ? !arg.startsWith('/') : !arg.startsWith('-'));
    if (targets.some((target) => dangerousPath(target, cwd))) return BLOCK_MESSAGE;
  }
  return null;
}

