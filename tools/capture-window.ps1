# Capture an emulator window to a PNG.
#
# Bring-up on a TV emulator is close to blind: `sdb shell` returns nothing on the
# Samsung image, the Web Inspector port refuses connections, and `dlog` is empty.
# The screen is the only reliable output, so read it directly rather than asking
# someone to take a photo of their monitor.
#
#   powershell -File tools/capture-window.ps1 -Title "Tizen Emulator" -Out shot.png
#
# -Title is matched as a substring of the window title.

param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Out
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$Title*" } | Select-Object -First 1
if (-not $proc) { Write-Error "no window matching '$Title'"; exit 1 }

$h = $proc.MainWindowHandle
# A minimized window has no pixels to copy — restore it first (9 = SW_RESTORE).
if ([Win]::IsIconic($h)) { [Win]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 800 }
[Win]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 600

$r = New-Object Win+RECT
[Win]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L
$ht = $r.B - $r.T
if ($w -le 0 -or $ht -le 0) { Write-Error "window has no size"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)

# PrintWindow asks the window to render itself, so another window sitting on top
# doesn't end up in the capture — which is exactly what happens with two
# emulators open. Flag 2 (PW_RENDERFULLCONTENT) is the one that works for
# hardware-accelerated surfaces. Fall back to a screen grab if it refuses.
$dc = $g.GetHdc()
$printed = [Win]::PrintWindow($h, $dc, 2)
$g.ReleaseHdc($dc)
if (-not $printed) {
  [Win]::BringWindowToTop($h) | Out-Null
  Start-Sleep -Milliseconds 700
  $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
  Write-Output "note: PrintWindow refused; used a screen grab (other windows may overlap)"
}

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "captured '$($proc.MainWindowTitle)' ${w}x${ht} -> $Out"
