param([Parameter(Mandatory=$true)][string]$Transaction,
      [Parameter(Mandatory=$true)][int]$ParentProcessId,
      [Parameter(Mandatory=$true)][int]$LauncherProcessId)
$ErrorActionPreference = 'Stop'
$record = Get-Content -LiteralPath (Join-Path $Transaction 'transaction.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$target = $record.target
$token = $record.token
$version = $record.version
$lock = Join-Path (Split-Path $target) ('.' + (Split-Path $target -Leaf) + '.update-lock')
$backup = Join-Path $Transaction 'backup.exe'
$download = Join-Path $Transaction 'download.exe'
$encoding = New-Object System.Text.UTF8Encoding($false)
function Write-State([string]$value) {
  [IO.File]::WriteAllText((Join-Path $Transaction 'state.next'), $value, $encoding)
  Move-Item -LiteralPath (Join-Path $Transaction 'state.next') -Destination (Join-Path $Transaction 'state') -Force
}
function Unlock {
  if ((Get-Content -LiteralPath (Join-Path $lock 'token') -Encoding UTF8 -Raw -ErrorAction SilentlyContinue) -eq $token) {
    Remove-Item -LiteralPath (Join-Path $lock 'token') -Force
    [IO.Directory]::Delete($lock)
  }
}
function Is-Alive([int]$processNumber) { return $null -ne (Get-Process -Id $processNumber -ErrorAction SilentlyContinue) }
function Move-WithRetry([string]$source, [string]$destination) {
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { [IO.File]::Move($source, $destination); return } catch { if ($attempt -eq 29) { throw }; Start-Sleep -Milliseconds 500 }
  }
}
function Rollback {
  if (Test-Path -LiteralPath $target) { Move-WithRetry $target (Join-Path $Transaction 'failed.exe') }
  Move-WithRetry $backup $target
  Write-State 'rolled_back'
  Unlock
  Start-Process -FilePath $target -WorkingDirectory (Split-Path $target)
}
try {
  if ((Get-Content -LiteralPath (Join-Path $lock 'token') -Encoding UTF8 -Raw) -ne $token) { throw 'Update lock ownership changed.' }
  $launcher = Get-Process -Id $LauncherProcessId -ErrorAction Stop
  if ($launcher.Path -ine $target) { throw 'The portable launcher could not be identified; leaving the app unchanged.' }
  [IO.File]::WriteAllText((Join-Path $Transaction 'helper.pid'), [string]$PID, $encoding)
  Write-State 'ready'
  [IO.File]::WriteAllText((Join-Path $Transaction 'ready'), '', $encoding)
  $deadline = (Get-Date).AddSeconds(90)
  while (!(Test-Path -LiteralPath (Join-Path $Transaction 'commit'))) {
    if ((Test-Path -LiteralPath (Join-Path $Transaction 'cancel')) -or !(Is-Alive $ParentProcessId)) { Write-State 'cancelled'; Unlock; exit 1 }
    if ((Get-Date) -gt $deadline) { Write-State 'commit_timeout'; Unlock; exit 1 }
    Start-Sleep -Milliseconds 200
  }
  $deadline = (Get-Date).AddSeconds(90)
  while ((Is-Alive $ParentProcessId) -or (Is-Alive $LauncherProcessId)) {
    if ((Get-Date) -gt $deadline) { Write-State 'exit_timeout'; Unlock; exit 1 }
    if (Test-Path -LiteralPath (Join-Path $Transaction 'cancel')) { Write-State 'cancelled'; Unlock; exit 1 }
    Start-Sleep -Milliseconds 200
  }
  Write-State 'replacing'
  try { Move-WithRetry $target $backup } catch {
    Write-State 'replace_failed'; Unlock
    Start-Process -FilePath $target -WorkingDirectory (Split-Path $target)
    exit 1
  }
  Write-State 'backed_up'
  try {
    Move-WithRetry $download $target
    Write-State 'opening'
    Start-Process -FilePath $target -WorkingDirectory (Split-Path $target) -ArgumentList "--missions-update-token=$token"
  } catch { Rollback; exit 1 }
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Content -LiteralPath (Join-Path $Transaction 'healthy') -Encoding UTF8 -Raw -ErrorAction SilentlyContinue) -ne "$token $version") {
    if ((Get-Date) -gt $deadline) { Write-State 'startup_timeout'; Unlock; exit 1 }
    Start-Sleep -Milliseconds 200
  }
  Write-State 'complete'
  Unlock
  Remove-Item -LiteralPath $backup -Force
} catch {
  $_ | Out-String | Write-Output
  Write-State 'recovery_required'
  Unlock
  exit 1
}
