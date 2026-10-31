<#
  Prüft ein Skript statisch auf Sprachmittel, die es unter Windows PowerShell 2.0 / .NET 2.0–3.5
  nicht gibt (der Jira-Server läuft mit PowerShell 2.0). Analysiert den Syntaxbaum, nicht den Text,
  damit Kommentare und Zeichenketten keine Fehlalarme auslösen.

  pwsh -NoProfile -File tools/windows/check-ps2-compat.ps1 tools/windows/export-zephyr.ps1
#>
param([Parameter(Mandatory = $true)][string]$Path)

$forbiddenCommands = @('ConvertTo-Json', 'ConvertFrom-Json', 'Compress-Archive', 'Expand-Archive', 'Get-FileHash',
  'Invoke-RestMethod', 'Invoke-WebRequest', 'New-TemporaryFile', 'Get-CimInstance', 'Write-Information')
$forbiddenMembers = @('ReadToEndAsync', 'ReadLineAsync', 'CopyTo', 'CopyToAsync', 'WriteAsync', 'ReadAsync',
  'CreateEntryFromFile', 'ExtractToDirectory', 'new', 'HasFlag', 'IsNullOrWhiteSpace', 'Dispose')
$forbiddenTypes = @('ordered', 'pscustomobject', 'System.IO.Compression.ZipArchive', 'System.IO.Compression.ZipFile',
  'System.IO.Compression.ZipFileExtensions', 'System.IO.Compression.CompressionLevel', 'System.Threading.Tasks.Task')
$forbiddenParameters = @('Depth', 'File', 'Directory', 'AsHashtable', 'Raw', 'NoNewline', 'Parallel')

$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Path), [ref]$tokens, [ref]$errors)
if ($errors.Count) { $errors | ForEach-Object { Write-Host "Syntaxfehler: $($_.Message) (Zeile $($_.Extent.StartLineNumber))" }; exit 1 }

$problems = New-Object System.Collections.ArrayList
$ast.FindAll({ $true }, $true) | ForEach-Object {
  $n = $_
  $line = $n.Extent.StartLineNumber
  switch ($n.GetType().Name) {
    'CommandAst' {
      $name = $n.GetCommandName()
      if ($forbiddenCommands -contains $name) { [void]$problems.Add("Zeile ${line}: Kommando $name") }
      if ($name -eq 'Get-ChildItem' -or $name -eq 'Get-Content' -or $name -eq 'Out-File') {
        foreach ($e in $n.CommandElements) {
          if ($e -is [System.Management.Automation.Language.CommandParameterAst] -and $forbiddenParameters -contains $e.ParameterName) {
            [void]$problems.Add("Zeile ${line}: Parameter -$($e.ParameterName) bei $name")
          }
        }
      }
    }
    { $_ -in 'MemberExpressionAst', 'InvokeMemberExpressionAst' } {
      $m = $n.Member.Value
      if ($m -and $forbiddenMembers -contains $m) { [void]$problems.Add("Zeile ${line}: Methode/Eigenschaft .$m") }
    }
    { $_ -in 'TypeExpressionAst', 'TypeConstraintAst', 'ConvertExpressionAst' } {
      $t = $n.TypeName.FullName
      if ($forbiddenTypes -contains $t) { [void]$problems.Add("Zeile ${line}: Typ [$t]") }
    }
  }
}
# Klassen-, Enum- und using-Anweisungen gibt es erst ab PowerShell 5
if ($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.TypeDefinitionAst] -or $args[0] -is [System.Management.Automation.Language.UsingStatementAst] }, $true).Count) {
  [void]$problems.Add('class/enum/using (erst ab PowerShell 5)')
}

if ($problems.Count) {
  Write-Host "Nicht PowerShell-2.0-kompatibel ($Path):"
  $problems | Sort-Object -Unique | ForEach-Object { Write-Host "  $_" }
  exit 1
}
Write-Host "PowerShell-2.0-Prüfung bestanden: $Path"
