# 演示控制台

团队协作同事请先阅读 [TEAM_GUIDE.md](./TEAM_GUIDE.md)。

定位：模拟本轮未接入的外部世界并保证现场可复现，不替 Agent 做判断。

P0 操作：可选载入演示预置任务、会议延迟、进入车辆、触发拥堵、注入辅助信号、用户求助、确认发送和重置 Demo。默认没有任务；正常主线由手机语音创建任务。控制台还应展示事件日志、当前 World State、连接状态和错误。

当前控制台还提供现场预检、下一步引导、前置条件禁用、Reset 二次确认、技术验证折叠区、车辆状态摘要、Ledger 摘要和脱敏日志复制。

标准主线严格按十步推进，并展示每步建议时间。压力辅助信号是手机语音求助的前置步骤；控制台同时展示 `reason_codes`、辅助信号、确认关系、服务订单和动作状态，不能通过按钮顺序绕过 Agent 状态机。

状态同步优先使用 SSE。SSE 中断时页面会自动切换到 3 秒轮询，并每 2.5 秒尝试恢复实时流；顶部 `State Sync` 卡会明确显示 `SSE 实时`、`轮询兜底` 或 `连接中`。

Console 保存 Agent API 和 Team Token 时，会同时更新同源页面使用的共享浏览器配置。随后打开 `apps/vehicle-hmi/` 会自动继承同一 API/Token；已经打开的页面也会重连。该能力只适用于协议、域名和端口完全相同的页面，不同域名或端口受浏览器同源策略隔离，仍需分别配置。

公网 Render 冷启动或 TLS 短暂重置时，Health/State GET 最多进行三次有限重试，每次有 45 秒硬超时；事件日志会立即显示重试和连接进度。预置任务先读取 State，再后台检查 Health，Health 慢或暂时失败不会阻塞兜底任务。

所有按钮发送标准事件；禁止通过直接改数据库或内存对象来跳过 Agent 状态机。

## 当前实现

当前目录提供一个独立 Web 控制台：

- `index.html`：控制台页面。
- `styles.css`：浅背景、卡片化、蓝/橙主色视觉。
- `app.js`：Agent API 客户端、SSE/轮询状态同步、标准事件发送和日志。
  控制台事件重试会复用同一轮稳定 `event_id`，避免重复创建任务或动作。事件日志记录 `event_id`、HTTP 状态、duplicate、revision 和请求耗时。
- `tests/e2e_connection_layout.py`：验证 Console 保存配置后正式 HMI 可连接同一 Session，并覆盖 1920×1080、1600×900、1366×768、1280×720、1024×768 的步骤 1/2 动态布局。

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
- `Team Token`：连接启用共享访问的 Agent 时填写，保存到浏览器 `localStorage`。
  默认 Agent API 为团队主公网地址 `https://auri-agent-api.onrender.com`；备用 LangChain 地址和本地 Agent 均可通过页面按钮切换。

不要把团队 Token、OpenAI API Key 或其他密钥提交到仓库。

## 事件映射

| 控制台按钮 | 接口 | 事件或操作 | 说明 |
| --- | --- | --- | --- |
| 同步手机语音任务 | `GET /v1/state` + SSE | 状态刷新 | 初始保持空任务；收到手机创建任务产生的首个非空 `tasks[]` revision 后自动完成，并进入“会议延迟”，无需点击第 1 步。 |
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
- 手机通过 `/v1/chat` 或标准 `task.created` 创建首批任务后，控制台根据同一 Session 的非空 `tasks[]` 自动完成第 1 步；演示者无需再点击“同步手机语音任务”，可直接执行“会议延迟”。手机可以先于 Console 创建任务：Console 后打开或断线重连时，当前非空任务快照同样会解锁主线，不依赖页面在线时发生的 `0 -> N` 瞬时变化。
- SSE 客户端兼容 LF/CRLF 分帧、`data:` 后有无空格及同一事件的多行 `data:`；每次状态仍按 `session_id + revision` 去重。
- 现场手机端失败时，控制台侧栏的预置任务按钮作为可选兜底，但仍走正式 API。
- 预置任务按钮在 State 尚未加载时仍可点击；它会先保存当前 Agent 地址和 Token、完成连接，再通过正式 `task.created` 事件载入结构化 `tasks[]`。该兜底不调用 LLM，避免公网模型延迟；已有任务时自动锁定，避免覆盖手机任务。
- 预置任务成功后自动完成“同步手机任务”阶段，按钮显示“已载入”，卡片就地显示任务数和“下一步：会议延迟”；连接或鉴权失败也在按钮旁显示原因和“重新载入”，无需到页面底部查 Event Log。
- 步骤按钮内部的编号、标题和说明为稳定 DOM，执行后只更新状态样式，不得用 `textContent` 覆盖按钮结构。
- 任务、动作、车辆状态、Ledger 和日志均使用文本节点渲染，长内容自动换行，不能把 World State 字符串直接插入 HTML。
- 主故事创建任务后锁定服务模拟配置，避免现场误切成功/缺货/超预算分支。
- 确认请求结果不明确时先重新读取 `/v1/state`，确认仍为 pending 才允许重试。
