# Read-only metadata collector. Does not open SQLite, read keys or copy messages.
param(
    [Parameter(Mandatory = $true)]
    [string]$AccountDir
)
$ErrorActionPreference = 'Stop'
$selected = Get-Item -LiteralPath $AccountDir
if (-not $selected.PSIsContainer) { throw 'Select the account directory containing db_storage.' }
$root = if ($selected.Name -ieq 'db_storage') { $selected.FullName } else { Join-Path $selected.FullName 'db_storage' }
$root = (Get-Item -LiteralPath $root).FullName.TrimEnd('\', '/')
$files = [System.Collections.Generic.List[object]]::new()
$errors = [System.Collections.Generic.List[object]]::new()
$directories = [System.Collections.Generic.List[string]]::new()
$state = @{ Visited = 0; Truncated = $false }
function Get-RelativeName([string]$FullName) {
    return $FullName.Substring($root.Length).TrimStart('\', '/')
}
function Read-DirectoryMetadata([string]$Directory, [int]$Depth) {
    try { $entries = @(Get-ChildItem -LiteralPath $Directory -Force -ErrorAction Stop) }
    catch {
        $errors.Add(@{ path = (Get-RelativeName $Directory); errorType = $_.Exception.GetType().Name })
        return
    }
    foreach ($entry in $entries) {
        $state.Visited++
        if ($state.Visited -gt 2000) { $state.Truncated = $true; return }
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        if ($entry.PSIsContainer) {
            $directories.Add((Get-RelativeName $entry.FullName))
            if ($Depth -lt 3) { Read-DirectoryMetadata $entry.FullName ($Depth + 1) }
            else { $state.Truncated = $true }
        } elseif ($entry.Extension -ieq '.db') {
            $walBytes = 0
            $wal = Get-Item -LiteralPath ($entry.FullName + '-wal') -ErrorAction SilentlyContinue
            if ($wal) { $walBytes = $wal.Length }
            $files.Add([ordered]@{
                path = (Get-RelativeName $entry.FullName)
                bytes = $entry.Length
                modifiedUtc = $entry.LastWriteTimeUtc.ToString('o')
                walBytes = $walBytes
                messageShardCandidate = ($entry.Name -imatch '^(message|msg)_\d+\.db$')
            })
        }
        if ($state.Visited -gt 2000) { return }
    }
}
Read-DirectoryMetadata $root 0
[ordered]@{
    collectedAtUtc = [DateTime]::UtcNow.ToString('o')
    databaseFileCount = $files.Count
    messageShardCandidateCount = @($files | Where-Object { $_.messageShardCandidate }).Count
    directories = @($directories.ToArray())
    files = @($files.ToArray())
    errors = @($errors.ToArray())
    truncated = $state.Truncated
    note = 'Metadata only. Candidate names are a heuristic; no database readability or key validation was performed.'
} | ConvertTo-Json -Depth 6
