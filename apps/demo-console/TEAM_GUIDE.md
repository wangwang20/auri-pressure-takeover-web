# Demo 控制台团队协作操作指南

本指南面向团队协作同事，用于运行和联调 `apps/demo-console/`。不要在本文档或代码中写入真实 Team Token、OpenAI API Key、真实联系人、地址或支付信息。

## 模块定位

Demo 控制台是现场演示导演台，用于模拟本轮不接入真实系统的外部世界。

它负责：

- 注入会议延迟、接近车辆、进入车辆、拥堵、辅助信号等标准 Event。
- 配置模拟服务状态，例如成功、缺货、超预算。
- 展示当前 `WorldState` 摘要和事件日志。
- 调用正式确认和重置接口，保证现场流程可复现。
- 进行一键预检，检查 health、鉴权、Session、revision、LLM 模式和 SSE。
- 按主线显示下一步和主持提示，降低现场误操作。
- 展示 `vehicle_state`、Action Ledger 和脱敏事件日志。
- 显示当前状态同步模式；SSE 断开时自动进入轮询兜底并重连。
- 事件日志记录 event_id、HTTP 状态、duplicate、revision 和耗时。

它不能做：

- 直接设置 `stage`。
- 直接设置 `pressure_level`。
- 直接把 action 改成 `completed`。
- 绕过 `/v1/event` 和 `/v1/confirm`。

## 启动页面

### 公网直接访问

不需要拉代码或启动静态服务器，打开：

```text
https://wangwang20.github.io/auri-pressure-takeover-web/apps/demo-console/
```

第一次使用需填写团队 Agent API 和负责人单独提供的 Team Token。公网静态页面不包含 Token、OpenAI API Key 或后端环境变量。

### 本机访问

从仓库根目录启动静态服务：

```bash
python -m http.server 5174
```

打开：

```text
http://127.0.0.1:5174/apps/demo-console/
```

### 局域网访问

开发机启动：

```bash
python -m http.server 5174 --bind 0.0.0.0
```

同一网络中的其他设备打开：

```text
http://<开发机局域网IP>:5174/apps/demo-console/
```

公网、本机和局域网页面均可连接本地或公网 Agent；局域网设备若要连接开发机上的本地 Agent，需要后端监听 `0.0.0.0` 并配置允许该页面 Origin 的 CORS。

## 连接本地 Agent

本地开发时先启动 Agent：

```bash
python -m uvicorn \
  auri_agent.app:app \
  --app-dir services/agent-api/src \
  --host 127.0.0.1 \
  --port 8000
```

控制台顶部填写：

```text
Agent API: http://127.0.0.1:8000
Team Token: 留空，除非本地后端开启共享访问
```

点击：

```text
保存配置
一键预检
连接 Agent
```

`State Sync` 应显示 `SSE 实时`。如果显示 `轮询兜底`，主线仍可继续，但导演需要确认 revision 持续更新；SSE 恢复后页面会自动切回实时模式。

## 连接团队公网 Agent

推荐公网 Agent 地址：

```text
https://auri-agent-api.onrender.com
```

备用公网地址：

```text
https://auri-langchain-agent-api.onrender.com
```

控制台顶部填写：

```text
Agent API: https://auri-agent-api.onrender.com
Team Token: 使用团队负责人单独提供的令牌
```

点击：

```text
保存配置
连接 Agent
```

注意：

- Team Token 只保存在当前浏览器 `localStorage`。
- 不要把 Team Token 写入仓库、PR、截图或公开文档。
- 公网 Agent 是共享 Demo 后端，多人同时操作会影响同一个状态。
- 备用公网地址只在负责人明确切换共享实例时使用。

## Agent Health 展示

控制台连接 Agent 时会读取：

```http
GET /health
```

页面顶部 `Agent Health` 卡片会展示：

```text
llm_framework
llm_last_mode
agent_tools_enabled
agent_last_tools
```

用途：

- 判断当前连接的是团队共享 Agent，还是负责人临时切换的备用实例。
- 通过 `agent_tools_enabled=true` 判断工具编排是否上线。
- 通过 `agent_last_tools` 查看最近一轮实际调用过哪些工具。

注意：`/health` 不返回 Team Token 或 OpenAI API Key。

## 现场导演模式

控制台会根据当前 `WorldState.stage` 判断下一步，并高亮主线按钮。建议现场使用：

```text
一键预检
重置 Demo
执行下一步
执行下一步
...
```

主线按钮会根据前置条件自动禁用。例如无任务时不能注入拥堵，没有 `pending confirmation` 时不能确认发送。Reset 会二次确认，因为公网 Agent 是共享 Session。

缺货、超预算、急刹、语音确认等内容放在“技术验证”折叠区，避免干扰 3-5 分钟主线。

## 与 LangChain 工具的边界

控制台仍然只上传标准 Event，不直接调用 LangChain 工具。

控制台负责注入这些外部事实：

```text
scene.vehicle_entered
scene.parked
traffic.updated
wearable.signal
driving.signal
service.mock.config
```

这些事实不能因为用户在聊天里说“我上车了”就由 LLM 伪造。Agent 会在收到标准 Event 后更新 `WorldState`。

## 控制台标准按钮

| 按钮 | 接口 | 事件或操作 | 说明 |
| --- | --- | --- | --- |
| 同步手机语音任务 | `GET /v1/state` | 状态刷新 | 主线第 1 步；初始为空任务，等待手机端创建后同步。 |
| 载入演示预置任务 | `POST /v1/event` | `task.created` | 侧栏可选兜底：仅手机端不可用时模拟创建“18:10 接孩子，之后去超市”。 |
| 会议延迟 | `POST /v1/event` | `meeting.overrun` | 会议延迟 20 分钟。 |
| 接近车辆 | `POST /v1/event` | `scene.approaching` | 准备交接到车机。 |
| 进入车辆 | `POST /v1/event` | `scene.vehicle_entered` | 主交互端切到车机。 |
| 拥堵加剧 | `POST /v1/event` | `traffic.updated` | 根据当前刚性任务时间计算 ETA，并注入演示晚到分钟数。 |
| 压力辅助信号 | `POST /v1/event` | `wearable.signal` | 注入心率等辅助信号。 |
| 急刹信号 | `POST /v1/event` | `driving.signal` | 注入驾驶负荷辅助信号。 |
| 手机语音求助 | `POST /v1/event` | `user.utterance` | `source=mobile`、`input_mode=voice`；转写通过 World State 同步到车机。 |
| 服务成功 | `POST /v1/event` | `service.mock.config` | 模拟服务正常。 |
| 缺货降级 | `POST /v1/event` | `service.mock.config` | 模拟缺货。 |
| 超预算降级 | `POST /v1/event` | `service.mock.config` | 模拟超预算。 |
| 确认发送 | `POST /v1/confirm` | - | 模拟车机确认按钮。 |
| 语音确认 | `POST /v1/confirm` | - | 模拟语音确认。 |
| 低干扰恢复 | `POST /v1/event` | `cooldown.elapsed` | 完成后降低打扰。 |
| 停车复盘 | `POST /v1/event` | `scene.parked` | 主端回到手机复盘。 |
| 重置 Demo | `POST /v1/session/reset` | - | 回到初始状态。 |

## 推荐演示顺序

建议每次演示前先点击 `重置 Demo`。

标准 happy path：

```text
重置 Demo
同步手机语音任务
手机端语音创建任务
会议延迟
接近车辆
进入车辆
拥堵加剧
用户求助
确认发送
低干扰恢复
停车复盘
```

期望状态：

| 阶段 | 期望 Agent 状态 |
| --- | --- |
| 同步手机语音任务 | 初始任务为空；手机创建后为 `off_vehicle_idle`，并出现实际任务。 |
| 会议延迟 | `pre_departure_warning`，L1。 |
| 接近车辆 | `handover_to_vehicle`。 |
| 进入车辆 | `vehicle_observation`，`primary_surface=vehicle_hmi`。 |
| 拥堵加剧 | `takeover_L2`，晚到 18 分钟。 |
| 用户求助 | `waiting_confirmation`，动作组待确认。 |
| 确认发送 | `action_completed`，动作完成。 |
| 低干扰恢复 | `cooldown`。 |
| 停车复盘 | `parked_review`。 |

## 与车机 HMI 联调

同时打开：

```text
http://127.0.0.1:5174/apps/demo-console/
http://127.0.0.1:5174/apps/vehicle-hmi/
```

两边必须连接同一个 Agent API。

如果控制台连接公网 Agent，HMI 也要连接公网 Agent。

如果控制台连接本地 Agent，HMI 也要连接本地 Agent。

## 常见问题

### 控制台显示 NetworkError

检查：

- Agent API 是否填错。
- 本地 Agent 是否启动。
- 公网 Agent 是否冷启动。
- 浏览器 Network 是否被 CORS 或公司网络拦截。

### 控制台显示 401

说明公网 Agent 需要 Team Token，或 Token 填写错误。

### HMI 不跟随控制台变化

检查：

- HMI 和控制台是否连接同一个 Agent API。
- HMI 是否仍保留旧的 localStorage 配置。
- 必要时在 HMI 页面 Console 执行：

```js
localStorage.removeItem("auri-hmi-config")
location.reload()
```

### 确认发送失败

检查当前 `WorldState.confirmation`：

- 是否存在；
- 是否 `status=pending`；
- `owner_surface` 是否为 `vehicle_hmi`；
- 是否已过期。

## 提交前检查

修改控制台后至少运行：

```bash
node --check apps/demo-console/app.js
git diff --check
```

还要确认：

- 控制台只提交标准 Event。
- 没有提交 Team Token 或 OpenAI API Key。
- 没有让控制台直接修改最终状态。
- 本地 Agent 和公网 Agent 均可配置。
