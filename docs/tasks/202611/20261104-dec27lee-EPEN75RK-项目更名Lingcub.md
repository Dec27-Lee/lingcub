# 20261104-dec27lee-EPEN75RK 项目更名Lingcub

- **任务 ID**：20261104-dec27lee-EPEN75RK
- **任务名**：项目更名Lingcub
- **创建人**：Dec27-Lee
- **创建时间**：2026-11-04 10:52:00
- **最后更新人**：Dec27-Lee
- **更新时间**：2026-11-04 10:52:00
- **相关材料**：
  - [任务索引](../INDEX.md)

## 现状与目标

项目英文名由 `Mayday` 改为 `Lingcub`（中文名「幺幺零」不变），仓库同名。
目标是把标识符、文件名、配置、文档、测试、外部配置里的旧名一并换掉，且不丢历史数据、不断掉钩子链路。

命名口径分三层，不要混：

| 层 | 用什么 | 落点 |
| --- | --- | --- |
| 标识符 | 全小写 `lingcub` | 仓库名、目录名、`package.json` name、git remote、`data/*` 文件名 |
| 展示名 | `Lingcub` | README 标题、卡片与面板文案、`Name=` 字段 |
| 口语 | 幺幺零 | 中文交流、CHANGELOG 正文 |

理由：npm 自 2017 年起禁止新包名含大写；GitHub 仓库名不区分大小写（大写只是展示）；Linux 文件名区分大小写，混用会让 CI 与脚本按路径匹配失败。

## 改动范围

- 文本替换 **53 个文件 / 311 处**（源码、配置、文档、测试、脚本），旧名残留 0。
- 文件重命名 9 个：`config/lingcub.yaml`、`data/lingcub.{db,log}`、`lingcub-run.cmd`、`lingcub-ui.cmd`、`lingcub-ui.desktop`、`scripts/run-lingcub.sh`。
- 包名 `@yue/mayday-110` → `@yue/lingcub`，bin → `lingcub`；5 个环境变量 `MAYDAY_*` → `LINGCUB_*`（改前已确认系统里没有外部设置）。
- 工作区 `personal-mayday` → `personal-lingcub`，root 指向新目录，别名 `[lingcub, 幺幺零]`；库内 1 行历史 `intents.project` 同步更新。
- 外部配置：live `~/.claude/settings.json` 5 条钩子、`~/.cc-switch/cc-switch.db` 的 `settings.value` 1 行。

## 六条踩坑结论

1. **全词替换抓不到片段引用。** 测试用 `#may` 做前缀模糊匹配（`may` 是 `mayday` 的前半截），替换后代码是 `lingcub` 而断言还在用 `#may`，测试红。改名前必须单独搜一遍这类缩写/前缀用法（`#may`、`may-`、`/may`），不能只替换完整词。

2. **pnpm 的 node_modules 是绝对路径符号链接，目录一改名全部失效。** 表现为 `ERR_MODULE_NOT_FOUND: Cannot find package 'yaml'`。修法是重跑 `pnpm install`；坏链会让 pnpm 自己报 `os error 5 拒绝访问`，要先精确删掉链接本身（保留 `.pnpm` 实体），pnpm 才能重建。

3. **目录改名会被正在使用它的会话占用。** 本机 `mv` 报 `Device or resource busy`，占用者是 workspace 指向该目录的 AI 会话进程，**无法自举**，只能由人在会话外改名。

4. **测试里硬编码目录名会制造假失败。** `test/plugins.test.ts` 把 `E:\Develop_E\lingcub` 当 spawn 的 cwd、`test/session.test.ts` 真实检查目录存在性、`test/hooks-install.test.ts` 断言钩子命令含新名。目录名没落地时这 7 个测试必红，且红的是环境不是代码。**判断方法**：临时建同名空目录再跑，能转绿的就是环境依赖。

5. **cc-switch 的 `session_log_sync` 不该跟着改名。** 它有 15 行指向 `.claude/projects/E--Develop-E-mayday-110/` 与 `.dsh/sessions/...` 的**历史会话文件**，那些文件本身没改名，跟着改会指向不存在的路径。

6. **钩子路径分散在两处，必须一起刷。** live `settings.json` 与 cc-switch 数据库的 `common_config_claude` 各存一份；cc-switch 切供应商时会用自己那份全量重写 live，只改 live 会被冲掉。

## 验证

- `pnpm build` 通过；`pnpm test` **251/251 全绿**（改名前 244/251，7 个全部转绿，证实第 4 条的成因判断）。
- `node scripts/audit-parity.mjs`：30 条功能 + 15 条实现约定，缺失 0，测试踪迹 30/30。
- `node scripts/check-docs.mjs`：文档自检通过。
- 钩子端点实测 `POST http://127.0.0.1:<port>/stop?t=<token>` → `{"ok":true}`；live 旧路径 0 处 / 新路径 5 处；cc-switch 旧路径 0 行 / 新路径 1 行。
- 常驻重启后：supervisor 与主进程 `MainWindowHandle` 均为 0（无黑窗口），锁文件与 `data/hooks.json` 的 pid 一致，发件箱无积压。

## 未改动项（有意为之）

- `config/lingcub.yaml` 的 `allowRoots: ['E:\Develop_E']`：工作区门禁的伞根，与本项目名无关。
- 历史会话记录目录（`.claude/projects/E--Develop-E-mayday-110/`、`.dsh/sessions/`）：见第 5 条。
- `[source-dingtalk] 事件消费进程退出：code=3`：改名前旧进程启动时同样出现，属本机未连钉钉的既有状态，与本次更名无关。

## 回滚

数据库在改名前后各留了一份备份（`data/lingcub.db.bak-205336`、`lingcub.db.bak-rename-20261104093637`），cc-switch 留有 `cc-switch.db.bak-rename-*`，钩子留有 `settings.json.bak-*-1793*`。
回滚需同时还原：目录名、`package.json`、`config/lingcub.yaml` 的三个数据路径、git remote、两处钩子路径。

## 完成判定

仓库内旧名残留 0、251 个测试全绿、两处钩子均指向新路径、常驻在无窗口状态下跑通一个完整调度周期。
