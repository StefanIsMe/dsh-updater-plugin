# @deepseek-ai/dsh-host-updater

中文 | [English](README.md)

为当前进程所运行的 DeepSeek Harness 检出目录提供自更新编排。`UpdaterGateway` 注册
`updater` 服务，并发布生成的直接远程调用：`updater/status`、`updater/check`、
`updater/apply`、`updater/restore`、`updater/setConfig`、`updater/restart` 与
`updater/refresh`。

该服务在不破坏任何本地草稿的前提下，将当前运行的仓库与上游远程保持同步：

1. **检查**（`git fetch` + 计划）：统计传入提交、变更文件，并给出三类判断——
   *需要安装依赖*（清单文件变更）、*需要重新构建*（源码变更）、*需要重启*（浏览器
   客户端平面以外的任何变更）。同时预先标出草稿冲突：上游修改而本地有草稿的文件
   （`conflictRisk`）与上游新增且本地已存在的路径（`untrackedRisk`）。
2. **应用**（防错流水线）：安全备份 → 仅暂存会冲突的草稿 → 快进合并至上游 → 在
   上游之上恢复草稿 → 可选执行 `pnpm install` / 构建。一旦冲突即停止，并保留暂存
   与备份；`updater/restore` 可将工作树恢复到更新前的快照。
3. **重启**：`updater/restart`（由调用方授权）先布署一个分离的监督进程，由其按原
   命令重启 DSH（有尝试上限与 `dead` 标记），随后停止当前 Host 进程。

每次状态迁移都会持久化到被管理仓库下的 `.dsh/updater/state.json`，并作为白名单
事件 `updater/state` 发出，供浏览器界面实时刷新。配置按部署持久化在
`.dsh/updater/config.json`。

## 模型体验

无——该 Host 侧服务只运行 `git`，不发起提示词，也不请求任何模型。

#### KV 缓存影响

无；本包从不组装模型输入。

## 已知限制与后续工作

- **每进程一个仓库**——`repoPath` 在 Host 生命周期内固定；变更需重启。
- **前台执行安装/构建**——在 Host 进程内运行并输出滚动日志；步骤为异步，但只占
  用一个命令槽。
- **不自动解决暂存弹出的冲突**——草稿与上游内容级冲突时，运行停在 `conflicts`
  状态，由用户显式解决（或恢复）；绝不自动丢弃任何内容。
- **重启为尽力而为的监督**——监督进程按原始启动命令重启；特殊启动方式可能需要
  配置 `launchCommand` 覆盖。
