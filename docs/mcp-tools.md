# MCP 接入与协作工具

默认 `collaboration` 模式从首次连接起固定暴露全部 11 个工具，不依赖客户端刷新目录。查询目录、发现候选、创建成员失败均不会触发安装；安装（包括 ACP 适配器）必须由上游根据用户对具体目标的明确授权调用。连接器不重复弹出确认，也不替上游推断用户已经授权。

## 默认工具目录

接入工具为 `discover_agents`、`setup_agent`、`wait_agent_setup`，任何接入状态都保留这三个工具和全部八个协作工具。

协作工具为 `spawn_agent`、`list_agents`、`send_message`、`followup_task`、`wait_agent`、`interrupt_agent`、`respond_agent`、`close_agent`。已有任务的响应、停止、关闭和历史读取不依赖当前 profile 是否仍然可用。无可用 profile 时创建成员返回 `AGENT_SETUP_REQUIRED` 及接入指引，不自动安装或换用其他 Agent。空环境的 `list_agents` 返回空成员列表，`discover_agents` 返回 `phase: "bootstrap"`；两者均不表示 MCP 服务未连接。

显式 `--toolset legacy` 和 `--toolset management` 保持原有目录。下游成员 Bridge 只暴露带 `acm_` 前缀的八个协作工具，不获得安装和配置入口。

## 接入流程

1. 调用 `discover_agents` 查看 `phase`、每个 profile 的 `ready` 和不可用原因、已有安装、Registry 来源及候选。默认只查询本地状态与缓存。传入 `local: { "adapter": "codex" }` 才扫描本地 Codex 并执行有时限的版本探测；扫描结果不会自动注册或安装。
2. 优先注册已有安装或本地 ACP 程序。无 Registry 缓存时，通过 `setup_agent` 的 `refresh_registry` 操作显式刷新元数据，再发现候选。
3. 需要安装时，由上游先确认用户已经明确选择目标，再提交固定来源、Agent、版本、分发方式及 profile。`install` 会安装并注册，不需要再调用一次注册。
4. 对返回的 `operationId` 调用 `wait_agent_setup`，可传 `afterRevision` 和 `timeoutMs`（默认 10 秒，最大 30 秒）。确认注册成功且取得 `configId` 后直接创建成员，将其用作协作 `profile`；无需重新拉取 `tools/list` 或重连。

`setup_agent` 使用 `{ "action": "...", "arguments": { ... } }`，具体字段由工具 JSON Schema 提供：

| action             | 行为与契约                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `refresh_registry` | 复用 `registry_refresh`，刷新指定来源，返回 operation                                                                                     |
| `register`         | 复用 `agent_register`，接受完整 `config` 和 `idempotencyKey`                                                                              |
| `update`           | 复用 `agent_update`，使用 `configId`、`expectedRevision`、`patch` 和 `idempotencyKey`；可显式启用或停用 profile                           |
| `install`          | 必填 `sourceId`、`registryAgentId`、`targetVersion`、`distribution`、`profile`、`idempotencyKey`；可传候选的 `snapshotId` 和 `launchArgs` |
| `plan_local`       | 复用 `local_agent_plan`，固定 Codex 候选指纹、适配器版本及配置修订；仅生成方案                                                            |
| `apply_local`      | 复用 `local_agent_apply`，校验方案摘要后安装适配器并注册或更新 profile；需要对适配器安装的明确授权                                        |
| `cancel`           | 复用 `operation_cancel`，只取消调用者有权控制的 operation                                                                                 |

`install.profile` 使用注册配置中除 `origin`、`launch` 外的字段，例如名称、工作目录、环境引用及权限策略；必须启用。安装器生成实际启动入口，`launchArgs` 可显式覆盖分发默认参数。安装成功后，profile、安装引用和成功 operation 一起提交。重复同一幂等请求返回原 operation；同一键对应不同参数会被拒绝。

如果下载已完成但注册失败，错误返回保留的 `installationId`。修正配置后用 `register` 引用该安装，无需重复下载。取消不会撤销已经提交的成功结果；并发安装同一目标时，一方取消不会终止其他调用者的安装。

最小注册示例（替换为实际已安装的 ACP 程序）：

```json
{
  "action": "register",
  "arguments": {
    "config": {
      "name": "codex-extra",
      "origin": { "kind": "manual" },
      "launch": { "kind": "command", "executable": "/absolute/path/to/acp-agent", "args": [] }
    },
    "idempotencyKey": "register-codex-extra"
  }
}
```

`permissionPolicy` 可整体省略以使用默认策略；一旦提供，必须包含 `rules`、`fallback`、`timeoutMs`，且每条规则的 `id`、`effect`、`operations`、`roots` 必填。`timeoutMs: null` 合法，漏填不合法。校验失败通过 `CONFIG_INVALID` 的 `details.issues` 返回完整字段路径，例如 `["arguments", "config", "permissionPolicy", "rules", 0, "id"]`，不会注册部分配置。

## 可用性检查

可用 profile 必须启用、环境引用可解析、引用的安装处于 `ready`，且实际启动文件及已知依赖可用。检查包括 Node 等解释器的本地脚本、托管 npm 入口、Python 虚拟环境和有效 `CODEX_PATH`；仅有包运行器或解释器不算 Agent 已安装。无法静态确认的命令包装器，以及不受宿主进程启动器支持的 Windows `.cmd`/`.bat`，需改为直接程序或解释器加本地脚本。

就绪检查不启动 ACP、不执行版本探测、不访问网络。它不证明 ACP 兼容性或认证已经成功；后续协作沿用现有握手、认证和交互流程。多 profile 时仍需按现有规则明确选择 profile 或设置默认 profile；显式失效目标不会自动替换。

发现 profile 和新建成员时重新检查实际状态；profile 的注册、禁用或本地文件变化均不改变工具目录，也不发送目录变更通知。只缓存首次工具目录的客户端可以在同一会话完成接入和协作。

CLI `tools --mcp` 保持离线工作，默认输出相同的 11 个工具定义。目录可见不代表 profile 可用、ACP 已认证或任务已经验收。

## Bridge 身份与完成验收

下游 MCP 服务名仍为 `agent_collaboration`，工具名改为 `acm_spawn_agent`、`acm_list_agents`、`acm_send_message` 等。下游提示和自定义客户端需使用这些新名称；外部上游工具名保持不变。Bridge 的 `/root` 是 AgentControlMCP 团队的外部上游，不是 Codex 等客户端的原生根会话。发消息必须实际调用 `agent_collaboration.acm_send_message`；原生协作活动、最终回复、Bridge `connected` 状态均不能替代所需 `MESSAGE`。

需要明确验收时，在 `spawn_agent` 或 `followup_task` 传入：

```json
{
  "completionCriteria": {
    "configId": "注册成功后返回的新 configId",
    "requiredMessage": { "target": "/root", "text": "READY 42" }
  }
}
```

`configId` 不匹配会返回 `PROFILE_MISMATCH`，不会创建任务。成员创建响应、状态和完成结果都提供实际 `configId`、`configRevision`。新增 profile 注册失败后，不能把使用旧 profile 的新成员当作新增成功。

任务正文和完成条件序列化后合计必须小于 16 MiB 减 8 KiB，超限时在受理前返回 `CONFIG_INVALID`。调度时还会检查加入元数据和待收邮箱后的完整提示，超过 16 MiB 则保留失败结果，不派发 ACP。

`completed` 与 `completionScope: "acp_turn"` 仅说明 ACP 轮次结束。框架按本轮 configId、任务归属、消息类型、Bridge 通道和消息正文摘要检查条件，返回 `acceptance.status`：未声明条件为 `not_requested`，全部满足为 `passed`，不满足为 `failed`。验收失败通过 `RUN_FAILED` 通知并暂停后续队列，不改写底层 ACP 状态。旧轮次、其他成员的消息和 `FINAL_ANSWER` 均不能满足本轮条件。

`list_agents` 的 `detail: "output"` 和完成通知保留验收结论与 Bridge 调用记录（最多 100 条，超出或历史缺失时 `bridgeCallsComplete: false`）。`bridge: "used"` 只表示调用过 Bridge，具体发送结果还需核对 `MESSAGE`、`taskId`、`intentId` 和调用回执的 `messageId`。这些检查不代替任务中其他业务要求的验收。
