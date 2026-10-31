<#
.SYNOPSIS
  Exportiert alle Zephyr-for-JIRA-Daten aus der Jira-MySQL-Datenbank samt Anhängen
  als komprimierte Dateien inkl. Prüfnachweis (Zeilenzahlen, SHA-256).

.DESCRIPTION
  Wiederholbar zu jedem Zeitpunkt. Liest nur (SELECT / mysqldump --single-transaction),
  ändert nichts an der Datenbank. Der Dump wird direkt beim Lesen mit gzip komprimiert,
  es entsteht keine unkomprimierte Zwischendatei.

  Ergebnis im Ausgabeordner:
    zephyr-dump-<Zeitstempel>.sql.gz             komprimierter Dump
    zephyr-dump-<Zeitstempel>.attachments.tar.gz Anhangsdateien (attachments/<Anhang-ID>) + index.json
    zephyr-dump-<Zeitstempel>.manifest.json      Tabellen, exakte Zeilenzahlen, Anhangsbilanz, SHA-256

  Neben den AO_7DEABF_*-Tabellen werden die Zephyr-Einträge aus Jiras Eigenschaftstabellen
  (propertyentry + Werte) exportiert – dort stehen u. a. Test- und Schrittstatus.

  Anhänge: Zephyr speichert nur Metadaten in AO_7DEABF_ATTACHMENT, die Dateien liegen im Jira-Home unter
    data\attachments\<Projekt>\<schedule|teststepresult>\<Objekt-ID>\<Anhang-ID>
  Das Skript sucht zuerst exakt dort (match = exact, Größe muss stimmen). Nur wenn das scheitert, ordnet es
  über Größe + Name/ID im Anhangsverzeichnis zu (match = heuristic). Nicht gefundene Anhänge werden im
  Manifest einzeln aufgeführt (der Import meldet sie als Lücke).

  Alle Dateien gehören zusammen und werden gemeinsam übertragen.

  Kompatibel mit Windows PowerShell 2.0 (.NET 2.0/3.5) bis PowerShell 7. Deshalb bewusst ohne
  ConvertTo-Json, [ordered], ZipArchive, Stream.CopyTo und asynchrone Methoden.
  Dokumentation: docs/migration/zephyr-export.md

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\export-zephyr.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\export-zephyr.ps1 -Database jira -OutDir D:\export -JiraHome "D:\Atlassian\Application Data\JIRA"
#>
[CmdletBinding()]
param(
  # Ordner mit mysql.exe und mysqldump.exe
  [string]$MySqlBin = 'C:\Program Files\MySQL\MySQL Server 5.5\bin',
  # Name der Jira-Datenbank (siehe <jira-home>\dbconfig.xml)
  [string]$Database = 'jiradb',
  # MySQL-Benutzer mit Leserechten auf die Jira-Datenbank
  [string]$User = 'jira',
  [string]$HostName = 'localhost',
  [int]$Port = 3306,
  # Zielordner für alle Dateien
  [string]$OutDir = 'C:\temp\zephyr-export',
  # Tabellenpräfix von Zephyr for JIRA
  [string]$TablePrefix = 'AO_7DEABF_',
  # Jira-Home (enthält dbconfig.xml und data\). Ohne Angabe: automatische Suche.
  [string]$JiraHome = '',
  # Anhänge nicht exportieren
  [switch]$SkipAttachments,
  # Nur für automatisierte Tests: Passwort aus Umgebungsvariable ANEMO_EXPORT_PWD statt Abfrage
  [switch]$PasswordFromEnvironment
)

$ErrorActionPreference = 'Stop'
# Bei Fehlern die genaue Skriptstelle ausgeben (erleichtert die Fehlersuche auf dem Server).
trap { Write-Host ("FEHLERSTELLE: " + $_.InvocationInfo.PositionMessage) -ForegroundColor Red; break }
$scriptVersion = '1.4.0'

# Zephyr-Einstellungen (u. a. Test- und Schrittstatus mit Namen und Farben) liegen nicht in den
# AO_7DEABF_*-Tabellen, sondern in Jiras Eigenschaftstabellen. Exportiert werden nur Zephyr-Einträge.
$propertyFilter = "(property_key LIKE '%zephyr%' OR property_key LIKE '%thed%' OR entity_name LIKE '%zephyr%' OR entity_name LIKE '%thed%')"
$propertyValueTables = @('propertystring', 'propertytext', 'propertynumber', 'propertydecimal', 'propertydate')

# ---------------------------------------------------------------------------------------------
# Hilfsfunktionen
# ---------------------------------------------------------------------------------------------

function Resolve-Tool([string]$name) {
  foreach ($candidate in @("$name.exe", $name)) {
    $path = Join-Path $MySqlBin $candidate
    if (Test-Path -LiteralPath $path) { return $path }
  }
  throw "$name nicht gefunden in '$MySqlBin'. Bitte -MySqlBin angeben."
}

function Join-Arguments([string[]]$arguments) {
  $quoted = @()
  foreach ($a in $arguments) {
    if ($a -match '[\s"]') { $quoted += '"' + ($a -replace '"', '\"') + '"' } else { $quoted += $a }
  }
  return [string]::Join(' ', $quoted)
}

function New-MySqlProcess([string]$exe, [string[]]$arguments, [string]$password, [bool]$redirectError) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = Join-Arguments $arguments
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $redirectError
  $psi.CreateNoWindow = $true
  # Passwort nur für den Kindprozess, nicht in der Kommandozeile (wäre in der Prozessliste sichtbar).
  $psi.EnvironmentVariables['MYSQL_PWD'] = $password
  return [System.Diagnostics.Process]::Start($psi)
}

function Invoke-MySqlQuery([string]$sql, [string]$password) {
  $mysql = Resolve-Tool 'mysql'
  $p = New-MySqlProcess $mysql @('-h', $HostName, '-P', "$Port", '-u', $User, '--batch', '--skip-column-names',
    '--default-character-set=utf8', '-e', $sql, $Database) $password $true
  # Abfrageergebnisse sind klein; Fehlermeldungen von mysql ebenfalls – sequentielles Lesen ist sicher.
  $out = $p.StandardOutput.ReadToEnd()
  $err = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { throw "mysql-Fehler ($($p.ExitCode)): $err" }
  return $out
}

function Split-Lines([string]$text) {
  $result = @()
  foreach ($line in ($text -split "`r?`n")) { if ($line -ne '') { $result += $line } }
  return , $result
}

function Copy-Stream($from, $to) {
  $buffer = New-Object byte[] 1048576
  while (($n = $from.Read($buffer, 0, $buffer.Length)) -gt 0) { $to.Write($buffer, 0, $n) }
}

function Get-Sha256([string]$path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($path)
  try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLower() }
  finally { $stream.Close(); $sha.Clear() }
}

# Minimaler JSON-Serializer (ConvertTo-Json gibt es erst ab PowerShell 3.0).
function ConvertTo-JsonText($value, [string]$indent = '') {
  $next = $indent + '  '
  if ($null -eq $value) { return 'null' }
  if ($value -is [bool]) { if ($value) { return 'true' } else { return 'false' } }
  if ($value -is [int] -or $value -is [long] -or $value -is [double] -or $value -is [decimal]) {
    return ([string]$value).Replace(',', '.')
  }
  if ($value -is [string] -or $value -is [char]) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($c in ([string]$value).ToCharArray()) {
      switch ([int]$c) {
        34 { [void]$sb.Append('\"') }
        92 { [void]$sb.Append('\\') }
        10 { [void]$sb.Append('\n') }
        13 { [void]$sb.Append('\r') }
        9 { [void]$sb.Append('\t') }
        default {
          if ([int]$c -lt 32) { [void]$sb.Append(('\u{0:x4}' -f [int]$c)) } else { [void]$sb.Append($c) }
        }
      }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
  }
  if ($value -is [System.Collections.IDictionary]) {
    if ($value.Count -eq 0) { return '{}' }
    $parts = @()
    foreach ($k in @($value.Keys | Sort-Object)) {
      $parts += $next + (ConvertTo-JsonText ([string]$k)) + ': ' + (ConvertTo-JsonText $value[$k] $next)
    }
    return "{`n" + [string]::Join(",`n", $parts) + "`n$indent}"
  }
  if ($value -is [System.Collections.IEnumerable]) {
    $parts = @()
    foreach ($item in $value) { $parts += $next + (ConvertTo-JsonText $item $next) }
    if ($parts.Count -eq 0) { return '[]' }
    return "[`n" + [string]::Join(",`n", $parts) + "`n$indent]"
  }
  return ConvertTo-JsonText ([string]$value) $indent
}

function Write-Utf8File([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# --- tar (ustar) – lesbar mit tar unter macOS/Linux; benötigt keine ZIP-Bibliothek ---

function Write-TarHeader($out, [string]$name, [long]$size) {
  $h = New-Object byte[] 512
  $ascii = [System.Text.Encoding]::ASCII
  $fields = @(
    @(0, $name), @(100, '0000644'), @(108, '0000000'), @(116, '0000000'),
    @(124, [Convert]::ToString($size, 8).PadLeft(11, '0')),
    @(136, [Convert]::ToString([long](([DateTime]::UtcNow - (New-Object DateTime 1970, 1, 1, 0, 0, 0, 0)).TotalSeconds), 8).PadLeft(11, '0')),
    @(148, '        '), @(156, '0'), @(257, 'ustar'), @(263, '00'))
  foreach ($f in $fields) {
    $bytes = $ascii.GetBytes([string]$f[1])
    [System.Array]::Copy($bytes, 0, $h, [int]$f[0], $bytes.Length)
  }
  $sum = 0
  foreach ($b in $h) { $sum += $b }
  $chk = $ascii.GetBytes([Convert]::ToString($sum, 8).PadLeft(6, '0'))
  [System.Array]::Copy($chk, 0, $h, 148, 6)
  $h[154] = 0
  $h[155] = 32
  $out.Write($h, 0, 512)
}

function Write-TarPadding($out, [long]$size) {
  $rest = $size % 512
  if ($rest -ne 0) { $pad = New-Object byte[] (512 - $rest); $out.Write($pad, 0, $pad.Length) }
}

function Add-TarFile($out, [string]$name, [string]$path) {
  $file = [System.IO.File]::OpenRead($path)
  try {
    Write-TarHeader $out $name $file.Length
    Copy-Stream $file $out
    Write-TarPadding $out $file.Length
  } finally { $file.Close() }
}

function Add-TarText($out, [string]$name, [string]$text) {
  $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($text)
  Write-TarHeader $out $name $bytes.Length
  $out.Write($bytes, 0, $bytes.Length)
  Write-TarPadding $out $bytes.Length
}

# --- Jira-Home und Anhänge ---

function Find-JiraHome {
  if ($JiraHome) {
    if (-not (Test-Path -LiteralPath (Join-Path $JiraHome 'data'))) { throw "Kein Ordner 'data' unter -JiraHome '$JiraHome'." }
    return $JiraHome
  }
  $candidates = @()
  if ($env:JIRA_HOME) { $candidates += $env:JIRA_HOME }
  # jira.home steht in <Installationsordner>\atlassian-jira\WEB-INF\classes\jira-application.properties
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, 'C:\Program Files\Atlassian', 'C:\Atlassian', 'D:\Atlassian', 'E:\Atlassian')
  $patterns = @('*\atlassian-jira\WEB-INF\classes\jira-application.properties', '*\*\atlassian-jira\WEB-INF\classes\jira-application.properties')
  foreach ($root in $roots) {
    if (-not $root) { continue }
    foreach ($pattern in $patterns) {
      foreach ($props in @(Get-ChildItem -Path (Join-Path $root $pattern) -ErrorAction SilentlyContinue)) {
        foreach ($line in @(Get-Content -LiteralPath $props.FullName)) {
          if ($line -match '^\s*jira\.home\s*=\s*(.+)$') { $candidates += ($matches[1].Trim() -replace '\\\\', '\' -replace '\\:', ':') }
        }
      }
    }
  }
  $candidates += @('C:\Program Files\Atlassian\Application Data\JIRA', 'C:\Atlassian\Application Data\JIRA', 'E:\Atlassian\Application Data\JIRA')
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath (Join-Path $c 'dbconfig.xml'))) { return $c }
  }
  return $null
}

function Export-Attachments([string]$table, [string]$tarPath, [string]$password) {
  $info = @{ jiraHome = $null; searchRoots = @(); expected = 0; found = 0; exact = 0; heuristic = 0; missing = @(); archiveFile = $null; archiveBytes = 0; archiveSha256 = $null }
  $meta = @()
  foreach ($line in (Split-Lines (Invoke-MySqlQuery "SELECT ID, TYPE, ENTITY_ID, IFNULL(FILESIZE,-1), FILE_NAME FROM ``$table`` ORDER BY ID" $password))) {
    $f = $line -split "`t", 5
    $meta += New-Object PSObject -Property @{ Id = $f[0]; Type = $f[1]; EntityId = $f[2]; Size = [long]$f[3]; Name = $f[4] }
  }
  $info.expected = $meta.Count
  if ($meta.Count -eq 0) { return $info }

  $jiraHomeDir = Find-JiraHome
  if (-not $jiraHomeDir) {
    Write-Warning 'Jira-Home nicht gefunden - Anhänge werden nicht exportiert. Bitte -JiraHome angeben.'
    $missing = @()
    foreach ($a in $meta) { $missing += @{ id = $a.Id; type = $a.Type; entityId = $a.EntityId; fileName = $a.Name; size = $a.Size; reason = 'Jira-Home nicht gefunden' } }
    $info.missing = $missing
    return $info
  }
  $info.jiraHome = $jiraHomeDir
  $attachmentRoot = Join-Path (Join-Path $jiraHomeDir 'data') 'attachments'
  $info.searchRoots = @($attachmentRoot)
  Write-Host "Suche $($meta.Count) Anhänge unter: $attachmentRoot ..."

  # Rückfall-Index (Größe -> Dateien) wird nur aufgebaut, wenn ein Anhang nicht am erwarteten Ort liegt.
  $bySize = $null
  $sep = [regex]::Escape([string][System.IO.Path]::DirectorySeparatorChar)
  $index = @()
  $missing = @()
  $exact = 0
  $heuristic = 0
  $fileStream = [System.IO.File]::Create($tarPath)
  try {
    $gzip = New-Object System.IO.Compression.GZipStream($fileStream, [System.IO.Compression.CompressionMode]::Compress)
    try {
      foreach ($a in $meta) {
        # 1) Exakter Zephyr-Ablageort: attachments\<Projekt>\<typ>\<Objekt-ID>\<Anhang-ID>
        $pattern = Join-Path (Join-Path (Join-Path (Join-Path $attachmentRoot '*') $a.Type.ToLower()) $a.EntityId) $a.Id
        $match = @(Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Where-Object { -not $_.PSIsContainer -and $_.Length -eq $a.Size })
        $how = 'exact'
        if ($match.Count -ne 1) {
          # 2) Rückfall: Größe + Name bzw. Anhang-ID im gesamten Anhangsverzeichnis
          $how = 'heuristic'
          if ($null -eq $bySize) {
            Write-Host 'Nicht alle Anhänge am Zephyr-Ablageort - durchsuche das Anhangsverzeichnis ...'
            $bySize = @{}
            foreach ($file in @(Get-ChildItem -LiteralPath $attachmentRoot -Recurse -ErrorAction SilentlyContinue | Where-Object { -not $_.PSIsContainer })) {
              $key = [string]$file.Length
              if (-not $bySize.ContainsKey($key)) { $bySize[$key] = New-Object System.Collections.ArrayList }
              [void]$bySize[$key].Add($file)
            }
          }
          $candidates = @()
          if ($bySize.ContainsKey([string]$a.Size)) { $candidates = $bySize[[string]$a.Size].ToArray() }
          $match = @($candidates | Where-Object { $_.Name -eq $a.Name -or $_.Name -eq $a.Id -or $_.Name -like "$($a.Id)_*" })
          if ($match.Count -gt 1) {
            $narrow = @($match | Where-Object { $_.FullName -match "$sep$($a.EntityId)$sep" -or $_.Name -eq $a.Id -or $_.Name -like "$($a.Id)_*" })
            if ($narrow.Count -ge 1) { $match = $narrow }
          }
        }
        if ($match.Count -eq 1) {
          if ($how -eq 'exact') { $exact++ } else { $heuristic++ }
          $entry = "attachments/$($a.Id)"
          Add-TarFile $gzip $entry $match[0].FullName
          $index += @{ id = $a.Id; type = $a.Type; entityId = $a.EntityId; fileName = $a.Name; size = $a.Size; entry = $entry; match = $how
            sourcePath = $match[0].FullName.Substring($jiraHomeDir.Length).TrimStart('\', '/') }
        } else {
          if ($match.Count -eq 0) { $reason = 'nicht gefunden' } else { $reason = "mehrdeutig ($($match.Count) Kandidaten)" }
          $missing += @{ id = $a.Id; type = $a.Type; entityId = $a.EntityId; fileName = $a.Name; size = $a.Size; reason = $reason }
        }
      }
      Add-TarText $gzip 'index.json' (ConvertTo-JsonText $index)
      $end = New-Object byte[] 1024
      $gzip.Write($end, 0, $end.Length)
    } finally { $gzip.Close() }
  } finally { $fileStream.Close() }

  $info.exact = $exact
  $info.heuristic = $heuristic
  $info.found = $index.Count
  $info.missing = $missing
  $info.archiveFile = [System.IO.Path]::GetFileName($tarPath)
  $info.archiveBytes = (Get-Item -LiteralPath $tarPath).Length
  $info.archiveSha256 = Get-Sha256 $tarPath
  return $info
}

# ---------------------------------------------------------------------------------------------
# Ablauf
# ---------------------------------------------------------------------------------------------

if ($PasswordFromEnvironment) {
  $password = $env:ANEMO_EXPORT_PWD
} else {
  $secure = Read-Host "MySQL-Passwort für Benutzer '$User'" -AsSecureString
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $password = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$started = Get-Date
$stamp = $started.ToString('yyyyMMdd-HHmmss')
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$dumpPath = Join-Path $OutDir "zephyr-dump-$stamp.sql.gz"
$manifestPath = Join-Path $OutDir "zephyr-dump-$stamp.manifest.json"
$errorLog = Join-Path $OutDir "zephyr-dump-$stamp.mysqldump-errors.log"

# ---- 1. Tabellen und exakte Zeilenzahlen ----
Write-Host "Verbinde mit $User@$($HostName):$Port/$Database ..."
$version = (Invoke-MySqlQuery 'SELECT VERSION()' $password).Trim()
$likePattern = ($TablePrefix -replace '_', '\_') + '%'
$tables = Split-Lines (Invoke-MySqlQuery "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE '$likePattern' ORDER BY table_name" $password)
if ($tables.Count -eq 0) {
  throw "Keine Tabellen mit Präfix '$TablePrefix' in Datenbank '$Database' gefunden. Stimmt -Database?"
}
Write-Host "MySQL $version - $($tables.Count) Zephyr-Tabellen gefunden. Zähle Zeilen ..."

# COUNT(*) statt information_schema.TABLE_ROWS: InnoDB liefert dort nur Schätzwerte.
$countParts = @()
foreach ($t in $tables) { $countParts += "SELECT '$t', COUNT(*) FROM ``$t``" }
$rows = @{}
foreach ($line in (Split-Lines (Invoke-MySqlQuery ([string]::Join(' UNION ALL ', $countParts)) $password))) {
  $parts = $line -split "`t"
  $rows[$parts[0]] = [long]$parts[1]
}

# Zephyr-Einstellungen in Jiras Eigenschaftstabellen (nur vorhandene Tabellen)
$valueList = "'" + [string]::Join("','", $propertyValueTables) + "'"
$existing = Split-Lines (Invoke-MySqlQuery "SELECT LOWER(table_name) FROM information_schema.tables WHERE table_schema = DATABASE() AND LOWER(table_name) IN ('propertyentry',$valueList)" $password)
$propertyDumps = @()
if ($existing -contains 'propertyentry') {
  $propertyDumps += , @('propertyentry', $propertyFilter)
  foreach ($t in $propertyValueTables) {
    if ($existing -contains $t) { $propertyDumps += , @($t, "id IN (SELECT id FROM propertyentry WHERE $propertyFilter)") }
  }
  foreach ($pd in $propertyDumps) {
    $rows[$pd[0]] = [long](Invoke-MySqlQuery "SELECT COUNT(*) FROM ``$($pd[0])`` WHERE $($pd[1])" $password).Trim()
  }
  Write-Host "Zephyr-Einstellungen: $($rows['propertyentry']) Einträge in Jiras Eigenschaftstabellen."
} else {
  Write-Warning 'Tabelle propertyentry nicht gefunden - Statusdefinitionen werden nicht exportiert.'
}
$totalRows = 0
foreach ($v in $rows.Values) { $totalRows += $v }

# ---- 2. Dump, direkt gzip-komprimiert (mehrere mysqldump-Läufe in einen gzip-Strom) ----
Write-Host "Exportiere $totalRows Zeilen nach $dumpPath ..."
$mysqldump = Resolve-Tool 'mysqldump'
# Fehlermeldungen von mysqldump gehen in eine Datei (--log-error); so muss stderr nicht parallel gelesen werden.
$baseArgs = @('-h', $HostName, '-P', "$Port", '-u', $User, '--single-transaction', '--quick', '--hex-blob',
  '--default-character-set=utf8', '--skip-comments', '--skip-dump-date', "--log-error=$errorLog")

function Write-DumpTo($gzip, [string[]]$arguments) {
  $p = New-MySqlProcess $mysqldump $arguments $password $false
  Copy-Stream $p.StandardOutput.BaseStream $gzip
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) {
    $detail = ''
    if (Test-Path -LiteralPath $errorLog) { $detail = [System.IO.File]::ReadAllText($errorLog) }
    if (-not $detail) { $detail = "keine Details von mysqldump (Fehlerprotokoll $errorLog leer oder nicht beschreibbar)" }
    throw "mysqldump-Fehler ($($p.ExitCode)): $detail"
  }
}

$file = [System.IO.File]::Create($dumpPath)
$ok = $false
try {
  $gzip = New-Object System.IO.Compression.GZipStream($file, [System.IO.Compression.CompressionMode]::Compress)
  try {
    Write-DumpTo $gzip ($baseArgs + @($Database) + $tables)
    foreach ($pd in $propertyDumps) {
      Write-DumpTo $gzip ($baseArgs + @("--where=$($pd[1])", $Database, $pd[0]))
    }
    $ok = $true
  } finally { $gzip.Close() }
} finally {
  $file.Close()
  if (-not $ok) { Remove-Item -LiteralPath $dumpPath -ErrorAction SilentlyContinue }
}
if ((Test-Path -LiteralPath $errorLog) -and ((Get-Item -LiteralPath $errorLog).Length -eq 0)) { Remove-Item -LiteralPath $errorLog }

# ---- 3. Anhänge (Dateien aus dem Jira-Home) ----
$attachmentInfo = $null
$attachmentTable = $null
foreach ($t in $tables) { if ($t -match "(?i)^$([regex]::Escape($TablePrefix))ATTACHMENT$") { $attachmentTable = $t } }
if ($SkipAttachments) {
  Write-Host 'Anhänge übersprungen (-SkipAttachments).'
} elseif ($attachmentTable) {
  $attachmentInfo = Export-Attachments $attachmentTable (Join-Path $OutDir "zephyr-dump-$stamp.attachments.tar.gz") $password
  Write-Host "Anhänge: $($attachmentInfo.found) von $($attachmentInfo.expected) gefunden ($($attachmentInfo.exact) exakt am Zephyr-Ablageort, $($attachmentInfo.heuristic) über Rückfallsuche)."
  if ($attachmentInfo.missing.Count -gt 0) { Write-Warning "$($attachmentInfo.missing.Count) Anhänge fehlen - Details im Manifest (attachments.missing)." }
}
$password = $null

# ---- 4. Manifest (Prüfnachweis für den Import) ----
$size = (Get-Item -LiteralPath $dumpPath).Length
$manifest = @{
  format          = 'anemo-zephyr-db-dump/1'
  scriptVersion   = $scriptVersion
  powershell      = [string]$PSVersionTable.PSVersion
  createdAt       = $started.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  durationSeconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  host            = [string]$env:COMPUTERNAME
  mysqlVersion    = $version
  database        = $Database
  tablePrefix     = $TablePrefix
  dumpFile        = [System.IO.Path]::GetFileName($dumpPath)
  dumpBytes       = $size
  dumpSha256      = Get-Sha256 $dumpPath
  totalRows       = $totalRows
  tables          = $rows
  attachments     = $attachmentInfo
}
Write-Utf8File $manifestPath (ConvertTo-JsonText $manifest)

Write-Host ''
Write-Host "Fertig in $($manifest.durationSeconds) s:"
Write-Host ("  {0}  ({1:N1} MB, {2} Tabellen, {3} Zeilen)" -f $dumpPath, ($size / 1MB), $rows.Count, $totalRows)
if ($attachmentInfo -and $attachmentInfo.archiveFile) {
  Write-Host ("  {0}  ({1:N1} MB, {2} von {3} Anhängen)" -f (Join-Path $OutDir $attachmentInfo.archiveFile), ($attachmentInfo.archiveBytes / 1MB), $attachmentInfo.found, $attachmentInfo.expected)
}
Write-Host "  $manifestPath"
Write-Host ''
Write-Host 'Alle Dateien nach <Anemo>/migration-snapshots/ kopieren und dort laden mit:'
Write-Host "  npm run zephyr:load -- --manifest migration-snapshots/$([System.IO.Path]::GetFileName($manifestPath))"
