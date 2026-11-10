# 单元测试规范

本目录是幺幺零（Lingcub）的**单元测试工作区**：用例怎么放、怎么登记、怎么跑、结果落在哪，只看这一份。
规范面向维护者与 AI；业务设计看 `docs/`，任务过程看 `docs/tasks/`。

- 测试执行器：`node --test`（**不引入测试框架**，`AGENTS.md` 硬规则）
- 用例类型：单元 / 集成 / 端到端，全部离线可跑，秒级，不碰真实飞书、钉钉、模型订阅
- 一键全量：`pnpm test`

## 1. 目录职责

```text
tests/
  README.md                 本规范
  scenarios/<domain>/       场景登记（每个域一对文件）
    case.md                 人工评审入口：这层管什么、不管什么、判据来源、用例清单
    suite.yaml              执行真相：runner 只读它；用例的 ID／层级／优先级／状态／单跑命令／断言点
  specs/<domain>/           用例实现，一个 .test.ts 一个场景（文件是执行单位）
  support/                  跨用例公共夹具（当前：golden 的 cases / harness / baseline / capture）
  scripts/                  runner 与公共逻辑（不是测试本身，不被 specs 导入）
  out/<runId>/              执行产物（Git 忽略）
  .runtime/                 本地运行态缓存（Git 忽略）
```

`specs/` 与 `scenarios/` **一一对应**：`tests/specs/kernel/outbox.test.ts` 必须能在
`tests/scenarios/kernel/suite.yaml` 里找到 `file: tests/specs/kernel/outbox.test.ts` 的条目。
新增用例文件而不登记，runner 会直接报错退出（见 §6）。

## 2. 域划分

按**被断言的主体**归域，不按 import 最深的模块。

| 域目录 | 编号前缀 | 范围 | suite 现状 |
| --- | --- | --- | --- |
| `domain` | `DOMAIN` | `src/domain/**`：四层模型、文档 XML/待办/写入、ID、工作站快照 | 5 文件 / 24 断言 |
| `kernel` | `KERNEL` | `src/kernel/**`：事件史、发件箱、能力收据、清单 v2、配置、闸门、会话、转录 | 40 / 279 |
| `routing` | `ROUTING` | `src/routing/**`：三级漏斗、规则谓词、命令解析、自动回复 | 4 / 55 |
| `plugins` | `PLUG` | `src/plugins/**`：单插件清单／端口／行为 | 29 / 111 |
| `plugin-kit` | `KIT` | `src/plugin-kit/**`：claude/dsh 探测、钩子、CC Switch、载荷清洗、spawn | 18 / 66 |
| `desktop` | `DESK` | `src/desktop/**`：工作台 HTTP、UI 目录、插件状态、重启 | 6 / 21 |
| `flow` | `FLOW` | 跨域整链：真内核 + 假端口，消息进 → 发件箱 → 端口 → 回执 | 10 / 37 |
| `golden` | `GOLDEN` | 金标对拍：44 条固定输入与基线逐字一致 | 1 / 1 |
| `ops` | `OPS` | `scripts/**`：切换、看门狗、自启、钩子安装 | 5 / 18 |

合计 **118 个场景 / 612 条断言**（`node tests/scripts/run-suite.mjs --list` 可核）。

## 3. 场景编号

格式 `<PREFIX>-<LAYER>-<NNN>`，如 `KERNEL-INT-019`、`ROUTING-UNIT-004`、`OPS-E2E-005`。

- `LAYER`：`UNIT`／`INT`（integration）／`E2E`，与 `suite.yaml` 的 `layer` 字段一致。
- `NNN`：域内按用例文件名字典序分配，**已发布的编号不复用**；新增用例追加到域末尾。
- 标题：取该用例文件第一条 `test(...)` 的原文。代码标题变了，`suite.yaml` 与 `case.md` 同步更新。

## 4. suite.yaml 字段

```yaml
suite: kernel          # 必填，等于域目录名
domain: kernel         # 必填，等于域目录名
scenarios:
  - id: KERNEL-INT-019                  # 必填，稳定编号
    title: 同一 dedupeKey 只投递一次      # 必填，取自用例文件第一条 test 标题
    layer: integration                   # 必填：unit | integration | e2e
    priority: P0                         # 必填：P0 | P1 | P2
    tags: [kernel, outbox, integration]  # 必填，域 + 主体词 + 层级，供 --tag 过滤
    status: ready                        # 必填：ready | gated | pending
    command: node --experimental-strip-types --test tests/specs/kernel/outbox.test.ts  # 必填，可独立运行
    assertions:                          # 必填，该文件内全部 test 标题（>12 条时截断并写 notes）
      - 同一 dedupeKey 只投递一次
    timeoutSec: 60                       # 必填
    file: tests/specs/kernel/outbox.test.ts  # 必填，runner 用它做登记完整性与存在性校验
    notes: 另有 N 条断言见用例文件        # 可选
```

口径：

- `layer=unit`：单模块／纯函数，不装配内核组件。
- `layer=integration`：装配两个以上真实内核组件（Store／Outbox／EventLog／Capabilities／Pipeline／清单 v2），外部端口一律注入假实现。
- `layer=e2e`：起真实子进程、CLI 壳或 HTTP 服务走完整链路（如假 `lark-cli`／假 `claude`、工作台服务）。
- `priority`：`P0` 内核不变式与架构边界（发件箱、事件史、能力收据、清单 v2、闸门、插件边界、规则判定、整链 e2e）；`P1` 其余单元与集成；`P2` 依赖本机环境的探测与安装类。
- `status`：`ready` 默认可跑；`gated` 需要本机真实安装或凭据，默认不进 smoke；`pending` 只有设计。**跑不通就必须标 gated 或 pending，不能留在 ready 里假绿。**

## 5. 执行入口

| 目的 | 命令 |
| --- | --- |
| 全量（收尾／CI 主入口） | `pnpm test` |
| 单域 | `node tests/scripts/run-suite.mjs --suite=kernel`（`pnpm test:suite --suite=kernel`） |
| 单场景 | `node tests/scripts/run-suite.mjs --case=KERNEL-INT-019`（`pnpm test:case --case=KERNEL-INT-019`） |
| 按标签／优先级／层级 | `--tag=outbox`、`--priority=P0`、`--layer=e2e`，可组合 |
| 列清单 | `node tests/scripts/run-suite.mjs --list`（`pnpm test:list`） |
| 登记完整性自检 | `node tests/scripts/run-suite.mjs --check`（`pnpm test:check`） |
| 单个用例文件（不产生产物） | `node --experimental-strip-types --test tests/specs/kernel/outbox.test.ts` |

约定：

- **cwd 必须是仓库根**。用例里有按 `process.cwd()` 建临时目录、读 `config/rules.yaml` 的写法；在 `tests/` 里跑会得到假失败。
- **临时目录由入口统一回收**：`pnpm test` 走 `scripts/test-run.mjs`，把子进程的 `TEMP/TMP/TMPDIR`
  指到 `<系统临时目录>/lingcub-test/run-<pid>-<ts>`，跑完整棵删掉。用例里照常
  `mkdtempSync(join(tmpdir(), 'lingcub-xxx-'))` 即可，**不要自己补 `rmSync`**；
  若绕过它直接 `node --test`，那些目录会留在系统临时目录里（2026-11-10 清掉过 3.7 万个）。
- runner 固定 4 并发出子进程，`--jobs=N` 可调；每条场景的输出写自己的日志文件，不会交错。
- 每条场景按 `timeoutSec` 计时，超时杀掉子进程并记 `exitCode=124`（与「断言失败」区分）。
- `status` 不是 `ready` 的场景默认跳过；显式传 `--status=gated` 才会跑。
- `--junit` 额外产 `junit.xml`，供 CI 消费；默认关闭。

### 5.1 跑多少：定向用于定位，全量用于兜底

实测成本（本机，2026-11-09）：全量 612 条 **17.5s**；单域 kernel 9.0s、plugins 6.6s；P0 组 6.1s；单条 0.7s。

- **开发中默认定向**：改哪个域跑哪个域（`--suite=<域>`），定位单条用 `--case=<ID>`。
  目的不是省那十几秒，而是**失败面小、产物带 runId 可直接贴证据、偶发失败（如 e2e 内部的 `waitFor`）能一眼分清是环境还是逻辑**。
- **以下改动必须跑全量**（引用面无法枚举，定向一定会漏）：
  - `src/domain/ports.ts`、`src/domain/types.ts`（四层模型与端口契约）
  - `src/domain/plugin-v2.ts`（清单与端口 schema）
  - `src/kernel/**`、`src/routing/**`（所有插件都经内核与路由）
  - `src/plugin-kit/**`（被多个插件共用）
  - `config/*.yaml`（规则、执行器策略、插件开关）
  - `tests/support/**`（金标夹具，全量都依赖）
- **收尾与提交前必须全量**：`pnpm build && pnpm test`。不接受「我只改了一处」作为豁免。
- **不需要后台异步**：17.5s 同步跑完即可；单次全量超过约 60s 或带真实外部依赖时，才改后台并先说明预计耗时。
- **`--check` 不是执行**：它只校验登记完整性，不能替代跑测试。
- **定向跑完要留证据**：`tests/out/<runId>/summary.json`；汇报贴 `passed/total` 与时长，不写「跑过了」。

> 与参考项目（tongclaw）的差别：那边禁止开发中跑全量，因为 Maven Reactor + 前端全量是分钟级，挤占迭代；
> 本项目全量 17.5s，所以保留的是「定向定位 + 全量兜底」，丢掉的是「禁止全量」。
> 反过来，那边的「引用关系可枚举才跑受影响范围」在这里不成立——插件是动态装配的，改内核等于改所有插件，所以跨域改动直接全量。

## 6. 结果产物

```text
tests/out/<runId>/
  summary.json          跑批摘要：runId、命令、筛选条件、totals、每条 case 的 exitCode／耗时／日志路径
  <ID>.log              该场景的完整标准输出（含失败断言明细）
  <ID>.junit.xml        单场景 JUnit（--junit 时）
  junit.xml             合并后的 JUnit（--junit 时）
```

- `runId` 形如 `20261109-143406-2toz`（本地时间 + 4 位随机）。
- 退出码：`0` 全通过；`1` 有场景失败；`2` 登记不一致（未登记用例、缺 `case.md`／`suite.yaml`、ID 重复、文件不存在）。**`2` 不算测试失败，是规范没守住。**

## 7. 公共夹具

放 `tests/support/`，只允许被 `specs/` 以相对路径引入：

- `support/golden/cases.ts`：44 条固定输入。
- `support/golden/harness.ts`：三假端口 + 真 Pipeline／Outbox／Store，每案独立 `:memory:` 库。
- `support/golden/baseline.json`：当前基线。**改行为不是改基线**——只有确认新行为正确、且任务文档记录了差异，才用
  `node --experimental-strip-types tests/support/golden/capture.ts` 重生成，并与行为改动同批提交。

用例内部的临时目录一律 `mkdtemp(join(tmpdir(), 'lingcub-...'))`，不写仓库目录；需要仓库文件的用例
用 `resolve(import.meta.dirname, '../../..')` 定位仓库根。

## 8. 新增或修改用例

1. 先看对应 `scenarios/<domain>/case.md` 的「这一层管什么／不管什么」，确认不属于别的域。
2. 在 `specs/<domain>/` 建或改 `.test.ts`；标题写清「什么行为、为什么」，不写实现细节。
3. 在 `scenarios/<domain>/suite.yaml` 追加或更新条目（`--check` 会强制这一步）。
4. 同步 `case.md` 的用例清单（表格可由生成逻辑重出，但**编号与文件必须一致**）。
5. 定向跑：`node tests/scripts/run-suite.mjs --case=<ID>`；再跑 `--suite=<domain>`。
6. 收尾：`pnpm build && pnpm test`，并跑 `node scripts/audit-parity.mjs`、`node scripts/check-docs.mjs`。

改业务行为时：

- 新规则必须有**变异反证**：把规则改坏（或删掉判据）时对应用例必须真红，恢复后转绿；只做「做不红」的测试等于没判据。
- 有真实副作用的路径（装钩子、自启、切换服务商）只做「预演输出」级测试，`--apply` 必须由第二道闸挡住（`LINGCUB_SWITCH_CONFIRM` 之类），不得在测试里真改生产配置。

## 9. 禁止项

- 禁止新增测试框架（jest／vitest／playwright 等）；`node --test` 之外一律不加。
- 禁止只加 `specs/` 文件而不登记 `suite.yaml`（runner `--check` 会拦）。
- 禁止把 `*.test.ts` 放进 `src/`。单数 `test/` 只留给将来**模块内**单测（如独立前端包），根 `tests/` 只放本项目跨模块与系统级用例；
  两者不得混用，也不得再建第三套测试根。
- 禁止在默认套件里依赖真实飞书／钉钉／模型凭据；这类用例必须 `gated`。
- 禁止为了让测试变绿而改断言去迎合实现，或在测试里修改业务 API 契约。
- 禁止把用例改成依赖执行顺序（同文件内共享可变全局、跨文件共享临时目录）。
- 禁止 `test.skip` 长期留存：要么修好，要么把 `status` 标 `gated`／`pending` 并写清原因。
- 禁止只跑单条／单域就宣称「验证通过」：跨域改动与收尾一律全量（见 §5.1）。

## 10. 提交前检查清单

- [ ] `pnpm build` exit=0。
- [ ] `pnpm test` 全绿，断言数与 `case.md` 记录的条数一致。
- [ ] 新增／修改的场景已登记 `suite.yaml`，`pnpm test:check` 通过。
- [ ] `case.md` 的清单与编号同步。
- [ ] 新规则有变异反证记录（写在任务文档）。
- [ ] `node scripts/audit-parity.mjs`、`node scripts/check-docs.mjs` 通过。
- [ ] `tests/out/` 没有进入暂存区（已在 `.gitignore`）。
