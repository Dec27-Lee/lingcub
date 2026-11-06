' 静默启动 lingcub（不给用户弹控制台窗口）。
' 用法：wscript scripts\start-hidden.vbs [run]
' node.exe 是控制台程序，直接双击/命令行启动都会带一个黑窗口；用 WScript.Shell.Run 的
' 窗口样式 0 = 隐藏，这样看门狗和主进程都在后台跑，托盘/任务管理器里能看到。
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
node = "D:\software_in\nodejs\node.exe"
If Not fso.FileExists(node) Then
  ' 没配绝对路径就退回 PATH 里的 node
  node = "node.exe"
End If
args = ""
For Each a In WScript.Arguments
  args = args & " " & a
Next
cmd = """" & node & """ """ & root & "\scripts\supervise.mjs""" & args
sh.CurrentDirectory = root
sh.Run cmd, 0, False
