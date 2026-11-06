@echo off
rem 常驻入口：崩溃按退避重试（详细规则见 scripts/supervise.mjs）
setlocal
set "HERE=%~dp0"
set "ROOT=%HERE%"
cd /d "%ROOT%"
node scripts\supervise.mjs %*
