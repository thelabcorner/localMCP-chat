import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { RIPGREP, TUNNEL_CLIENT } from './packaging-versions.mjs';
import { normalizeArch, normalizePlatform, PLATFORM_INFO } from './packaging-targets.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const releaseDir = path.join(repository, 'release');

function argValue(name, fallback) {
  const direct = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const targetPlatform = normalizePlatform(argValue('platform', process.platform));
const targetArch = normalizeArch(argValue('arch', process.arch));

function packageRootCandidates() {
  if (targetPlatform === 'win32') {
    return targetArch === 'x64'
      ? [path.join(releaseDir, 'win-unpacked'), path.join(releaseDir, 'win-x64-unpacked')]
      : [path.join(releaseDir, 'win-arm64-unpacked')];
  }
  return targetArch === 'x64'
    ? [path.join(releaseDir, 'linux-unpacked'), path.join(releaseDir, 'linux-x64-unpacked')]
    : [path.join(releaseDir, 'linux-arm64-unpacked')];
}

const explicitRoot = argValue('root', null);
const packageRoot = explicitRoot ? path.resolve(explicitRoot) : packageRootCandidates().find((candidate) => existsSync(candidate));
if (!packageRoot) throw new Error(`Could not find unpacked ${targetPlatform}-${targetArch} package under ${releaseDir}`);

const sourcePackage = JSON.parse(readFileSync(path.join(repository, 'package.json'), 'utf8'));
const expectedVersion = sourcePackage.version;
const expectedElectronVersion = sourcePackage.devDependencies?.electron;
if (!/^\d+\.\d+\.\d+$/.test(expectedElectronVersion ?? '')) {
  throw new Error(`Electron must be pinned to an exact release version, got ${JSON.stringify(expectedElectronVersion)}`);
}

const suffix = PLATFORM_INFO[targetPlatform].executableSuffix;
const tunnelTarget = TUNNEL_CLIENT.targets[targetPlatform][targetArch];
const upstreamOs = PLATFORM_INFO[targetPlatform].upstreamOs;
const tunnelLicenseStem = `tunnel-client-${TUNNEL_CLIENT.version}-${upstreamOs}-${tunnelTarget.upstreamArch}`;
const nativeDir = `${targetPlatform}-${targetArch}`;
const resourcesDir = path.join(packageRoot, 'resources');
const appExecutable = path.join(packageRoot, targetPlatform === 'win32' ? 'localMCP-chat.exe' : 'localMCP-chat');
const sourceCompilerLibDir = path.join(repository, 'node_modules', 'typescript-compiler', 'lib');
const packagedCompilerLibDir = path.join(resourcesDir, 'typescript-compiler-lib');

function required(relative) {
  const target = path.join(resourcesDir, ...relative.split('/'));
  if (!statSync(target).isFile()) throw new Error(`Packaged runtime is missing ${relative}`);
  return target;
}

function requiredPackageFile(relative) {
  const target = path.join(packageRoot, ...relative.split('/'));
  if (!statSync(target).isFile()) throw new Error(`Packaged application is missing ${relative}`);
  return target;
}

requiredPackageFile('LICENSE.electron.txt');
requiredPackageFile('LICENSES.chromium.html');
for (const relative of [
  'app.asar',
  'LICENSE',
  'THIRD-PARTY-NOTICES.txt',
  `tunnel/tunnel-client${suffix}`,
  `tunnel/cloudflared${suffix}`,
  'tunnel/VERSION',
  'tunnel/LICENSE',
  'tunnel/NOTICE',
  `tunnel/${tunnelLicenseStem}-licenses.txt`,
  `tunnel/${tunnelLicenseStem}.spdx.json`,
  `rg/rg${suffix}`,
  'rg/VERSION',
  'rg/COPYING',
  'rg/LICENSE-MIT',
  'rg/UNLICENSE',
  'app.asar.unpacked/node_modules/node-pty/LICENSE'
]) required(relative);

const sourceCompilerLibs = readdirSync(sourceCompilerLibDir)
  .filter((name) => /^lib\..*\.d\.ts$/.test(name))
  .sort();
const packagedCompilerLibs = readdirSync(packagedCompilerLibDir)
  .filter((name) => /^lib\..*\.d\.ts$/.test(name))
  .sort();
if (sourceCompilerLibs.length === 0 || sourceCompilerLibs.join('\n') !== packagedCompilerLibs.join('\n')) {
  throw new Error(
    `Packaged TypeScript standard library is incomplete: expected ${sourceCompilerLibs.length} files, ` +
    `found ${packagedCompilerLibs.length}`
  );
}
for (const name of ['lib.d.ts', 'lib.es5.d.ts', 'lib.dom.d.ts', 'lib.esnext.full.d.ts']) {
  required(`typescript-compiler-lib/${name}`);
}

if (targetPlatform === 'win32') {
  required(`app.asar.unpacked/node_modules/node-pty/prebuilds/${nativeDir}/conpty.node`);
  required(`app.asar.unpacked/node_modules/node-pty/prebuilds/${nativeDir}/conpty_console_list.node`);
  required(`app.asar.unpacked/node_modules/node-pty/prebuilds/${nativeDir}/conpty/OpenConsole.exe`);
} else {
  required(`app.asar.unpacked/node_modules/node-pty/prebuilds/${nativeDir}/pty.node`);
}

const tunnelVersion = readFileSync(path.join(resourcesDir, 'tunnel', 'VERSION'), 'utf8').trim();
const rgVersion = readFileSync(path.join(resourcesDir, 'rg', 'VERSION'), 'utf8').trim();
if (tunnelVersion !== TUNNEL_CLIENT.version) throw new Error(`Packaged tunnel-client ${tunnelVersion} != ${TUNNEL_CLIENT.version}`);
if (rgVersion !== RIPGREP.version) throw new Error(`Packaged ripgrep ${rgVersion} != ${RIPGREP.version}`);

const prebuilds = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds');
const prebuildDirectories = readdirSync(prebuilds, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (prebuildDirectories.length !== 1 || prebuildDirectories[0] !== nativeDir) {
  throw new Error(`Packaged node-pty prebuilds are ${prebuildDirectories.join(',') || '(none)'}, expected only ${nativeDir}`);
}

for (const forbidden of [
  'app.asar.unpacked/node_modules/node-pty/build/Release',
  'app.asar.unpacked/node_modules/node-pty/build/Debug',
  'app.asar.unpacked/node_modules/node-pty/third_party/conpty'
]) {
  if (existsSync(path.join(resourcesDir, ...forbidden.split('/')))) {
    throw new Error(`Packaged node-pty host build leaked into target package: ${forbidden}`);
  }
}

function runExecutable(executable, args, expectedText) {
  const result = spawnSync(executable, args, { cwd: packageRoot, encoding: 'utf8', timeout: 15_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} exited ${result.status}: ${result.stderr || result.stdout}`);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (expectedText && !output.includes(expectedText)) throw new Error(`${executable} output did not contain ${expectedText}: ${output}`);
}

if (process.platform !== targetPlatform || process.arch !== targetArch) {
  process.stdout.write(`Packaged ${targetPlatform}-${targetArch} resources verified for ${expectedVersion}; native execution skipped on ${process.platform}-${process.arch}.\n`);
  process.exit(0);
}

runExecutable(path.join(resourcesDir, 'rg', `rg${suffix}`), ['--version'], RIPGREP.version);
runExecutable(path.join(resourcesDir, 'tunnel', `tunnel-client${suffix}`), ['--version'], TUNNEL_CLIENT.version.replace(/^v/, ''));
runExecutable(path.join(resourcesDir, 'tunnel', `cloudflared${suffix}`), ['--version']);

const probe = String.raw`
(async () => {
  const base = process.env.LOCALMCP_RESOURCES_DIR;
  const pty = require(base + '/app.asar/node_modules/node-pty');
  const manifest = require(base + '/app.asar/package.json');
  const win = process.platform === 'win32';
  const terminal = pty.spawn(win ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh', win ? ['/d', '/s', '/c', 'echo packaged-pty'] : ['-lc', 'printf packaged-pty'], {
    cols: 80, rows: 24, cwd: process.cwd(), env: process.env
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('node-pty packaged spawn timed out')), 10000);
    terminal.onData((data) => { output += data; });
    terminal.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 ? resolve() : reject(new Error('node-pty child exited ' + exitCode)); });
  });
  process.stdout.write(JSON.stringify({ version: manifest.version, electron: process.versions.electron, pty: output.includes('packaged-pty') }) + '\n');
  process.exit(0);
})().catch((error) => process.stderr.write(String(error?.stack || error) + '\n', () => process.exit(1)));`;

const result = spawnSync(appExecutable, ['-e', probe], {
  cwd: packageRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LOCALMCP_RESOURCES_DIR: resourcesDir },
  encoding: 'utf8',
  timeout: 30_000
});
if (result.error) throw result.error;
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);
const runtime = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
if (runtime.version !== expectedVersion || runtime.electron !== expectedElectronVersion || !runtime.pty) {
  throw new Error(`Packaged native runtime probe failed: ${JSON.stringify(runtime)}`);
}
process.stdout.write(`Packaged ${targetPlatform}-${targetArch} resources and node-pty runtime verified for ${expectedVersion}.\n`);
