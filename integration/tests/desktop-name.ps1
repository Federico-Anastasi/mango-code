# Prints the name of the Windows desktop this process runs on ("Default" is the one on the screen), then exits with
# the code it is given: what `off-screen.test.ts` runs through `off-screen`.
param([int]$ExitCode = 0)
Add-Type -Namespace Mango -Name Desktop -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint thread);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformationW(IntPtr handle, int index, System.Text.StringBuilder info, int length, out int needed);
'@
$name = New-Object System.Text.StringBuilder 256
$needed = 0
[void][Mango.Desktop]::GetUserObjectInformationW([Mango.Desktop]::GetThreadDesktop([Mango.Desktop]::GetCurrentThreadId()), 2, $name, 512, [ref]$needed)
Write-Output $name.ToString()
exit $ExitCode
