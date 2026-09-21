import { describe, expect, it, vi } from 'vitest';

// autostart.ts imports Electron's `app` at module scope. The escaping under test does not touch
// it, but the import still has to resolve outside an Electron runtime.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: () => undefined
  }
}));

const { __testing, launchedHidden, HIDDEN_FLAG } = await import('./autostart.js');
const { execArgument, desktopEntry } = __testing;

describe('execArgument', () => {
  it('quotes an ordinary path unchanged', () => {
    expect(execArgument('/usr/bin/localmcp-chat')).toBe('"/usr/bin/localmcp-chat"');
  });

  it('needs no escaping for a space, because the argument is already quoted', () => {
    expect(execArgument('/home/a b/app')).toBe('"/home/a b/app"');
  });

  it('doubles a percent sign so it is not read as a field code', () => {
    expect(execArgument('/opt/100%/app')).toBe('"/opt/100%%/app"');
  });

  it('escapes for the Exec parser and again for desktop-entry value unescaping', () => {
    // A single backslash has to survive two passes: the file holds four, the value unescaper
    // turns them into two, and the Exec parser turns those into the one literal backslash.
    expect(execArgument(String.raw`a\b`)).toBe(String.raw`"a\\\\b"`);
    expect(execArgument('a"b')).toBe(String.raw`"a\\"b"`);
    expect(execArgument('a$b')).toBe(String.raw`"a\\$b"`);
    expect(execArgument('a`b')).toBe(String.raw`"a\\`+'`'+String.raw`b"`);
  });

  it('leaves no unescaped reserved character able to end the quoted argument', () => {
    const escaped = execArgument('"; rm -rf ~; echo "');
    const inner = escaped.slice(1, -1);
    // Every quote inside is preceded by a backslash run, so none of them closes the argument.
    expect(inner.includes('\\\\"')).toBe(true);
    expect(/(^|[^\\])"/.test(inner)).toBe(false);
  });
});

describe('desktopEntry', () => {
  it('is a valid autostart entry that does not open a terminal', () => {
    const entry = desktopEntry(false);
    expect(entry.startsWith('[Desktop Entry]\n')).toBe(true);
    expect(entry).toContain('Type=Application');
    expect(entry).toContain('Terminal=false');
    expect(entry).toContain('X-GNOME-Autostart-enabled=true');
    expect(entry.endsWith('\n')).toBe(true);
  });

  it('passes the hidden flag only when a hidden start was asked for', () => {
    expect(desktopEntry(true)).toContain(`"${HIDDEN_FLAG}"`);
    expect(desktopEntry(false)).not.toContain(HIDDEN_FLAG);
  });

  it('quotes the executable so a path with spaces stays one argument', () => {
    const exec = desktopEntry(false).split('\n').find((line) => line.startsWith('Exec='));
    expect(exec).toMatch(/^Exec="/);
  });
});

describe('launchedHidden', () => {
  it('detects the flag anywhere in the command line', () => {
    expect(launchedHidden(['app.exe', '--hidden'])).toBe(true);
    expect(launchedHidden(['app.exe', '--hidden', '--other'])).toBe(true);
  });

  it('is false for an ordinary launch', () => {
    expect(launchedHidden(['app.exe'])).toBe(false);
    // A substring must not count: only the exact flag means a login-item start.
    expect(launchedHidden(['app.exe', '--hidden-thing'])).toBe(false);
  });
});
