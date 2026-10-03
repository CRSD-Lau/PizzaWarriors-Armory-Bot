# Author: Neil Mitchell
# Last Modified By: Neil Mitchell
[CmdletBinding()]
param(
  [string]$ToolsDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime\music'),
  [string]$FfmpegPath
)
$ErrorActionPreference = 'Stop'
$version = '2026.08.19'
$expectedHash = '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a'
if (-not $FfmpegPath) {
  $FfmpegPath = (Get-Command ffmpeg.exe -ErrorAction Stop).Source
}
$FfmpegPath = (Resolve-Path -LiteralPath $FfmpegPath).Path
$toolsRoot = [IO.Path]::GetFullPath($ToolsDirectory)
[IO.Directory]::CreateDirectory($toolsRoot) | Out-Null
$target = Join-Path $toolsRoot "yt-dlp-$version.exe"
if (-not (Test-Path -LiteralPath $target)) {
  $download = Join-Path $toolsRoot ("download-" + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/download/$version/yt-dlp.exe" -OutFile $download
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
      throw 'Downloaded yt-dlp did not match the pinned SHA-256. Nothing was installed.'
    }
    Move-Item -LiteralPath $download -Destination $target
  } finally {
    if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download }
  }
}
if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
  throw 'Existing yt-dlp differs from the pinned release. Preserve it and inspect before replacing it.'
}
$encoderList = & $FfmpegPath -hide_banner -encoders 2>&1
if ($LASTEXITCODE -ne 0 -or -not ($encoderList -match '\blibopus\b')) {
  throw 'FFmpeg must support the libopus encoder.'
}
$actualVersion = & $target --ignore-config --version
if ($LASTEXITCODE -ne 0 -or $actualVersion.Trim() -ne $version) { throw 'yt-dlp version check failed.' }
Write-Output "MUSIC_YTDLP_PATH=$target"
Write-Output "MUSIC_FFMPEG_PATH=$FfmpegPath"
Write-Output 'MUSIC_ENABLED=true'
