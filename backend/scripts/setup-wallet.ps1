$ErrorActionPreference = 'Stop'

$upstreamUrl = 'https://github.com/zingolabs/zingolib.git'
$upstreamRevision = '4d85349f3cab5f7e4e5273c7f01c34044f17b1a9'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$checkout = Join-Path $repoRoot '.wallet-upstream/zingolib'
$checkoutParent = Split-Path -Parent $checkout

function Invoke-GitText([string[]]$GitArgs) {
    $output = & git @GitArgs
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE"
    }
    return (($output | Out-String).Trim())
}

if (Test-Path -LiteralPath $checkout) {
    if (-not (Test-Path -LiteralPath (Join-Path $checkout '.git'))) {
        throw "Existing upstream path is not a Git checkout; refusing to replace it: $checkout"
    }
    $existingRemote = Invoke-GitText -GitArgs @('-C', $checkout, 'remote', 'get-url', 'origin')
    if ($existingRemote -ne $upstreamUrl) {
        throw "Existing upstream origin does not match the pinned official repository; refusing to replace it: $checkout"
    }
    $existingRevision = Invoke-GitText -GitArgs @('-C', $checkout, 'rev-parse', 'HEAD')
    if ($existingRevision -ne $upstreamRevision) {
        throw "Existing upstream revision is not the pinned revision; refusing to replace it: $checkout"
    }
    Write-Output "Pinned Zingolib checkout already present at $upstreamRevision"
    exit 0
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git is required to set up the pinned Zingolib source.'
}

New-Item -ItemType Directory -Force -Path $checkoutParent | Out-Null
& git clone --no-checkout $upstreamUrl $checkout
if ($LASTEXITCODE -ne 0) {
    throw "git clone failed with exit code $LASTEXITCODE; inspect the partial checkout before retrying"
}
& git -C $checkout checkout --detach $upstreamRevision
if ($LASTEXITCODE -ne 0) {
    throw "git checkout failed with exit code $LASTEXITCODE; inspect the checkout before retrying"
}

$actualRemote = Invoke-GitText -GitArgs @('-C', $checkout, 'remote', 'get-url', 'origin')
$actualRevision = Invoke-GitText -GitArgs @('-C', $checkout, 'rev-parse', 'HEAD')
if ($actualRemote -ne $upstreamUrl -or $actualRevision -ne $upstreamRevision) {
    throw 'The cloned upstream checkout did not match the pinned remote and revision.'
}
Write-Output "Pinned Zingolib checkout ready at $upstreamRevision"
