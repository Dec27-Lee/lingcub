#!/bin/sh
# 三端入口之一：macOS / Linux。macOS 可把本文件后缀改成 .command 双击运行。
# 从 Finder/文件管理器启动时 PATH 是最小集，先把常见的 node 安装位置补进去。
set -e
cd "$(dirname "$0")"

for d in /opt/homebrew/bin /usr/local/bin /usr/bin "$HOME/.nvm/versions/node"/*/bin "$HOME/.volta/bin" "$HOME/.asdf/shims"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH
cd ..

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node：请先安装 Node.js（>=24）" >&2
  exit 1
fi

exec node scripts/launch-ui.mjs "$@"
