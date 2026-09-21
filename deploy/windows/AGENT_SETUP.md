# Deploy localMCP-chat to a Windows homelab machine

This file is written to be handed directly to an execution agent on the target Windows machine.
Follow it literally. Do not reuse the workstation tunnel or put credentials into the deployment
file, command line, logs, chat output, or source control.

## Goal

Install or update `localMCP-chat`, configure this machine as a distinct connector, persist the
OpenAI credential with Windows DPAPI, enable per-user startup/hidden auto-connect, and verify the
tunnel is live.

Recommended identity for this target:

```text
localMCP-homelab
```

The workstation should remain a separate connector, for example `localMCP-workstation`.

## Important naming boundary

There are two names to keep aligned:

1. `connectorName` in the local deployment file. This becomes the MCP server identity and the
   local app/tray identity.
2. The custom app name in ChatGPT. OpenAI owns that app metadata; the local program cannot rename
   an already-created ChatGPT app remotely.

Use `localMCP-homelab` for both. The homelab also needs its **own Secure MCP Tunnel ID**. Never
reuse the workstation tunnel ID.

If the operator has not supplied a distinct homelab tunnel ID, stop and ask for one. Do not invent
one and do not substitute the workstation value.

## Inputs you need

- A Windows x64/ARM64 localMCP-chat installer appropriate for this machine.
- The trusted SHA-256 of that installer. Automated bootstrap always requires it.
- A separate OpenAI Secure MCP Tunnel ID for the ChatGPT app named `localMCP-homelab`.
- The folders the operator wants ChatGPT to access on this machine.
- An OpenAI API key supplied as secret input for initial setup, unless this installation already
  has a working DPAPI-sealed credential.

Do not ask the operator to paste the API key into the YAML file.

If the operator supplies a base64-encoded credential bundle, treat the **encoded blob itself as a
secret**. Base64 is transport encoding, not encryption. Decode it only in process memory, extract
the tunnel ID/API key, clear the encoded/plain temporary values as soon as they have been consumed,
and never copy either form into source control, a deployment file, console output, or a completion
report.

### If no installer was supplied

The canonical source remote is:

```text
https://github.com/thelabcorner/localMCP-chat.git
```

An execution agent may build the installer locally instead of blocking on a missing release asset.
Prefer an operator-supplied commit/tag. If none was supplied, use the current `main` but record the
exact commit SHA in the completion report so the installed source is reproducible.

```powershell
$work = Join-Path $env:TEMP ('localMCP-chat-build-' + [Guid]::NewGuid().ToString('N'))
git clone https://github.com/thelabcorner/localMCP-chat.git $work
Set-Location $work
git rev-parse HEAD

# Node 22+ is required. If it is absent, install a normal per-user/system Node 22+ distribution
# through the machine's existing package-management policy rather than downloading an arbitrary
# executable from an untrusted mirror.
node --version
npm --version
npm ci
npm run verify:ci
$osArch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
switch ($osArch) {
  'X64'   { npm run dist:x64;   $artifact = 'localMCP-chat-Setup-x64.exe' }
  'Arm64' { npm run dist:arm64; $artifact = 'localMCP-chat-Setup-arm64.exe' }
  default { throw "Unsupported Windows architecture: $osArch" }
}

$installer = Join-Path $work ('release\' + $artifact)
$installerSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash
```

Use those two variables for the bootstrap below. A locally built artifact obviously cannot be
validated against an operator-provided binary hash; the recorded source commit + successful CI
verification are the provenance in that lane.

## 1. Prepare the deployment file

Copy `deploy/windows/localmcp-homelab.example.yaml` to a temporary working path and replace only
the machine-specific placeholders. A typical deployment is:

```yaml
version: 1
connectorName: localMCP-homelab

roots:
  - name: projects
    path: C:\Users\TARGET_USER\WebstormProjects

permissions:
  read: true
  write: true
  shell: true
  git: true
  plugins: true
  filesReceive: true
  filesSend: false

tunnel:
  kind: openai
  tunnelId: tunnel_REPLACE_WITH_MACHINE_TUNNEL_ID
  binaryPath: ""

preferences:
  launchAtLogin: true
  startHidden: true
  autoConnect: true
  closeToTray: true
```

The tunnel ID above is only an example. Replace it. Root paths must already exist. Do not approve
an entire drive. Root names must be unique lowercase slugs and roots must not overlap.

The deployment schema is intentionally strict. Unknown fields and typos should fail rather than be
silently ignored.

## 2. Put the API key only in this process environment

For an initial OpenAI-tunnel deployment, obtain the API key through the agent's secret mechanism
or a private operator prompt and set:

```powershell
$env:LOCALMCP_OPENAI_API_KEY = <secret value supplied at runtime>
```

Do **not** print the value. Do **not** add it to PowerShell history as a literal command if a secret
input mechanism is available. `bootstrap.ps1` removes its own environment copy in `finally` after
the installed app has sealed the key with Windows DPAPI.

For an update to a machine that already has a valid stored credential, omit the environment value
and pass `-UseExistingCredential` to the bootstrap helper.

## 3. Run the bootstrap helper

From the localMCP-chat source/deployment bundle:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
& .\deploy\windows\bootstrap.ps1 `
  -Installer 'C:\path\to\localMCP-chat-Setup-x64.exe' `
  -InstallerSha256 '<trusted 64-hex SHA256>' `
  -Deployment 'C:\path\to\localmcp-homelab.yaml'
```

The `Installer` value may also be an HTTPS URL. `InstallerSha256` is mandatory for every bootstrap,
including local and network paths, so automation is pinned to exact bytes.

The helper must:

- stop only processes whose executable lives under the installed localMCP-chat directory;
- install/update the per-user application silently;
- run the installed app's `--apply-deployment` path rather than editing AppData by hand;
- use `--store-openai-key-from-env` for initial credential import;
- verify that config was persisted and `secrets.bin` exists when a credential was imported;
- launch the app with `--hidden`;
- let the app reconcile its own Windows login item;
- wait up to 65 seconds for `<connectorName> connected` in the bounded app log.

Do not replace this with direct writes to `%APPDATA%\localmcp-chat` unless debugging a defect in the
bootstrap itself.

### Standalone path when this Markdown is the only deployment file you were given

If `bootstrap.ps1` is not present, do not block. This Markdown is intentionally sufficient on its
own. Perform the equivalent sequence directly. The variables below are placeholders; obtain the
real installer path/hash and deployment path from the operator or your deployment environment.

```powershell
$ErrorActionPreference = 'Stop'
$installer = 'C:\path\to\localMCP-chat-Setup-x64.exe'
$expectedSha256 = '<trusted 64-hex SHA256>'
$deployment = 'C:\path\to\localmcp-homelab.yaml'

# Verify before taking down an existing deployment.
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash
if ($actual -ne $expectedSha256.ToUpperInvariant()) {
  throw "Installer SHA-256 mismatch: $actual"
}

# If an older installed copy is running, stop only processes from that install tree.
$installed = "$env:LOCALAPPDATA\Programs\localMCP-chat\localMCP-chat.exe"
if (Test-Path -LiteralPath $installed) {
  $installRoot = Split-Path -Parent $installed
  Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase) } |
    Sort-Object ProcessId -Descending |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$install = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru -Wait
if ($install.ExitCode -ne 0) { throw "Installer exited with $($install.ExitCode)" }

$exe = "$env:LOCALAPPDATA\Programs\localMCP-chat\localMCP-chat.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw 'Installed executable not found.' }

# LOCALMCP_OPENAI_API_KEY must already have been supplied privately in this process environment.
if (-not $env:LOCALMCP_OPENAI_API_KEY) { throw 'Missing private LOCALMCP_OPENAI_API_KEY input.' }
$apply = Start-Process -FilePath $exe `
  -ArgumentList @('--apply-deployment', ('"' + $deployment + '"'), '--store-openai-key-from-env') `
  -PassThru -Wait
Remove-Item Env:LOCALMCP_OPENAI_API_KEY -ErrorAction SilentlyContinue
if ($apply.ExitCode -ne 0) { throw "Deployment apply exited with $($apply.ExitCode)" }

Start-Process -FilePath $exe -ArgumentList '--hidden'
```

Then perform sections 4 through 6 below. The reusable helper is preferred because it also handles
HTTPS download cleanup and bounded connection waiting, but no hidden app-specific mutation exists
inside it: the installed executable remains the authority for validating and persisting deployment.

## 4. Verify the deployed identity and authority

Read, but do not modify, this file:

```text
%APPDATA%\localmcp-chat\localmcp-chat.json
```

Confirm:

- `connectorName` is exactly `localMCP-homelab`;
- every approved root is the intended canonical local folder;
- the homelab tunnel ID is not the workstation tunnel ID;
- capability booleans match the deployment request;
- the file contains **no API key**.

For an initial credential import, confirm this exists:

```text
%APPDATA%\localmcp-chat\secrets.bin
```

Do not attempt to print/decrypt it.

## 5. Verify runtime state

Confirm the installed application and its tunnel child are running from the same install tree:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -like "$env:LOCALAPPDATA\Programs\localMCP-chat*" } |
  Select-Object ProcessId, Name, ExecutablePath
```

Inspect the bounded log without printing credentials:

```powershell
Get-Content "$env:APPDATA\localmcp-chat\localmcp-chat.log" -Tail 100
```

Look for a line equivalent to:

```text
localMCP-homelab connected
```

The connector should also register itself to start for the current Windows user because the
deployment enables `launchAtLogin`, `startHidden`, `autoConnect`, and `closeToTray`.

This is intentionally a **per-user, non-elevated** deployment. Do not convert localMCP-chat into a
SYSTEM service or an elevated scheduled task as a convenience. Its shell capability executes with
the host process's Windows token; running the connector as SYSTEM would turn an ordinary approved
shell call into SYSTEM-level code execution and would also break the user-scoped DPAPI credential
model. An RDP disconnect leaves the user session running; a Windows logoff ends the connector, and
the configured login item starts it again at the next sign-in.

## 6. ChatGPT-side final check

The operator must have a custom ChatGPT app named `localMCP-homelab` using the homelab's tunnel ID.
OpenAI's current custom-app workflow keeps the app name as ChatGPT-side metadata, so the local MCP
server identity and the ChatGPT app label should be set to the same value deliberately.

Once the app appears in ChatGPT, scan/refresh its tools if necessary and run a harmless read-only
smoke test against an approved homelab root. Do not run mutation/shell tests unless the operator
asked for them.

## Failure rules

- If installer hash verification fails, stop. Do not install it.
- If the deployment parser rejects the file, fix the stated field rather than bypassing validation.
- If a root does not exist or overlaps another root, stop and ask for the intended folder layout.
- If DPAPI credential import fails, do not persist the key in plaintext as a workaround.
- Do not run the connector as Administrator or SYSTEM merely to make it survive a user logoff.
- If the tunnel does not connect within 65 seconds, inspect the log and tunnel ID. Do not reuse the
  workstation tunnel as a fallback.
- Never output API keys, decrypted credentials, or full secret-bearing environment blocks in the
  completion report.

## Completion report

Report only:

- installed localMCP-chat version/path;
- installer SHA-256 verification result;
- connector name;
- approved virtual root names and canonical paths;
- capability toggles;
- whether DPAPI credential storage is present (never the value);
- whether startup registration is enabled;
- whether the tunnel reached connected state;
- any unresolved warning/error.
