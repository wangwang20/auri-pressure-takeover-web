# 演示控制台

团队协作同事请先阅读 [TEAM_GUIDE.md](./TEAM_GUIDE.md)。

定位：模拟本轮未接入的外部世界并保证现场可复现，不替 Agent 做判断。

P0 操作：可选载入演示预置任务、会议延迟、进入车辆、触发拥堵、注入辅助信号、用户求助、确认发送和重置 Demo。默认没有任务；正常主线由手机语音创建任务。控制台还应展示事件日志、当前 World State、连接状态和错误。

当前控制台还提供现场预检、下一步引导、前置条件禁用、Reset 二次确认、技术验证折叠区、车辆状态摘要、Ledger 摘要和脱敏日志复制。

状态同步优先使用 SSE。SSE 中断时页面会自动切换到 3 秒轮询，并每 2.5 秒尝试恢复实时流；顶部 `State Sync` 卡会明确显示 `SSE 实时`、`轮询兜底` 或 `连接中`。

所有按钮发送标准事件；禁止通过直接改数据库或内存对象来跳过 Agent 状态机。

## 当前实现

当前目录提供一个独立 Web 控制台：

- `index.html`：控制台页面。
- `styles.css`：浅背景、卡片化、蓝/橙主色视觉。
- `app.js`：Agent API 客户端、SSE/轮询状态同步、标准事件发送和日志。
  控制台事件重试会复用同一轮稳定 `event_id`，避免重复创建任务或动作。事件日志记录 `event_id`、HTTP 状态、duplicate、revision 和请求耗时。

## 本地运行

先启动 Agent 后端：

```bash
/home/fly/miniconda3/envs/auri-agent-dev/bin/python -m uvicorn \
  auri_agent.app:app \
  --app-dir services/agent-api/src \
  --host 127.0.0.1 \
  --port 8000
```

再用任意静态服务打开本目录，或从项目根目录启动：

```bash
python -m http.server 5174
```

访问：

```text
http://127.0.0.1:5174/apps/demo-console/
```

## 配置

页面支持在顶部输入：

- `Agent API`：例如 `http://127.0.0.1:8000` 或云端 Agent 地址。
- `Team Token`：仅本地运行时填写，保存到浏览器 `localStorage`。
  默认 Agent API 为团队 LangChain 公网地址；本地开发可点击 `本地 Agent` 切换。

不要把团队 Token、OpenAI API Key 或其他密钥提交到仓库。

## 事件映射

| 控制台按钮 | 接口 | 事件或操作 | 说明 |
| --- | --- | --- | --- |
| 同步手机语音任务 | `GET /v1/state` | 状态刷新 | 主流程必经步骤；初始保持空任务，等待手机语音创建并同步。 |
| 载入演示预置任务 | `POST /v1/event` | `task.created` | 侧栏可选兜底：仅手机端不可用时模拟创建“18:10 接孩子，之后去超市”。 |
| 会议延迟 | `POST /v1/event` | `meeting.overrun` | 延迟 20 分钟，触发最晚出发风险。 |
| 接近车辆 | `POST /v1/event` | `scene.approaching` | 准备从随行/手机交接到车机。 |
| 进入车辆 | `POST /v1/event` | `scene.vehicle_entered` | 车机成为主展示端。 |
| 拥堵加剧 | `POST /v1/event` | `traffic.updated` | 基于当前刚性任务的 `scheduled_at` 计算 ETA；演示默认注入晚到 18 分钟。 |
| 压力辅助信号 | `POST /v1/event` | `wearable.signal` | 注入心率和置信度，只作辅助信号。 |
| 急刹信号 | `POST /v1/event` | `driving.signal` | 模拟驾驶负荷升高。 |
| 手机语音求助 | `POST /v1/event` | `user.utterance` | 以 `source=mobile`、`input_mode=voice` 模拟手机 ASR 转写；车机只读显示原文。 |
| 服务成功/缺货/超预算 | `POST /v1/event` | `service.mock.config` | 控制模拟服务后端返回。 |
| 确认发送 | `POST /v1/confirm` | `confirmed_by=vehicle_hmi` | 模拟车机大按钮确认。 |
| 语音确认 | `POST /v1/confirm` | `input_mode=voice` | 模拟车机/手机语音确认兜底。 |
| 低干扰恢复 | `POST /v1/event` | `cooldown.elapsed` | 完成后降低打扰。 |
| 停车复盘 | `POST /v1/event` | `scene.parked` | 主交互端回到手机。 |
| 重置 Demo | `POST /v1/session/reset` | - | 回到 happy-path 初始状态。 |

## 设计约束

- 控制台只注入外部世界事件，不生成业务结论。
- 控制台不直接设置 stage、pressure、actions、confirmation。
- 所有状态展示都来自 Agent 返回的 World State。
- 现场手机端失败时，控制台侧栏的预置任务按钮作为可选兜底，但仍走正式 API。
- 主故事创建任务后锁定服务模拟配置，避免现场误切成功/缺货/超预算分支。
- 确认请求结果不明确时先重新读取 `/v1/state`，确认仍为 pending 才允许重试。
