# 自动接受「是否信任这个工作区」确认框。
#
# 为什么要它：Claude Code 2.1.x 的 workspace trust 在部分目录上不认 `~/.claude.json` 里预置的
# `hasTrustDialogAccepted`（实测：正斜杠键、完整条目形状都试过，窗口仍停在确认框）。
# 那个框默认停在「No, exit」，没人按键就永远等不到 SessionStart，窗口白开。
#
# 只对**我们自己拉起的那个窗口**动手：按启动脚本名 cc-launch-<前8位> 定位 cmd.exe，
# 取它的主窗口句柄，聚焦后按「下 → 回车」选「Yes, I trust this folder」。
param([Parameter(Mandatory = $true)][string]$Tag)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LingcubWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$proc = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
  Where-Object { $_.CommandLine -like "*cc-launch-$Tag*" } |
  Select-Object -First 1
if (-not $proc) { Write-Output 'no-window'; exit 1 }

$p = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
if (-not $p -or $p.MainWindowHandle -eq [IntPtr]::Zero) { Write-Output 'no-handle'; exit 2 }

[LingcubWin]::ShowWindow($p.MainWindowHandle, 9) | Out-Null   # 9 = SW_RESTORE
[LingcubWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 400

$w = New-Object -ComObject WScript.Shell
$w.SendKeys('{DOWN}')
Start-Sleep -Milliseconds 250
$w.SendKeys('{ENTER}')
Write-Output 'accepted'
