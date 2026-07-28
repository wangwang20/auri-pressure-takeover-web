# 车机 HMI 团队协作操作指南

本指南面向团队协作同事，用于运行和联调 `apps/vehicle-hmi/`。不要在本文档或代码中写入真实 Team Token、OpenAI API Key、联系人、地址或支付信息。

## 模块定位

车机 HMI 是驾驶阶段的安全展示端，不是业务状态机。

它只做三件事：

- 消费 Agent 返回的完整 `WorldState`。
- 按 `stage`、`primary_surface`、`risk`、`actions` 和 `confirmation` 渲染驾驶界面。
- 在车机是唯一确认端时调用 `/v1/confirm`。

它不能做：

- 直接设置 `stage`、`pressure_level` 或动作完成状态。
- 自行生成 `confirmation_id`。
- 绕过 Agent 直接让页面进入“已处理”。
- 在驾驶中展示长聊天、多选复杂决策或完整商品明细。

主屏默认只保留驾驶中必要信息。当前布局为：

- 左侧 30% 主驾驶侧：AURI 判断、现实结论、语音求助、动作摘要和二级页入口。
- 右侧 70%：持续可见的导航、ETA、责任窗口、刚性/弹性任务卡、速度、限速和档位。
- 底部：左侧唯一确认按钮、中央语音提示、行程/消息快捷入口和空调只读摘要。
- 左侧快捷栏底部：Agent 连接配置。

消息草稿、行程详情、方案详情、车况详情和三端同步通过主驾驶侧原位二级页查看；二级页不得使用整屏灰色遮罩，导航和确认入口需要保持上下文可见。不得把控制台日志、商品长列表或消息全文铺在主屏上。

底部任务和行程卡必须在 1280×720 完整显示 `18:10 接孩子`、`不可后置`、剩余距离、预计用时和预计到达，不得用省略号隐藏这些关键值。消息正文只能进入二级页，并按段落换行。

风险提醒采用短时或阶段内 Heads-up 通知：

- L1 明确“黄色提示 + 双短震”。
- L2 明确预计晚到和腕上已同步。
- L3 明确已减少非必要提示和一次组合振动。
- 通知不得覆盖左上转向卡、速度/限速区或底部确认入口。

导航画布由 `WorldState.stage` 驱动，不允许写成固定背景：

| 阶段 | 地图模式 | 必须出现的变化 |
| --- | --- | --- |
| `off_vehicle_idle` | 路线总览 | 地图低强调，等待手机创建任务。 |
| `pre_departure_warning` | 出发预警 | 显示最晚出发标记和窗口压缩。 |
| `handover_to_vehicle` | 路线流转 | 明确手机路线正在交接到车机。 |
| `vehicle_observation` | 驾驶导航 | 显示转向、车道级引导、速度和路线进度。 |
| `takeover_L2/L3` | 拥堵告警 | 黄色拥堵段、晚到事件、车辆当前位置和腕上联动通知成为焦点。 |
| `planning/waiting_confirmation/executing` | Agent 接管 | 地图保持驾驶上下文，提示无需额外操作或等待确认。 |
| `action_completed/cooldown` | 恢复 | 路段恢复绿态，显示已处理提示并降低打扰。 |

阶段变化应使用短时过渡动画，不使用循环闪烁。必须支持 `prefers-reduced-motion`。当前地图是 HMI 模拟图层，不接真实地图 SDK；不要在前端伪造实时导航数据，地图文本和 ETA 必须来自当前 Demo 状态或冻结演示数据。

## 启动页面

### 公网直接访问

不需要拉代码或启动静态服务器，横屏打开：

```text
https://wangwang20.github.io/auri-pressure-takeover-web/apps/vehicle-hmi/
```

第一次使用仍需点击左侧 `连接`，填写团队 Agent API 和负责人单独提供的 Team Token。公网静态页面不包含 Token、OpenAI API Key 或后端环境变量。

### 本机访问

从仓库根目录启动静态服务：

```bash
python -m http.server 5174
```

打开：

```text
http://127.0.0.1:5174/apps/vehicle-hmi/
```

### 局域网访问

让同一网络中的手机、平板或其他电脑访问开发机：

```bash
python -m http.server 5174 --bind 0.0.0.0
```

查询开发机局域网 IP 后，其他设备打开：

```text
http://<开发机局域网IP>:5174/apps/vehicle-hmi/
```

三种访问方式共用同一套前端代码。页面地址可以是公网、`127.0.0.1` 或局域网 IP，但 Agent API 仍需在页面内单独配置。

## 连接本地 Agent

本地开发时先启动 Agent：

```bash
python -m uvicorn \
  auri_agent.app:app \
  --app-dir services/agent-api/src \
  --host 127.0.0.1 \
  --port 8000
```

打开车机 HMI 后：

1. 点击左侧快捷栏底部 `连接`。
2. 点击 `本地 Agent`。
3. Team Token 留空，除非本地后端开启了共享访问。
4. 点击 `保存并重连`。

## 连接团队公网 Agent

推荐公网 Agent 地址：

```text
https://auri-langchain-agent-api.onrender.com
```

旧版回退地址：

```text
https://auri-agent-api.onrender.com
```

打开车机 HMI 后：

1. 点击左侧快捷栏底部 `连接`。
2. 点击 `LangChain 公网`。
3. 在 `Team Token` 输入框填写团队负责人提供的令牌。
4. 点击 `保存并重连`。

注意：

- Team Token 只保存在当前浏览器 `localStorage`。
- 不要把 Team Token 写入仓库、截图、PR 描述或聊天记录。
- 不要把 OpenAI API Key 写入任何前端文件。
- 如果页面部署在公网，Agent API 不能填 `127.0.0.1`，否则会访问使用者自己的电脑。
- HMI 不直接调用 LangChain 工具，只消费 Agent 返回的 `WorldState`。
- 旧版回退地址只在新版 LangChain 服务不可用时使用。

## 可选高德在线地图

HMI 默认使用 SVG 离线演示地图，不依赖外部地图服务。需要真实道路、驾车路线和交通图层时，在左侧 `连接` 的“导航地图”区域配置：

```text
地图来源：高德在线地图
高德 Web JS API Key：Web端（JS API）Key
Security JS Code：本地 Demo 使用
安全代理地址：正式公网部署优先使用
```

约束：

- 不把 Key 或 Security JS Code 写入代码和团队文档。
- 高德 Key 缺失或调用失败时自动回退离线地图。
- 高德只负责地图上下文；Agent 的 ETA、晚到判断、任务和确认仍是唯一业务事实。
- 公网 Key 必须允许当前 HMI 域名。
- 正式环境使用服务端代理保存 Security JS Code。
- 当前浏览器每月最多初始化地图 200 次、规划路线 200 次；达到后自动回退离线地图。
- 重跑故事线使用 Console 的 `重置 Demo`，不要通过反复刷新 HMI 重置。
- Console 事件、SSE 和轮询不会重新调用高德路线规划。

检查本浏览器地图状态和调用计数：

```js
window.AURI_HMI.getMapStatus()
window.AURI_HMI.getMapUsage()
```

完整说明见：

```text
docs/amap-hmi-integration.md
```

## 车载状态和空调联动

Agent 新增 `vehicle_state` 字段后，HMI 会只读展示空调状态：

```text
vehicle_state.ac_on
vehicle_state.ac_target_temp
vehicle_state.ac_mode
vehicle_state.fan_speed
```

该状态来自 Agent 的 `control_ac` 工具。HMI 不直接控制空调，不绕过 Agent 写 World State。联调方式见 `docs/ac-control-hmi-handoff.md`。

## 状态同步机制

HMI 使用两种方式同步 Agent 状态：

- SSE：`GET /v1/stream`
- 轮询兜底：`GET /v1/state`

客户端只接受相同 `session_id` 且更高 `revision` 的快照。

如果公网 SSE 被代理或浏览器中断，HMI 会通过轮询继续更新，不需要手动保存重连。

正式展示时 HMI 内置事件按钮默认隐藏。需要本地调试时，在地址后追加：

```text
?debug=1
```

## 与 LangChain Agent 的关系

新版公网 Agent 使用 LangChain 做自然语言工具编排，但 HMI 的接入方式不变：

```text
GET /v1/state
GET /v1/stream
POST /v1/confirm
```

HMI 不读取工具调用细节，不从聊天回复反推状态，也不直接调用 `create_tasks`、`prepare_assistance` 等工具。工具结果最终会体现在 `WorldState.tasks`、`actions`、`confirmation` 和 `output.conclusion` 中，HMI 只按这些字段渲染。

## 主驾驶侧交互规则

左侧 `我还来得及吗？` 是驾驶中主动求助入口，不是静态展示按钮。启用条件：

```text
primary_surface = vehicle_hmi
stage in [vehicle_observation, takeover_L2, takeover_L3, planning]
confirmation.status != pending
```

点击后页面提交标准事件：

```text
POST /v1/event
type = user.utterance
source = vehicle_hmi
payload.text = 我还来得及吗？帮我处理
```

`方案`、`车况`、`同步`、`消息草稿`、`行程详情`均为二级信息入口，只读展示当前 `WorldState` 摘要，不直接改写状态。二级信息在主驾驶侧原位替换 AURI 面板，保持地图和底部确认入口可见，不做网页式全屏遮罩。二级页打开期间收到新 revision 时，内容必须同步刷新。

驾驶输出预算：

- 主屏现实结论最多两句，优先呈现“继续加速无法明显缩短时间”等现实判断。
- 动作组最多显示三条短摘要。
- 待确认时只保留一个底部主要 CTA；语音求助入口进入不可操作提示态。
- 完成后显示“需要时再叫我”并降低视觉强调。

## 车机确认规则

确认按钮只有在以下条件同时满足时启用：

```text
primary_surface = vehicle_hmi
confirmation.owner_surface = vehicle_hmi
confirmation.status = pending
```

确认请求：

```http
POST /v1/confirm
```

请求体由页面根据 `WorldState.confirmation.confirmation_id` 生成。前端不得自己创建新的确认 ID。

## 标准联调流程

建议同时打开：

```text
车机 HMI:
http://127.0.0.1:5174/apps/vehicle-hmi/

Demo 控制台:
http://127.0.0.1:5174/apps/demo-console/
```

在控制台按顺序推进：

| 步骤 | 控制台按钮 | 车机期望表现 |
| --- | --- | --- |
| 1 | 重置 Demo | 车机回到初始状态。 |
| 2 | 创建任务 | 任务卡出现接孩子和超市，地图保持路线总览。 |
| 3 | 会议延迟 | 显示出发窗口压缩、`17:38 前出发` 标记，风险 L1。 |
| 4 | 接近车辆 | 显示路线流转动画，进入交接到车机状态。 |
| 5 | 进入车辆 | 主交互端切到车机，地图进入车道级驾驶导航。 |
| 6 | 拥堵加剧 | 地图放大前方路段，黄色拥堵段显示晚到 18 分钟，进入 L2。 |
| 7 | 用户求助 | 地图保持驾驶上下文，出现动作组和确认按钮。 |
| 8 | 确认发送 | 拥堵段转恢复绿态，地图显示“已处理，保持当前速度”。 |
| 9 | 低干扰恢复 | 进入 cooldown。 |
| 10 | 停车复盘 | 主端回到手机。 |

## 常见问题

### 页面打开但状态不更新

检查：

- HMI 和控制台是否连接同一个 Agent API。
- Team Token 是否正确。
- 浏览器 Network 中 `/v1/state` 是否 200。
- 浏览器 Network 中 `/v1/stream` 是否成功或轮询是否持续。

如果配置曾经连过旧地址，可在浏览器 Console 执行：

```js
localStorage.removeItem("auri-hmi-config")
location.reload()
```

然后重新通过底部 `Agent` 配置。

### 确认按钮不可点击

这通常是正确行为。只有车机是 `primary_surface` 且确认 owner 是 `vehicle_hmi` 时才可点击。

用 `/v1/state` 检查：

```text
primary_surface
confirmation.owner_surface
confirmation.status
```

### 页面连接公网 Agent 返回 401

说明 Team Token 缺失或错误。请向 Agent Owner 获取令牌，并只填在浏览器配置中。

## 提交前检查

修改 HMI 后至少运行：

```bash
node --check apps/vehicle-hmi/app.js
git diff --check
```

还要确认：

- 没有提交 Team Token。
- 没有提交 OpenAI API Key。
- 没有让前端直接设置最终 World State。
- HMI 仍可连接本地 Agent 和公网 Agent。
