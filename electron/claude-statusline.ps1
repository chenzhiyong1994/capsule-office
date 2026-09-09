$inputJson = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($inputJson)) {
  exit 0
}

try {
  $payload = $inputJson | ConvertFrom-Json -Depth 100
} catch {
  exit 0
}

function Get-FirstString {
  param([Parameter(ValueFromRemainingArguments = $true)] $Candidates)

  foreach ($candidate in $Candidates) {
    if ($null -ne $candidate -and "$candidate".Trim().Length -gt 0) {
      return "$candidate"
    }
  }

  return $null
}

function Get-Number {
  param($Value, $Default = 0)

  if ($null -eq $Value -or "$Value" -eq "") {
    return $Default
  }

  return $Value
}

function Normalize-ProjectPath {
  param([string] $PathValue)

  return ($PathValue -replace "\\", "/").ToLowerInvariant()
}

function Get-Hash {
  param([string] $Value)

  $sha1 = [System.Security.Cryptography.SHA1]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $hashBytes = $sha1.ComputeHash($bytes)
    return -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
  } finally {
    $sha1.Dispose()
  }
}

$projectPath = Get-FirstString `
  $payload.workspace.current_dir `
  $payload.workspace.project_dir `
  $payload.current_dir `
  $payload.cwd

if (-not $projectPath) {
  exit 0
}

$contextWindow = $payload.context_window
if ($null -eq $contextWindow) {
  exit 0
}

$appData = [Environment]::GetFolderPath("ApplicationData")
$snapshotDir = Join-Path $appData "pixel-office\claude-statusline"
New-Item -ItemType Directory -Force -Path $snapshotDir | Out-Null

$normalizedProjectPath = Normalize-ProjectPath $projectPath
$snapshotFile = Join-Path $snapshotDir "$(Get-Hash $normalizedProjectPath).json"

$snapshot = [ordered]@{
  managedBy = "pixel-office"
  capturedAt = (Get-Date).ToString("o")
  projectPath = $projectPath
  model = [ordered]@{
    displayName = Get-FirstString $payload.model.display_name $payload.model.name
    id = Get-FirstString $payload.model.id $payload.model.slug
  }
  context = [ordered]@{
    contextWindowSize = [int64](Get-Number $contextWindow.context_window_size 0)
    usedPercentage = [double](Get-Number $contextWindow.used_percentage 0)
    remainingPercentage = [double](Get-Number $contextWindow.remaining_percentage 0)
    totalInputTokens = [int64](Get-Number $contextWindow.total_input_tokens 0)
    totalOutputTokens = [int64](Get-Number $contextWindow.total_output_tokens 0)
    totalCacheCreationInputTokens = [int64](Get-Number $contextWindow.total_cache_creation_input_tokens 0)
    totalCacheReadInputTokens = [int64](Get-Number $contextWindow.total_cache_read_input_tokens 0)
  }
}

$snapshot | ConvertTo-Json -Depth 8 | Set-Content -Path $snapshotFile -Encoding UTF8
[Console]::Out.Write("")
