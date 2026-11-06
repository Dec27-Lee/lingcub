#!/bin/sh
# 常驻入口：崩溃按退避重试（详细规则见 scripts/supervise.mjs）
cd "$(dirname "$0")/.." || exit 1
exec node scripts/supervise.mjs "$@"
