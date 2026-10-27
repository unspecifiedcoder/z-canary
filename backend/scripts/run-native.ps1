#requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$WalletStateDir,
    [string]$RuntimeStateDir,
    [ValidateRange(1024, 65535)][int]$Port = 8787,
    [string]$AllowedOrigin = 'http://127.0.0.1:3000',
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'The native wallet runner currently requires Windows DPAPI.' }
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$walletState = (Resolve-Path -LiteralPath $WalletStateDir).Path
if (-not (Test-Path -LiteralPath (Join-Path $walletState 'recovery.dpapi') -PathType Leaf)) {
    throw 'WalletStateDir must contain the existing recovery.dpapi for your wallet. This runner never creates or funds a replacement wallet.'
}
if ([string]::IsNullOrWhiteSpace($RuntimeStateDir)) {
    $RuntimeStateDir = Join-Path $repoRoot 'backend/state/native'
}
$runtimeState = [IO.Path]::GetFullPath($RuntimeStateDir)
if ($runtimeState.TrimEnd('\','/') -eq $walletState.TrimEnd('\','/')) {
    throw 'RuntimeStateDir must be separate from WalletStateDir.'
}
if ($AllowedOrigin -notmatch '^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$') {
    throw 'AllowedOrigin must be an exact loopback HTTP origin.'
}
$cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargoCommand) {
    $candidate = Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe'
    if (-not (Test-Path -LiteralPath $candidate)) { throw 'Install Rust 1.99.0 and make cargo available.' }
    $cargoPath = $candidate
} else { $cargoPath = $cargoCommand.Source }
$targetDir = if ([string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
    Join-Path $repoRoot 'backend/target'
} else { [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) }
$env:CARGO_TARGET_DIR = $targetDir

if (-not $SkipBuild) {
    # Separate script process: its successful `exit 0` must not terminate this runner.
    & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File (Join-Path $PSScriptRoot 'setup-wallet.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Pinned wallet source setup failed.' }
    & $cargoPath +1.99.0 build --locked --manifest-path (Join-Path $repoRoot 'wallet-gate/Cargo.toml') -j 1
    if ($LASTEXITCODE -ne 0) { throw 'Pinned wallet build failed.' }
    & $cargoPath +1.99.0 build --locked --manifest-path (Join-Path $repoRoot 'backend/Cargo.toml') -j 1 -p zcanary-agent -p zcanary-keeper-service -p zcanary-vault-cli
    if ($LASTEXITCODE -ne 0) { throw 'Native service build failed.' }
}
$walletExe = Join-Path $targetDir 'debug/wallet-gate.exe'
$agentExe = Join-Path $targetDir 'debug/zcanary-agent.exe'
$keeperExe = Join-Path $targetDir 'debug/zcanary-keeper-service.exe'
$vaultExe = Join-Path $targetDir 'debug/zcanary-vault-cli.exe'
foreach ($binary in @($walletExe, $agentExe, $keeperExe, $vaultExe)) {
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Native binary is missing: $binary" }
}
New-Item -ItemType Directory -Force -Path $runtimeState | Out-Null
$configPath = Join-Path $runtimeState 'runtime.json'
$config = [ordered]@{
    stateDir = $runtimeState
    walletStateDir = $walletState
    walletExecutable = $walletExe
    vaultExecutable = $vaultExe
    keeperExecutable = $keeperExe
    dpapiScript = Join-Path $repoRoot 'wallet-gate/dpapi.ps1'
}
if (Test-Path -LiteralPath $configPath) {
    $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($existing.stateDir -ne $runtimeState -or $existing.walletStateDir -ne $walletState) {
        throw 'Existing runtime configuration points to different state. Choose that original state explicitly; it will not be replaced.'
    }
}
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$tokenPath = Join-Path $runtimeState 'agent-token'
if (-not (Test-Path -LiteralPath $tokenPath)) {
    $random = [byte[]]::new(32)
    $randomSource = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $randomSource.GetBytes($random) } finally { $randomSource.Dispose() }
    $token = [Convert]::ToBase64String($random).TrimEnd('=').Replace('+','-').Replace('/','_')
    $tokenFile = [IO.File]::Open($tokenPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $encoded = [Text.Encoding]::UTF8.GetBytes($token)
        $tokenFile.Write($encoded, 0, $encoded.Length)
        $tokenFile.Flush($true)
    } finally {
        $tokenFile.Dispose()
        [Array]::Clear($random, 0, $random.Length)
        if ($encoded) { [Array]::Clear($encoded, 0, $encoded.Length) }
        Remove-Variable token -ErrorAction SilentlyContinue
    }
}
$checkToken = [IO.File]::ReadAllText($tokenPath).TrimEnd("`r", "`n")
if ($checkToken -notmatch '^[A-Za-z0-9_-]{43,4096}$') { throw 'The existing bearer token file is invalid.' }
Remove-Variable checkToken

$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $agentExe
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WorkingDirectory = $repoRoot
foreach ($argument in @('--listen', "127.0.0.1:$Port", '--token-file', $tokenPath, '--allowed-origin', $AllowedOrigin, '--runtime-config', $configPath)) {
    $start.ArgumentList.Add($argument)
}
$evidence = Join-Path $repoRoot 'docs/evidence/report.json'
if (Test-Path -LiteralPath $evidence) {
    $start.ArgumentList.Add('--evidence-file')
    $start.ArgumentList.Add($evidence)
}
$agent = $null
try {
    $agent = [Diagnostics.Process]::Start($start)
    Write-Host "Starting native testnet agent at http://127.0.0.1:$Port (wallet scan and keeper startup may take several minutes)."
    Write-Host "Allowed browser origin: $AllowedOrigin"
    Write-Host "Private bearer token file: $tokenPath"
    Write-Host 'Open Native Testnet in the app and enter that token locally. This runner never prints it. Press Ctrl+C here to stop.'
    while (-not $agent.HasExited) { Start-Sleep -Milliseconds 500 }
    if ($agent.ExitCode -ne 0) { throw "Native agent exited with code $($agent.ExitCode). Existing wallet and runtime state are preserved." }
} finally {
    if ($agent -and -not $agent.HasExited) {
        $stopToken = [IO.File]::ReadAllText($tokenPath).TrimEnd("`r", "`n")
        $stopped = $false
        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/runtime/stop" -Method Post -Headers @{Authorization = "Bearer $stopToken"} -ContentType 'application/json' -Body '{}' -TimeoutSec 15
            $stopped = $response.stopped -eq $true
        } catch {
            Write-Warning "Native shutdown has not completed. Agent PID $($agent.Id) remains alive to let any pending wallet operation settle. Preserve state at $runtimeState; never reset an uncertain wallet journal."
        } finally { Remove-Variable stopToken }
        if ($stopped -and -not $agent.WaitForExit(2000)) { $agent.Kill(); $agent.WaitForExit() }
    }
    if ($agent) { $agent.Dispose() }
}
