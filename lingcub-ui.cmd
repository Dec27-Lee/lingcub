@echo off
rem 三端入口之一：Windows。双击或在终端运行都可以。
rem 复用已跑的面板；没有就起一个再打开独立窗口。
setlocal
set "HERE=%~dp0"
node "%HERE%scripts\launch-ui.mjs" %*
if errorlevel 1 pause
