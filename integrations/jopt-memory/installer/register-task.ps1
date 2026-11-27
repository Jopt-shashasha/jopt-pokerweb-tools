param(
    [Parameter(Mandatory = $true)][string]$PythonExe,
    [Parameter(Mandatory = $true)][string]$Runner,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$name = 'JOPT Memory Upload ' + $identity.User.Value
$arguments = '"{0}" --state "{1}" --upload' -f $Runner, $WorkingDirectory
$action = New-ScheduledTaskAction -Execute $PythonExe -Argument $arguments -WorkingDirectory $WorkingDirectory
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$task = New-ScheduledTask -Action $action -Trigger @($repeat, $logon) -Principal $principal -Settings $settings -Description 'JOPT Memory signed-in user, one-way batch export to the configured company Drive folder.'
if ($ValidateOnly) {
    [pscustomobject]@{ TaskName=$name; Repeat=$repeat.Repetition.Interval; Triggers=@($task.Triggers).Count; Action=$action.Arguments }
    return
}
Register-ScheduledTask -TaskName $name -InputObject $task -Force | Out-Null
Write-Output $name
