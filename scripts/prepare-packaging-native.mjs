/** Stage only the target architecture's node-pty prebuild for electron-builder. */
import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativePrebuildDir, parseTarget } from './packaging-targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingRoot = path.join(root, 'resources', 'packaging', 'native');

function requirePrebuild(relative) {
  const target = path.join(root, 'node_modules', ...relative.split('/'));
  if (!existsSync(target)) throw new Error(`Required native prebuild is missing: ${relative}`);
  return target;
}

async function main() {
  const { platform, arch } = parseTarget();
  const prebuildDir = nativePrebuildDir(platform, arch);
  if (platform === 'win32') {
    requirePrebuild(`node-pty/prebuilds/win32-${arch}/conpty.node`);
    requirePrebuild(`node-pty/prebuilds/win32-${arch}/conpty_console_list.node`);
    requirePrebuild(`node-pty/prebuilds/win32-${arch}/conpty/OpenConsole.exe`);
  } else {
    requirePrebuild(`node-pty/prebuilds/${prebuildDir}/pty.node`);
  }

  const targetRoot = path.join(stagingRoot, platform, arch);
  const source = path.join(root, 'node_modules', 'node-pty', 'prebuilds', prebuildDir);
  const destination = path.join(targetRoot, 'node_modules', 'node-pty', 'prebuilds', prebuildDir);
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
  process.stdout.write(`${platform}-${arch} node-pty packaging payload staged.\n`);
}

main().catch((error) => {
  process.stderr.write(`\nCould not prepare native packaging dependencies: ${error.message}\n`);
  process.exit(1);
});
