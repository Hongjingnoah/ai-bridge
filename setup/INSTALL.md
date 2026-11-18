# DSH ↔ Codex 互通桥 · 给别人装

一份自包含的安装说明。目标：让**任何一台**已经装了 DSH 和 Codex 的 Windows 机器，
也能把两个 AI 接成程序级互通（不是屏幕模拟输入）。

---

## 0. 先确认对方机器有这两样

| 需要什么 | 怎么确认 |
|---|---|
| Codex 桌面版（含 CLI） | `%LOCALAPPDATA%\OpenAI\Codex\bin\` 下有 `<hash>\codex.exe` |
| Codex 已登录 | 运行 `<codex.exe> exec --skip-git-repo-check "只回复：通了"` 能返回 |
| DSH 桌面版 | `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` 存在 |
| DSH 已登录 | DSH 应用里能正常对话 |
| Node（DSH 自带即可） | `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe` |

> 注意：路径可能不同。**DSH 的 `dsh headless` 故意不用 desktop profile**（那个被 Electron 独占），
> 所以额外需要一个"账号路由覆盖层"把 headless 指到已登录的 provider。

---

## 1. 拷贝

把整个 `AI互通桥` 文件夹拷到对方机器，例如 `D:\ai-bridge`（**建议用纯 ASCII 路径**，
cmd 对中文路径的编码处理很容易出错）。

```
D:\ai-bridge\
  lib\appserver.mjs
  bin\codex-bridge.mjs
  bin\codex-bridge-mcp.mjs
  bin\dsh-bridge-mcp.mjs
  bin\bridge-mailbox.mjs
  work\headless-account.patch.yml
  setup\setup.mjs
```

---

## 2. 一次自动适配

```
node D:\ai-bridge\setup\setup.mjs
```

它会做四件事并逐条打印结果：
1. 探测 `codex.exe`（不写死版本 hash）；
2. 探测 DSH 的 `dsh.cmd` 与自带 node；
3. 生成/校验 `headless-account.patch.yml`（账号路由覆盖层，**不改 DSH 任何现有配置**）；
4. 跑一次真实冒烟测试：Codex 握手 + DSH 无头回答。

任何一步失败都会打印具体原因与修法，不会静默通过。

---

## 3. 让 DSH 能直接调用 Codex（本机实测：加了就生效，连重启都不需要）

在对方 DSH 的 `C:\Users\<用户>\.dsh\profiles\desktop\cordis.patch.yml` 的
MCP `insert` 块里加一项：

```yaml
    - id: mcp-codex-bridge
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: codex-bridge
        transport: stdio
        command: '%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
        args:
          - 'D:\ai-bridge\bin\codex-bridge-mcp.mjs'
        cwd: 'D:\ai-bridge'
```

改前先备份该文件。加完在 DSH 里应该出现 `mcp__codex-bridge__codex_ask` 工具。

---

## 4. 让 Codex 能调用 DSH（可选，需要对方同意写 Codex 配置）

**推荐入口：`bin\dispatch-dsh.mjs`**（用官方 `@modelcontextprotocol/client` SDK，
比裸调 `dsh_ask` 多出 `sessionId` / `usage` / `toolCalls` 结构化信息，适合多轮对话）。

```powershell
# 首次调用
node D:\ai-bridge\bin\dispatch-dsh.mjs "帮我看看这个报错"

# 多轮续接：用上一轮返回的 sessionId（实测记忆成立）
node D:\ai-bridge\bin\dispatch-dsh.mjs --session-id session-xxxx "接着刚才的说"

# 指定工作目录
node D:\ai-bridge\bin\dispatch-dsh.mjs --cwd D:\some\project "读一下这里的代码"
```

返回示例（真实输出）：

```json
{
  "sessionId": "session-66b067c4-3ad3-4894-adae-80ef12c4d540",
  "cwd": "D:\\ai-bridge",
  "toolCalls": [],
  "usage": [{ "inputTokens": 10386, "outputTokens": 32, "totalTokens": 10930 }],
  "ok": true,
  "status": "completed",
  "answer": "分发通",
  "elapsedMs": 2924
}
```

多轮续接实测（这是"它真的记得"的证据）：

```
第 1 轮  dispatch-dsh "记住暗号 RED-952，只回复'已记住'"      → answer="已记住"
第 2 轮  dispatch-dsh --session-id <同上> "刚才的暗号是什么"   → answer="RED-952"  （同 sessionId，2453ms）
```

如果你想让它作为 Codex 的**原生 MCP 工具**（而不是命令行）：

```
codex mcp add dsh-bridge -- <node.exe> D:\ai-bridge\bin\dsh-bridge-mcp.mjs
```

并在 `~/.codex/config.toml` 的该段补上：

```toml
required = false
startup_timeout_sec = 5.0
tool_timeout_sec = 330.0     # 关键：默认 60s，长任务会被掐断
```

**必须真的在 Codex 界面里看到 `dsh_ask` 工具才算成功**——配置文件写了不等于已加载。
（本机实测：注册后**无需重启**即可用；由 Codex 自己列举工具并调用成功验证。）

---

## 5. 验收（缺一不可，别把"脚本能跑"当成"已互联"）

| 检查项 | 通过标准 |
|---|---|
| 协议合规 | `node work\verify-mcp-strict.mjs bin\codex-bridge-mcp.mjs codex_ask '{"prompt":"回复OK"}'` → `strictOk: true`、`violations: []` |
| DSH→Codex | 上一行能拿到答案；或在 DSH 里直接调 `codex_ask` 工具 |
| Codex→DSH（推荐入口） | `node bin\dispatch-dsh.mjs "回复：ok"` → `"ok": true`、有 `sessionId` |
| Codex→DSH 多轮 | 第 1 轮给暗号，第 2 轮用 `--session-id` 追问，能答对 → 记忆成立 |
| 原生工具 | DSH 工具列表里真的出现 `codex_ask`；Codex 工具列表里真的出现 `dsh_ask` |
| 防递归 | `AI_BRIDGE_DEPTH=2` 时 `codex-bridge ask` 立刻拒绝（exit 3）；`AI_BRIDGE_DEPTH=abc` 时反向桥拒绝启动（exit 2） |
| 长任务可观测 | 调用期间 `node bin\progress.mjs --follow` 能看到 `turn-started → first-delta → turn-done` |
| 无进程泄漏 | 调用前后 `headless` 实例数不增长；`work\process-sampling.mjs` 输出"无累积" |

---

## 6. 必须知道的三件事（否则会误判）

1. **每次调用都是新开的会话，不共享桌面聊天历史。**
   桥接进程启动的是 `codex app-server` 子进程 / `dsh headless` 子进程，
   它读配置、用它自己的会话存储，但**不会**把你桌面上正在聊的那个窗口的上下文带过来。
   要连续对话就用返回的 `threadId`（Codex 侧）/ `sessionId`（DSH 侧）显式续接。

2. **延迟里能省的只有约 0.3 秒。**
   本机实测：进程启动+握手+建线程合计约 0.29s；剩下约 3.1–3.9s 全在
   "请求发到模型 → 第一个字回来"这一段。实测把输入砍 20% 或把推理档位从
   medium 降到 low，**都没有稳定提速**。所以别指望优化本地代码把 4 秒变成 1 秒。

3. **默认权限是 `danger-full-access` + 审批 `never`。**
   被调用的那一方可以直接读写文件、执行命令。要收紧就传 `--sandbox read-only`，
   或改 `askTurn` 的 `sandbox`/`approvalPolicy` 参数。

---

## 7. 卸载

删掉 `D:\ai-bridge` 文件夹；
DSH 侧删掉 `mcp-codex-bridge` 那一段；
Codex 侧 `codex mcp remove dsh-bridge`。
**本方案从不修改 DSH 的 profile 内容以外的任何东西**，`headless-account.patch.yml`
是独立覆盖层，删掉不影响 DSH 启动。
