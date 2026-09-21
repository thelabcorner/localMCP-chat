export const SUPPORTED_PLATFORMS = Object.freeze(['win32', 'linux']);
export const SUPPORTED_ARCHES = Object.freeze(['x64', 'arm64']);

const PLATFORM_ALIASES = Object.freeze({
  win: 'win32',
  windows: 'win32',
  win32: 'win32',
  linux: 'linux'
});

export const PLATFORM_INFO = Object.freeze({
  win32: Object.freeze({
    builderFlag: '--win',
    upstreamOs: 'windows',
    displayName: 'Windows',
    executableSuffix: '.exe',
    unpackedPrefix: 'win'
  }),
  linux: Object.freeze({
    builderFlag: '--linux',
    upstreamOs: 'linux',
    displayName: 'Linux',
    executableSuffix: '',
    unpackedPrefix: 'linux'
  })
});

export function normalizePlatform(value = process.platform) {
  const normalized = PLATFORM_ALIASES[String(value).toLowerCase()];
  if (!normalized) {
    throw new Error(`Unsupported packaging platform ${value}; expected ${SUPPORTED_PLATFORMS.join(', ')}`);
  }
  return normalized;
}

export function normalizeArch(value = process.arch) {
  const arch = String(value).toLowerCase();
  if (!SUPPORTED_ARCHES.includes(arch)) {
    throw new Error(`Unsupported packaging architecture ${value}; expected ${SUPPORTED_ARCHES.join(', ')}`);
  }
  return arch;
}

export function parseTarget(argv = process.argv.slice(2)) {
  let platform = process.platform;
  let arch = process.arch;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--platform') platform = argv[++index];
    else if (arg.startsWith('--platform=')) platform = arg.slice('--platform='.length);
    else if (arg === '--arch') arch = argv[++index];
    else if (arg.startsWith('--arch=')) arch = arg.slice('--arch='.length);
  }
  return { platform: normalizePlatform(platform), arch: normalizeArch(arch) };
}

export function nativePrebuildDir(platformValue, archValue) {
  return `${normalizePlatform(platformValue)}-${normalizeArch(archValue)}`;
}

export function unpackedDirectoryPattern(platformValue) {
  const platform = normalizePlatform(platformValue);
  return new RegExp(`^${PLATFORM_INFO[platform].unpackedPrefix}(?:-[a-z0-9]+)?-unpacked$`, 'i');
}
