param(
    [Parameter(Mandatory = $true)][ValidateSet("shot", "click", "type", "key", "info")][string]$Action,
    [string]$Out,
    [string]$Text,
    [double]$X = 0.5,
    [double]$Y = 0.5,
    [int]$Wait = 2
)

# Drives the window of the installed app: brings it to the front, clicks at a relative point
# (fractions of the window, so the coordinates hold at any size), types with
# SendKeys and takes a picture with PrintWindow (works even with the window covered).
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Ui {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, IntPtr e);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
# Without this the process sees "virtual" coordinates (Windows scaling) while PrintWindow draws
# in physical pixels: the image comes out cut off on the right and at the bottom. It is not an app defect.
[Ui]::SetProcessDPIAware() | Out-Null

# Windows denies SetForegroundWindow to whoever is not already in the foreground: a fake ALT unlocks the permission.
function BringToFront([IntPtr]$h) {
    [Ui]::ShowWindow($h, 9) | Out-Null
    [Ui]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
    [Ui]::SetForegroundWindow($h) | Out-Null
    [Ui]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 800
}

$p = Get-Process mango-code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object -First 1
if (-not $p) {
    $p = Get-Process mango-code -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $p) { Write-Output "no mango-code process"; exit 1 }
    Write-Output "mango-code process without a window (pid $($p.Id))"
    if ($Action -ne "info") { exit 1 }
}
$h = $p.MainWindowHandle
$r = New-Object Ui+RECT
[Ui]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$hh = $r.Bottom - $r.Top
Write-Output ("window: {0} x {1}  title={2}" -f $w, $hh, $p.MainWindowTitle)

switch ($Action) {
    "info" { }
    "click" {
        BringToFront $h
        $px = [int]($r.Left + $w * $X)
        $py = [int]($r.Top + $hh * $Y)
        [Ui]::SetCursorPos($px, $py) | Out-Null
        Start-Sleep -Milliseconds 200
        [Ui]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
        [Ui]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
        Write-Output "click at $px,$py (X=$X Y=$Y)"
    }
    "type" {
        BringToFront $h
        [System.Windows.Forms.SendKeys]::SendWait($Text)
        Write-Output "typed: $Text"
    }
    "key" {
        BringToFront $h
        [System.Windows.Forms.SendKeys]::SendWait($Text)
        Write-Output "key: $Text"
    }
    "shot" {
        Start-Sleep -Seconds $Wait
        $bmp = New-Object System.Drawing.Bitmap $w, $hh
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        $ok = [Ui]::PrintWindow($h, $hdc, 2)
        $g.ReleaseHdc($hdc)
        $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        Write-Output "printwindow=$ok visible=$([Ui]::IsWindowVisible($h)) -> $Out"
    }
}
