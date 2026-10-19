<#
  Local Image Lab installer.

  Downloads the programs (Node.js, stable-diffusion.cpp, llama.cpp, FFmpeg, Ollama) and the
  AI models from their official sources into this folder, checks every file against its
  published SHA-256 hash, and creates Start shortcuts.

  It is safe to run again at any time: finished files are kept, interrupted downloads resume,
  and nothing outside this folder is changed apart from the two shortcuts.
#>
param(
  [switch]$SkipReferenceModel,  # leave out the optional 11.4 GB MiniMax H3 reference model
  [switch]$RuntimesOnly,        # install the programs only, no model downloads
  [switch]$NoShortcuts,
  [switch]$NoStart,
  [switch]$Unattended           # never ask questions or wait for a key
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root
$Logs = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }
function Heading([string]$Text) { Write-Host ''; Write-Host $Text -ForegroundColor Cyan }
function GB([double]$Bytes) { if ($Bytes -lt 1e9) { '{0:N0} MB' -f ($Bytes / 1e6) } else { '{0:N1} GB' -f ($Bytes / 1e9) } }
function Write-Json([string]$Path, $Value) { [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 6), $Utf8) }
# Windows PowerShell 5.1 returns a JSON array as one object; assigning it first unrolls it.
function Read-Json([string]$Path) { $value = [IO.File]::ReadAllText($Path) | ConvertFrom-Json; $value }

# ---------------------------------------------------------------- downloads

$Curl = Join-Path $env:SystemRoot 'System32\curl.exe'
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'

function Save-Url([string]$Url, [string]$File, [int64]$Bytes, [string]$Sha256) {
  if ((Test-Path -LiteralPath $File) -and (Get-Item -LiteralPath $File).Length -gt $Bytes) { Remove-Item -LiteralPath $File -Force }
  for ($attempt = 1; $attempt -le 8; $attempt++) {
    $have = 0; if (Test-Path -LiteralPath $File) { $have = (Get-Item -LiteralPath $File).Length }
    if ($have -eq $Bytes) { break }
    if (Test-Path -LiteralPath $Curl) {
      # -C - resumes a partial file; the speed limit restarts a stalled connection.
      & $Curl -L --fail --progress-bar --connect-timeout 30 --speed-limit 10000 --speed-time 60 -C - -o $File $Url
    } else {
      try { Invoke-WebRequest -Uri $Url -OutFile $File -UseBasicParsing } catch { Say ('  ' + $_.Exception.Message) Yellow }
    }
    $have = 0; if (Test-Path -LiteralPath $File) { $have = (Get-Item -LiteralPath $File).Length }
    if ($have -ne $Bytes) { Say "  The download was interrupted. Retrying ($attempt of 8)..." Yellow; Start-Sleep -Seconds ([Math]::Min(60, 5 * $attempt)) }
  }
  if (-not (Test-Path -LiteralPath $File) -or (Get-Item -LiteralPath $File).Length -ne $Bytes) { throw "Could not download $Url. Check the internet connection." }
  Say '  Checking the file...'
  $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256) { Remove-Item -LiteralPath $File -Force; throw "The downloaded file did not match its published checksum ($Url). It was deleted; run Install again." }
}

function Install-Runtime($Item) {
  $marker = Join-Path $Root "runtime\.installed-$($Item.id).json"
  if ((Test-Path -LiteralPath (Join-Path $Root $Item.check)) -and (Test-Path -LiteralPath $marker)) {
    if ((Read-Json $marker).sha256 -eq $Item.sha256) { Say "  $($Item.name): already installed" DarkGray; return }
  }
  Say "  $($Item.name) ($(GB $Item.bytes))" White
  $downloads = Join-Path $Root 'runtime\_downloads'
  New-Item -ItemType Directory -Force -Path $downloads | Out-Null
  $zip = Join-Path $downloads ([IO.Path]::GetFileName(([Uri]$Item.url).AbsolutePath))
  Save-Url $Item.url $zip $Item.bytes $Item.sha256

  $staging = Join-Path $Root "runtime\_staging\$($Item.id)"
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  Say '  Unpacking...'
  if (Test-Path -LiteralPath $Tar) {
    $tarArgs = @('-xf', $zip, '-C', $staging)
    foreach ($pattern in @($Item.exclude)) { if ($pattern) { $tarArgs += @('--exclude', $pattern) } }
    & $Tar @tarArgs
    if ($LASTEXITCODE -ne 0) { throw "Could not unpack $zip." }
  } else {
    Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force
    foreach ($pattern in @($Item.exclude)) { if ($pattern) { Remove-Item -Path (Join-Path $staging $pattern) -Recurse -Force -ErrorAction SilentlyContinue } }
  }
  # Archives that wrap everything in one top folder (Node.js, FFmpeg) are unwrapped.
  $source = $staging
  $entries = @(Get-ChildItem -LiteralPath $source -Force)
  if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) { $source = $entries[0].FullName }

  $dest = Join-Path $Root $Item.dest
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  foreach ($pair in $Item.copy.PSObject.Properties) {
    if ($pair.Name -eq '*') {
      Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $dest -Recurse -Force
    } else {
      $from = Join-Path $source $pair.Name
      if (-not (Test-Path -LiteralPath $from)) { throw "$($pair.Name) is missing from $($Item.name)." }
      Copy-Item -LiteralPath $from -Destination (Join-Path $dest $pair.Value) -Recurse -Force
    }
  }
  Remove-Item -LiteralPath $staging -Recurse -Force
  if (-not (Test-Path -LiteralPath (Join-Path $Root $Item.check))) { throw "$($Item.name) did not install correctly ($($Item.check) is missing)." }
  Write-Json $marker ([ordered]@{ name = $Item.name; url = $Item.url; sha256 = $Item.sha256; installedAt = (Get-Date).ToString('o') })
  Remove-Item -LiteralPath $zip -Force
  Say '  Installed.' Green
}

# ---------------------------------------------------------------- models

# The app's own resumable downloaders are reused. Each verifies SHA-256 hashes and keeps
# its progress in logs\, which the Video page also reads.
$ModelGroups = @(
  @{ Label = 'Image models: Qwen Image 2.1 Turbo and FLUX 3 Klein'; Manifest = 'model-downloads.json'; Script = 'download-models.mjs'; Evidence = 'downloads-verified.json' },
  @{ Label = 'Guided scene reader (Qwen3-VL 4B vision part)'; Manifest = 'video-director-downloads.json'; Script = 'download-video-director.mjs'; Evidence = 'video-director-downloads-verified.json' },
  @{ Label = 'Story writer (Qwen3.5 9B)'; Manifest = 'video-writer-downloads.json'; Script = 'download-video-writer.mjs'; Evidence = 'video-writer-downloads-verified.json' },
  @{ Label = 'MiniMax H3 video model'; Manifest = 'video-model-downloads.json'; Script = 'download-video-models.mjs'; Evidence = 'video-downloads-verified.json' },
  @{ Label = 'MiniMax H3 reference model (video from pictures, video and sound)'; Manifest = 'video-reference-downloads.json'; Script = 'download-video-reference-model.mjs'; Evidence = 'video-reference-downloads-verified.json'; Optional = $true }
)
if ($SkipReferenceModel) { $ModelGroups = @($ModelGroups | Where-Object { -not $_.Optional }) }

function Get-GroupState($Group) {
  $files = @(Read-Json (Join-Path $Root $Group.Manifest))
  [int64]$total = 0; [int64]$missing = 0; $complete = $true
  foreach ($file in $files) {
    [int64]$bytes = $file.bytes
    $total += $bytes
    $target = Join-Path $Root ('models\' + $file.file)
    if (-not (Test-Path -LiteralPath $target) -or (Get-Item -LiteralPath $target).Length -ne $bytes) {
      $complete = $false
      [int64]$have = 0
      foreach ($partial in @("$target.segmented.part", "$target.part")) { if (Test-Path -LiteralPath $partial) { $have = [Math]::Max($have, [int64](Get-Item -LiteralPath $partial).Length) } }
      $missing += [Math]::Max([int64]0, $bytes - $have)
    }
  }
  $verified = $false
  $evidence = Join-Path $Logs $Group.Evidence
  if ($complete -and (Test-Path -LiteralPath $evidence)) { try { $verified = (Read-Json $evidence).complete -eq $true } catch {} }
  @{ Total = $total; Missing = $missing; Complete = $complete; Verified = $verified }
}

# ---------------------------------------------------------------- checks

function Get-Gpus {
  $key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
  foreach ($sub in @(Get-ChildItem -LiteralPath $key -ErrorAction SilentlyContinue)) {
    if ($sub.PSChildName -notmatch '^\d{4}$') { continue }
    $p = Get-ItemProperty -LiteralPath $sub.PSPath -ErrorAction SilentlyContinue
    if (-not $p.DriverDesc) { continue }
    $memory = $p.'HardwareInformation.qwMemorySize'
    if ($memory -is [byte[]]) { $memory = [BitConverter]::ToUInt64($memory, 0) }
    if (-not $memory) { $memory = $p.'HardwareInformation.MemorySize'; if ($memory -is [byte[]]) { $memory = [BitConverter]::ToUInt32($memory, 0) } }
    [pscustomobject]@{ Name = [string]$p.DriverDesc; Bytes = [double]$memory }
  }
}

function Test-Pc {
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'Local Image Lab needs 64-bit Windows 10 or 11.' }
  if ($Root -match '\\(Temp|tmp)\\[^\\]*\.zip\\' -or $Root -match '\\AppData\\Local\\Temp\\Temp') {
    throw 'It looks like Install.cmd was opened from inside the ZIP file. Right-click the ZIP, choose Extract All, then run Install.cmd from the extracted folder.'
  }

  $gpus = @(Get-Gpus | Sort-Object Bytes -Descending)
  $ram = 0; try { $ram = [double](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory } catch {}
  Say 'This PC:'
  foreach ($gpu in $gpus) { Say ('  Graphics: {0} ({1:N1} GB)' -f $gpu.Name, ($gpu.Bytes / 1GB)) }
  if ($ram) { Say ('  Memory:   {0:N0} GB' -f ($ram / 1GB)) }
  Write-Json (Join-Path $Logs 'install-pc.json') ([ordered]@{ checkedAt = (Get-Date).ToString('o'); gpus = $gpus; ramBytes = $ram; os = [Environment]::OSVersion.VersionString })

  $best = 0; if ($gpus.Count) { $best = $gpus[0].Bytes }
  if ($best -lt 7.5GB) {
    Say ''
    Say 'WARNING: no graphics card with 8 GB or more of video memory was found.' Yellow
    Say 'Images and video will be very slow or may not work at all.' Yellow
  } elseif ($best -lt 15GB) {
    Say ''
    Say 'NOTE: this app was set up on a 16 GB graphics card. With less video memory,' Yellow
    Say 'images should still work, but video may fail or be very slow.' Yellow
  }
  if ($ram -and $ram -lt 30GB) { Say 'NOTE: 32 GB of memory (RAM) is recommended for video.' Yellow }
  if (-not (Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32\vulkan-1.dll'))) {
    Say 'WARNING: Vulkan is missing. Install the latest driver for the graphics card (AMD, NVIDIA or Intel), then run Install again.' Yellow
  }
}

function Test-Space {
  $need = 2e9 + 10e9
  if (-not $RuntimesOnly) { foreach ($group in $ModelGroups) { $need += (Get-GroupState $group).Missing } }
  $free = $null
  try { $free = [double](New-Object System.IO.DriveInfo ([IO.Path]::GetPathRoot($Root))).AvailableFreeSpace } catch {}
  if ($null -eq $free) { return }
  Say ('  Free space on this drive: {0}; needed: about {1}' -f (GB $free), (GB $need))
  if ($free -lt $need) {
    throw ('Not enough free disk space. This drive has {0} free and the downloads need about {1}. Move this folder to a drive with more space (or free some up) and run Install again.' -f (GB $free), (GB $need))
  }
}

function Set-Shortcuts {
  $shell = New-Object -ComObject WScript.Shell
  $targets = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Local Image Lab.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Local Image Lab.lnk')
  )
  foreach ($path in $targets) {
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $link.Arguments = '"' + (Join-Path $Root 'Start Local Image Lab.vbs') + '"'
    $link.WorkingDirectory = $Root
    $link.IconLocation = (Join-Path $Root 'installer\local-image-lab.ico') + ',0'
    $link.Description = 'Open Local Image Lab'
    $link.Save()
  }
  Say '  Added "Local Image Lab" to the desktop and the Start menu.' Green
}

function Enable-SetupCheck([string]$Name) {
  # The app runs one short test clip by itself when a check is waiting (app\video-setup.mjs).
  $file = Join-Path $Logs $Name
  if (-not (Test-Path -LiteralPath $file)) {
    Write-Json $file ([ordered]@{ status = 'waiting'; message = 'A short test clip will run when the app is idle.'; createdAt = (Get-Date).ToString('o') })
  }
}

# ---------------------------------------------------------------- main

$transcript = $false
try { Start-Transcript -LiteralPath (Join-Path $Logs 'install.log') -Append | Out-Null; $transcript = $true } catch {}

# Keep the PC awake while this window is downloading (the screen may still turn off).
try {
  Add-Type -Namespace LocalImageLab -Name InstallPower -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
  [void][LocalImageLab.InstallPower]::SetThreadExecutionState([uint32]2147483649)
} catch {}

$exitCode = 0
try {
  Say '==============================================' Cyan
  Say '  Local Image Lab - install or repair' Cyan
  Say '==============================================' Cyan
  Say "Folder: $Root"
  Say 'Keep this window open. You can close it at any time and run Install.cmd'
  Say 'again later: finished downloads are kept and the rest resumes.'

  # Files from a downloaded ZIP carry a "came from the internet" mark that makes Windows
  # ask before every start. The installer clears it for this app's own files only.
  Get-ChildItem -LiteralPath $Root -File | Unblock-File -ErrorAction SilentlyContinue
  foreach ($dir in 'app', 'installer', 'licenses') {
    $path = Join-Path $Root $dir
    if (Test-Path -LiteralPath $path) { Get-ChildItem -LiteralPath $path -File -Recurse | Unblock-File -ErrorAction SilentlyContinue }
  }

  Heading '[1/4] Checking this PC'
  Test-Pc
  Test-Space

  Heading '[2/4] Programs (about 1.8 GB to download)'
  foreach ($item in @(Read-Json (Join-Path $PSScriptRoot 'runtimes.json'))) { Install-Runtime $item }
  $runtimeDir = Join-Path $Root 'runtime'
  foreach ($leftover in '_staging', '_downloads') { $path = Join-Path $runtimeDir $leftover; if ((Test-Path -LiteralPath $path) -and -not (Get-ChildItem -LiteralPath $path -Force)) { Remove-Item -LiteralPath $path -Force } }

  if (-not $RuntimesOnly) {
    Heading '[3/4] AI models'
    $node = Join-Path $Root 'runtime\node.exe'
    $total = 0; $missing = 0
    foreach ($group in $ModelGroups) { $state = Get-GroupState $group; $total += $state.Total; $missing += $state.Missing }
    Say ('  {0} in total, {1} still to download.' -f (GB $total), (GB $missing))
    if ($missing -gt 20e9) { Say '  This usually takes several hours. On a slow connection, leave it running overnight.' }
    foreach ($group in $ModelGroups) {
      $state = Get-GroupState $group
      if ($state.Complete -and $state.Verified) { Say "  $($group.Label): already downloaded and checked" DarkGray; continue }
      Say ''
      Say ("  $($group.Label) ({0})" -f (GB $state.Total)) White
      & $node (Join-Path $Root ('app\' + $group.Script))
      if ($LASTEXITCODE -eq 2) { throw 'Another download is already running (another Install window, or Resume download in the app). Let it finish. If you have just closed one, wait a minute and run Install again.' }
      if ($LASTEXITCODE -ne 0) { throw "The download of '$($group.Label)' stopped. The reason is shown above." }
    }
    Enable-SetupCheck 'video-setup-check.json'
    if (-not $SkipReferenceModel) { Enable-SetupCheck 'video-reference-setup-check.json' }
  }

  Heading '[4/4] Shortcuts'
  if ($NoShortcuts) { Say '  Skipped.' DarkGray } else { Set-Shortcuts }

  Say ''
  if ($RuntimesOnly) {
    Say 'Programs installed. Run Install.cmd again without -RuntimesOnly to download the models.' Green
  } else {
    Say 'Local Image Lab is installed.' Green
    Say 'Open it with the "Local Image Lab" icon on the desktop.' Green
    Say 'The first time the app is idle it makes two short test videos by itself (about 25 minutes).' Green
    if (-not $NoStart -and -not $Unattended) {
      $answer = Read-Host 'Open Local Image Lab now? (Y/n)'
      if ($answer -notmatch '^[nN]') { Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $Root 'Start Local Image Lab.vbs') + '"') -WorkingDirectory $Root }
    }
  }
} catch {
  $exitCode = 1
  Say ''
  Say ('Installation stopped: ' + $_.Exception.Message) Red
  Say 'Nothing is lost. Fix the problem above if there is one, then double-click Install.cmd again.' Yellow
  Say ('Details are saved in ' + (Join-Path $Logs 'install.log')) DarkGray
} finally {
  if ($transcript) { try { Stop-Transcript | Out-Null } catch {} }
}
exit $exitCode
