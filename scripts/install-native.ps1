param([string]$ExtensionId = '')
$ErrorActionPreference = 'Stop'
$taskHostName = 'com.download_path_router.host'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskSource = Join-Path $taskRoot 'native\bin\download-path-host.exe'
if (-not (Test-Path -LiteralPath $taskSource -PathType Leaf)) {
    throw 'Helper executable is missing. Build it with npm.cmd run build:native, or use the full helper ZIP.'
}
if ([string]::IsNullOrWhiteSpace($ExtensionId)) {
    Write-Host 'Open the extension settings > Help and copy its extension ID.'
    $ExtensionId = Read-Host 'Chrome extension ID (32 lowercase letters)'
}
$ExtensionId = $ExtensionId.Trim()
if ($ExtensionId -cnotmatch '^[a-p]{32}$') { throw 'Invalid Chrome extension ID. Expected 32 lowercase letters from a to p.' }

$taskInstallDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DownloadPathRouter\host'
New-Item -ItemType Directory -Path $taskInstallDirectory -Force | Out-Null
$taskTarget = Join-Path $taskInstallDirectory 'download-path-host.exe'
$taskManifestPath = Join-Path $taskInstallDirectory ($taskHostName + '.json')
$taskOrigin = 'chrome-extension://' + $ExtensionId + '/'
$taskOrigins = @($taskOrigin)
if (Test-Path -LiteralPath $taskManifestPath -PathType Leaf) {
    try {
        $taskOldManifest = Get-Content -LiteralPath $taskManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($taskOldOrigin in $taskOldManifest.allowed_origins) {
            if ($taskOldOrigin -cmatch '^chrome-extension://[a-p]{32}/$' -and $taskOldOrigin -notin $taskOrigins) {
                $taskOrigins += $taskOldOrigin
            }
        }
    } catch { Write-Host 'Replacing an unreadable previous helper manifest.' }
}
Copy-Item -LiteralPath $taskSource -Destination $taskTarget -Force
$taskManifest = [ordered]@{
    name = $taskHostName
    description = 'Download Path Router Windows helper'
    path = $taskTarget
    type = 'stdio'
    allowed_origins = @($taskOrigins)
}
[System.IO.File]::WriteAllText($taskManifestPath, ($taskManifest | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
$taskRegistryKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $taskHostName
New-Item -Path $taskRegistryKey -Force | Out-Null
Set-Item -LiteralPath $taskRegistryKey -Value $taskManifestPath
Write-Host ''
Write-Host 'Installed for the current Windows user. Administrator privileges are not required.'
Write-Host ('Extension: ' + $ExtensionId)
Write-Host ('Helper:    ' + $taskTarget)
Write-Host 'Reload the extension in chrome://extensions, then check helper status in its settings.'
