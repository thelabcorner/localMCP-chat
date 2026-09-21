[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,

  [Parameter(Mandatory = $true)]
  [string]$Deployment,

  # Agent installs are reproducible only when the exact artifact is pinned.
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9A-Fa-f]{64}$')]
  [string]$InstallerSha256,

  # Re-use an already persisted DPAPI credential instead of requiring LOCALMCP_OPENAI_API_KEY.
  [switch]$UseExistingCredential,

  # Apply/install only. Do not launch the connector afterwards.
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step([string]$Message) {
  Write-Host "[localMCP-chat] $Message"
}

function Get-InstalledExecutable {
  # The assisted NSIS installer lets a user choose a non-default directory. Its per-user
  # uninstall registration is therefore a better source of truth than guessing AppData paths.
  $registration = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq 'localMCP-chat' } |
    Select-Object -First 1
  if ($registration -and $registration.UninstallString) {
    $uninstaller = $null
    if ($registration.UninstallString -match '^"([^"]+)"') { $uninstaller = $Matches[1] }
    elseif ($registration.UninstallString -match '^([^ ]+\.exe)') { $uninstaller = $Matches[1] }
    if ($uninstaller) {
      $registeredExe = Join-Path (Split-Path -Parent $uninstaller) 'localMCP-chat.exe'
      if (Test-Path -LiteralPath $registeredExe -PathType Leaf) {
        return (Resolve-Path -LiteralPath $registeredExe).Path
      }
    }
  }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\localMCP-chat\localMCP-chat.exe'),
    (Join-Path $env:LOCALAPPDATA 'localMCP-chat\localMCP-chat.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return $null
}

function Stop-InstalledInstance([string]$Executable) {
  if (-not $Executable) { return }
  $installRoot = Split-Path -Parent $Executable
  $owned = Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)
  }
  if (-not $owned) { return }
  Write-Step "Stopping the existing installed instance before upgrade/configuration."
  # Stop children first, then the app. Restrict by executable path so an unrelated tunnel-client
  # elsewhere on the machine cannot be killed accidentally.
  $owned | Sort-Object ProcessId -Descending | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 150
    $stillRunning = Get-CimInstance Win32_Process | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)
    }
  } while ($stillRunning -and [DateTime]::UtcNow -lt $deadline)
  if ($stillRunning) { throw 'Existing localMCP-chat processes did not stop within 10 seconds.' }
}

function Resolve-Installer([string]$Value) {
  if ($Value -match '^https://') {
    $target = Join-Path ([IO.Path]::GetTempPath()) ('localMCP-chat-' + [Guid]::NewGuid().ToString('N') + '.exe')
    Write-Step "Downloading installer over HTTPS."
    Invoke-WebRequest -Uri $Value -OutFile $target
    return @{ Path = $target; Temporary = $true }
  }
  $resolved = (Resolve-Path -LiteralPath $Value -ErrorAction Stop).Path
  return @{ Path = $resolved; Temporary = $false }
}

function Assert-Hash([string]$Path) {
  $expected = $InstallerSha256.Trim().ToUpperInvariant()
  if ($expected -notmatch '^[0-9A-F]{64}$') { throw 'InstallerSha256 must be exactly 64 hexadecimal characters.' }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToUpperInvariant()
  if ($actual -ne $expected) { throw "Installer SHA-256 mismatch. Expected $expected, got $actual." }
  Write-Step 'Installer SHA-256 verified.'
}

function Run-OneShot([string]$Executable, [string]$DeploymentPath, [bool]$StoreCredential) {
  $arguments = @('--apply-deployment', ('"' + $DeploymentPath + '"'))
  if ($StoreCredential) { $arguments += '--store-openai-key-from-env' }
  $process = Start-Process -FilePath $Executable -ArgumentList $arguments -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "localMCP-chat deployment command exited with code $($process.ExitCode)." }
}

$installerArtifact = $null
try {
  $deploymentPath = (Resolve-Path -LiteralPath $Deployment -ErrorAction Stop).Path
  if ([IO.Path]::GetExtension($deploymentPath) -notin @('.yaml', '.yml', '.json')) {
    throw 'Deployment must be a .yaml, .yml or .json file.'
  }

  $installerArtifact = Resolve-Installer $Installer
  Assert-Hash $installerArtifact.Path

  # Verify the candidate before touching a healthy existing deployment. A corrupt or swapped
  # download should fail with zero downtime.
  $before = Get-InstalledExecutable
  Stop-InstalledInstance $before

  Write-Step 'Installing/updating localMCP-chat per-user.'
  $install = Start-Process -FilePath $installerArtifact.Path -ArgumentList '/S' -PassThru -Wait
  if ($install.ExitCode -ne 0) { throw "Installer exited with code $($install.ExitCode)." }

  $executable = Get-InstalledExecutable
  if (-not $executable) { throw 'Install completed but localMCP-chat.exe was not found in the expected per-user install location.' }
  Write-Step "Installed executable: $executable"

  $storeCredential = -not $UseExistingCredential
  if ($storeCredential -and -not $env:LOCALMCP_OPENAI_API_KEY) {
    throw 'LOCALMCP_OPENAI_API_KEY is not set. Supply it only in this process environment, or use -UseExistingCredential for an existing DPAPI credential.'
  }

  Write-Step 'Applying the versioned deployment with localMCP-chat itself.'
  Run-OneShot $executable $deploymentPath $storeCredential

  $configPath = Join-Path $env:APPDATA 'localmcp-chat\localmcp-chat.json'
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'Deployment command succeeded but localmcp-chat.json was not created.' }
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  if (-not $config.connectorName) { throw 'Persisted config does not contain connectorName.' }
  Write-Step "Configured connector identity: $($config.connectorName)"
  Write-Step "Approved roots: $(@($config.roots).Count)"

  if ($storeCredential) {
    $secretPath = Join-Path $env:APPDATA 'localmcp-chat\secrets.bin'
    if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) { throw 'Credential import reported success but secrets.bin is missing.' }
    Write-Step 'OpenAI credential sealed in OS-backed storage (value not printed).'
  }

  if (-not $NoLaunch) {
    Write-Step 'Launching hidden. The app will reconcile its per-user login item and auto-connect.'
    Start-Process -FilePath $executable -ArgumentList '--hidden'

    $logPath = Join-Path $env:APPDATA 'localmcp-chat\localmcp-chat.log'
    $needle = "$($config.connectorName) connected"
    $deadline = [DateTime]::UtcNow.AddSeconds(65)
    $connected = $false
    do {
      Start-Sleep -Milliseconds 500
      if (Test-Path -LiteralPath $logPath -PathType Leaf) {
        $tail = Get-Content -LiteralPath $logPath -Tail 80 -ErrorAction SilentlyContinue
        if ($tail -match [Regex]::Escape($needle)) { $connected = $true; break }
      }
    } while ([DateTime]::UtcNow -lt $deadline)

    if ($connected) {
      Write-Step "Tunnel connected as $($config.connectorName)."
    } else {
      Write-Warning "The app launched, but '$needle' was not observed within 65 seconds. Inspect $logPath before declaring deployment complete."
    }
  }

  Write-Step 'Bootstrap complete.'
} finally {
  # The child inherited the value long enough to DPAPI-seal it. Remove our copy regardless of
  # success; never echo or serialize the value.
  if (Test-Path Env:LOCALMCP_OPENAI_API_KEY) { Remove-Item Env:LOCALMCP_OPENAI_API_KEY }
  if ($installerArtifact -and $installerArtifact.Temporary -and (Test-Path -LiteralPath $installerArtifact.Path)) {
    Remove-Item -LiteralPath $installerArtifact.Path -Force -ErrorAction SilentlyContinue
  }
}
