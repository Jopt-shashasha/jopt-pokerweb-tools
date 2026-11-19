$ErrorActionPreference = 'Stop'
$archiveRoot = 'D:/JOPT work/業務ポータル/旧ファイル/DROP/2026-11-17'
$archivePlan = Get-Content -Raw -LiteralPath "$archiveRoot/download-plan.json" | ConvertFrom-Json
$packageRoot = Join-Path $archiveRoot 'packages'
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$packages = @()
foreach ($document in $archivePlan.documents) {
    if ($document.files.Count -le 1 -or @($document.files | Where-Object status -ne 'verified').Count) { continue }
    $originalFiles = @()
    foreach ($file in $document.files) {
        $resolvedTarget = [IO.Path]::GetFullPath($file.target)
        if (-not $resolvedTarget.StartsWith([IO.Path]::GetFullPath($archiveRoot) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'File escapes archive root' }
        if ($file.path -match '(^/|\\|(^|/)\.\.(/|$))') { throw 'Unsafe ZIP entry' }
        $actual = Get-Item -LiteralPath $resolvedTarget
        if ($actual.Length -ne $file.bytes -or (Get-FileHash -LiteralPath $resolvedTarget -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Original file changed: $($file.path)" }
        $originalFiles += @{filename=$file.path;path=$resolvedTarget;bytes=$file.bytes;sha256=$file.sha256}
    }
    $safeTitle = ($document.title -replace '[<>:"/\\|?*\x00-\x1f]', '_')
    if ($safeTitle.Length -gt 60) { $safeTitle = $safeTitle.Substring(0,60) }
    $filename = "$($document.source_id)-$safeTitle.zip"
    $packagePath = Join-Path $packageRoot $filename
    if (-not (Test-Path -LiteralPath $packagePath)) {
        $zip = [IO.Compression.ZipFile]::Open($packagePath, [IO.Compression.ZipArchiveMode]::Create)
        try { foreach ($file in $originalFiles) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file.path,$file.filename,[IO.Compression.CompressionLevel]::Optimal) | Out-Null } }
        finally { $zip.Dispose() }
    }
    $zip = [IO.Compression.ZipFile]::OpenRead($packagePath)
    try {
        if ($zip.Entries.Count -ne $originalFiles.Count) { throw 'ZIP entry count differs' }
        foreach ($file in $originalFiles) {
            $entry = $zip.GetEntry($file.filename)
            if (-not $entry -or $entry.Length -ne $file.bytes) { throw 'ZIP entry differs' }
            $stream = $entry.Open(); $sha = [Security.Cryptography.SHA256]::Create()
            try { $hash = [Convert]::ToHexString($sha.ComputeHash($stream)).ToLowerInvariant() }
            finally { $stream.Dispose(); $sha.Dispose() }
            if ($hash -ne $file.sha256) { throw 'ZIP content differs from original' }
        }
    } finally { $zip.Dispose() }
    $entryFile = $originalFiles | Where-Object filename -eq $document.entry_path
    if (-not $entryFile) { throw 'Entry HTML missing' }
    $packages += @{source_id=$document.source_id;resource_id=$document.resource_id;title=$document.title;path=$packagePath;filename=$filename;bytes=(Get-Item -LiteralPath $packagePath).Length;sha256=(Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant();artifact_type='folder-zip';entry_filename=$document.entry_path;entry_path=$entryFile.path;original_files=$originalFiles;private=($document.source_state -ne 'shared' -or $document.source_visibility -ne 'public');creator_email=$document.creator_email}
}
$manifestPath = Join-Path $packageRoot 'packages.json'
@{records=@($packages)} | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
@{packages=$packages.Count;files=($packages | ForEach-Object {$_.original_files.Count} | Measure-Object -Sum).Sum;manifest=$manifestPath} | ConvertTo-Json -Compress
