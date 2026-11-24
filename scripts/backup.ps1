#requires -Version 7.0
<#
  Export a LINKED Supabase project and encrypt each stream with age.
  Requires official Supabase CLI executable, Docker and age. No plaintext dump is written.
  SUPABASE_DB_PASSWORD (and SUPABASE_ACCESS_TOKEN for unattended CLI) must come from a secret store.
  This exports DATABASE DATA, including Auth hashes. Storage FILES and Bunny originals are separate.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^age1[0-9a-z]+$')][string]$Recipient,
    [Parameter(Mandatory)][string]$DestinationDirectory
)
$ErrorActionPreference = 'Stop'
$projectDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destination = [IO.Path]::GetFullPath($DestinationDirectory)
if ($destination.StartsWith($projectDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $destination -eq $projectDirectory) {
    throw 'Escolha uma pasta de backup fora do projeto e fora do diretório publicado.'
}
if (-not $env:SUPABASE_DB_PASSWORD) { throw 'Defina SUPABASE_DB_PASSWORD por um gerenciador de segredos.' }
$supabaseCommand = Get-Command supabase -CommandType Application -ErrorAction Stop
$ageCommand = Get-Command age -CommandType Application -ErrorAction Stop
if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory 'supabase/.temp/project-ref'))) {
    throw 'Vincule primeiro o projeto correto com supabase link --project-ref. Confira o ambiente.'
}
$backupDirectory = Join-Path $destination ('biblioteca-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
[IO.Directory]::CreateDirectory($backupDirectory) | Out-Null

function Export-EncryptedStream([string]$Name, [string[]]$DumpArguments) {
    $partialPath = Join-Path $backupDirectory ($Name + '.sql.age.partial')
    $finalPath = Join-Path $backupDirectory ($Name + '.sql.age')
    $exportInfo = [Diagnostics.ProcessStartInfo]::new()
    $exportInfo.FileName = $supabaseCommand.Source
    $exportInfo.WorkingDirectory = $projectDirectory
    $exportInfo.UseShellExecute = $false
    $exportInfo.CreateNoWindow = $true
    $exportInfo.RedirectStandardOutput = $true
    $exportInfo.RedirectStandardError = $true
    foreach ($argument in $DumpArguments) { $exportInfo.ArgumentList.Add($argument) }
    $encryptInfo = [Diagnostics.ProcessStartInfo]::new()
    $encryptInfo.FileName = $ageCommand.Source
    $encryptInfo.UseShellExecute = $false
    $encryptInfo.CreateNoWindow = $true
    $encryptInfo.RedirectStandardInput = $true
    $encryptInfo.RedirectStandardError = $true
    foreach ($argument in @('--recipient',$Recipient,'--output',$partialPath)) { $encryptInfo.ArgumentList.Add($argument) }
    $exportProcess = [Diagnostics.Process]::new()
    $exportProcess.StartInfo = $exportInfo
    $encryptProcess = [Diagnostics.Process]::new()
    $encryptProcess.StartInfo = $encryptInfo
    $exportStarted = $false
    $encryptStarted = $false
    try {
        $encryptProcess.Start() | Out-Null
        $encryptStarted = $true
        $exportProcess.Start() | Out-Null
        $exportStarted = $true
        # Drain stderr in memory to avoid deadlocks; never print CLI errors containing credentials.
        $exportErrorTask = $exportProcess.StandardError.ReadToEndAsync()
        $encryptErrorTask = $encryptProcess.StandardError.ReadToEndAsync()
        $exportProcess.StandardOutput.BaseStream.CopyTo($encryptProcess.StandardInput.BaseStream)
        $encryptProcess.StandardInput.Close()
        $exportProcess.WaitForExit()
        $encryptProcess.WaitForExit()
        $null = $exportErrorTask.GetAwaiter().GetResult()
        $null = $encryptErrorTask.GetAwaiter().GetResult()
        if ($exportProcess.ExitCode -ne 0 -or $encryptProcess.ExitCode -ne 0) {
            throw "Exportação $Name falhou. Consulte localmente os fornecedores sem publicar segredos."
        }
        if ((Get-Item -LiteralPath $partialPath).Length -lt 100) { throw "Backup $Name vazio." }
        Move-Item -LiteralPath $partialPath -Destination $finalPath
        return (Get-FileHash -LiteralPath $finalPath -Algorithm SHA256 | Select-Object @{Name='file';Expression={[IO.Path]::GetFileName($_.Path)}},Hash)
    } finally {
        if ($exportStarted -and -not $exportProcess.HasExited) { $exportProcess.Kill($true) }
        if ($encryptStarted -and -not $encryptProcess.HasExited) { $encryptProcess.Kill($true) }
        $exportProcess.Dispose()
        $encryptProcess.Dispose()
        if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath }
    }
}

$manifest = @()
$manifest += Export-EncryptedStream 'roles' @('db','dump','--linked','--role-only')
$manifest += Export-EncryptedStream 'schema' @('db','dump','--linked')
$manifest += Export-EncryptedStream 'data' @('db','dump','--linked','--use-copy','--data-only','-x','storage.buckets_vectors','-x','storage.vector_indexes')
$manifest += Export-EncryptedStream 'history-schema' @('db','dump','--linked','--schema','supabase_migrations')
$manifest += Export-EncryptedStream 'history-data' @('db','dump','--linked','--use-copy','--data-only','--schema','supabase_migrations')
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupDirectory 'checksums.json') -Encoding utf8
Write-Output "Exportação de banco criptografada concluída: $backupDirectory"
Write-Output 'Copie para um segundo destino e execute o teste de restauração. Objetos Storage/Bunny e configurações NÃO foram copiados.'
