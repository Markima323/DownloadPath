$ErrorActionPreference = 'Stop'
$taskRegistryKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.download_path_router.host'
if (Test-Path -LiteralPath $taskRegistryKey) {
    Remove-Item -LiteralPath $taskRegistryKey -Force
}
Write-Host 'Native messaging registration removed for the current Windows user.'
Write-Host 'Downloaded files, pending files and recovery records have been preserved.'
Write-Host 'Relative download rules continue to work. Absolute paths need the helper to be installed again.'
