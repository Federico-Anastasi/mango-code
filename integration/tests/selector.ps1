param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [string]$Path = "",
    [switch]$Cancel,
    [int]$Wait = 30
)

# Answers the Windows dialog opened by process $ProcessId (the tests' app, never another one).
# Folder picker: writes the path in the "Folder" field and presses "Select folder", or presses "Cancel".
# Message (without -Path): writes its text and presses "OK". Writes to the terminal the window title and the text of
# the button pressed; exits with 1 if the window does not appear.
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Picker {
  delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, Cb cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, string l);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);

  static string ClassOf(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  static string TextOf(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }

  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && ClassOf(h) == "#32770") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string Title(IntPtr d) { return TextOf(d); }

  /// The text field of the folder name: the last visible "Edit" of the picker.
  static IntPtr Field(IntPtr d) {
    IntPtr field = IntPtr.Zero;
    EnumChildWindows(d, (h, l) => { if (ClassOf(h) == "Edit" && IsWindowVisible(h)) field = h; return true; }, IntPtr.Zero);
    return field;
  }
  /// A button by control id: 1 = IDOK ("Select folder"), 2 = IDCANCEL.
  static IntPtr Button(IntPtr d, int id) {
    IntPtr b = IntPtr.Zero;
    EnumChildWindows(d, (h, l) => { if (ClassOf(h) == "Button" && GetDlgCtrlID(h) == id) b = h; return true; }, IntPtr.Zero);
    return b;
  }
  public static string Press(IntPtr d, string path, bool cancel) {
    if (!cancel && path.Length > 0) {
      var c = Field(d);
      if (c == IntPtr.Zero) return "field not found";
      SendMessage(c, 0x000C, IntPtr.Zero, path); // WM_SETTEXT
    }
    var b = Button(d, cancel ? 2 : 1);
    if (b == IntPtr.Zero) return "button not found";
    var name = TextOf(b);
    SendMessage(b, 0x00F5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK
    return name;
  }
}
"@

$deadline = (Get-Date).AddSeconds($Wait)
$d = [IntPtr]::Zero
while ($d -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
    $d = [Picker]::Find([uint32]$ProcessId)
    if ($d -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
}
if ($d -eq [IntPtr]::Zero) { Write-Output "picker did not appear"; exit 1 }
Start-Sleep -Milliseconds 700
Write-Output ("picker: " + [Picker]::Title($d))
if ($Path -ne "" -or $Cancel) {
    Write-Output ("pressed: " + [Picker]::Press($d, $Path, [bool]$Cancel))
    exit 0
}
# An app message is a TaskDialog: text and button are not Windows windows but UI Automation elements.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle($d)
$elements = { param($type) $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type))) }
Write-Output ("text: " + ((& $elements ([System.Windows.Automation.ControlType]::Text) | ForEach-Object { $_.Current.Name }) -join " "))
$ok = (& $elements ([System.Windows.Automation.ControlType]::Button))[0]
$ok.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Write-Output ("pressed: " + $ok.Current.Name)
