# 车机 HMI

> 开发前先阅读根 [README](../../README.md) 的 P0 闭环、唯一主交互端和 AURI 视觉基线。

团队协作同事请先阅读 [TEAM_GUIDE.md](./TEAM_GUIDE.md)。

定位：驾驶阶段的安全展示和单一确认入口，运行在横屏平板、大屏或电脑浏览器，不接真实车辆。

P0 区域：路线/ETA、Agent 状态、现实结论、动作列表和“确认发送”大按钮。驾驶中不做长文本、多选决策、完整 turn-by-turn 导航、多轮聊天或真实车控。

驾驶主屏采用 3:7 布局：左侧是驾驶员近侧 AURI 面板，右侧是持续可见的导航主画布。导航默认使用可控 SVG 离线地图；配置高德 Web JS API Key 后，可切换为真实底图、驾车路线、实时交通图层和车辆沿线动画。两种地图共用同一套 Agent 状态覆盖层，灰色表示已行驶、蓝色表示剩余路线，黄色表示拥堵风险。主屏只保留一句判断、一个动作组、一个主要确认入口、ETA 和刚性/弹性任务摘要；速度、限速和档位放在地图右上角。消息草稿、方案、行程、车况和三端同步通过驾驶员侧原位二级页查看，不遮罩或压暗地图。

在线路线进度按真实累计距离计算，不按高德返回的坐标点数量计算；车辆位置、已行驶路线、剩余路线和前方拥堵段使用同一套距离进度。高德路线仅在 HMI 页面初始化时规划一次，World State、SSE、轮询和 Demo 阶段变化只更新现有覆盖物。浏览器本地设置每月 200 次地图初始化和 200 次路线规划的保守保护阈值，达到后自动回退离线地图。

底部任务摘要使用“责任类型 + 任务 + 状态标签”，刚性责任和弹性任务不会只靠颜色区分。行程摘要使用“大数字 + 小单位”展示剩余距离、预计用时和到达时间，1280×720 下不得截断关键值。

高德地图配置、安全代理和隐私边界见 [高德地图接入车机 HMI](../../docs/amap-hmi-integration.md)。

浏览器 Console 可检查当前地图状态和本地调用计数：

```js
window.AURI_HMI.getMapStatus()
window.AURI_HMI.getMapUsage()
```

## 地图阶段与动画

地图不是固定背景。`WorldState.stage` 会映射为六种导航模式：

| 地图模式 | World State 阶段 | 地图表现 |
| --- | --- | --- |
| `overview` | `off_vehicle_idle`、连接中、停车复盘 | 路线总览、低强调，等待手机任务或复盘。 |
| `preview` | `pre_departure_warning`、`handover_to_vehicle` | 显示 `17:38 前出发` 或手机到车机的路线流转。 |
| `guidance` | `vehicle_observation` | 进入驾驶视角，显示下一转向、车道级引导、速度和路线进度。 |
| `alert` | `takeover_L2`、`takeover_L3` | 放大前方拥堵路段，黄色路况和晚到事件成为主视觉，弱化无关 POI。 |
| `takeover` | `planning`、`waiting_confirmation`、`executing` | 保持当前路线，提示 AURI 正在处理或动作待确认。 |
| `recovery` | `action_completed`、`cooldown` | 拥堵段转为恢复绿态，显示“已处理，保持当前速度”。 |

阶段切换使用一次性缩放、淡入和指引卡过渡；驾驶路线流向采用低频运动。页面遵循 `prefers-reduced-motion`，系统要求减少动态效果时会关闭动画。

## 压力提醒与跨端接力

- `pre_departure_warning`：车机显示短时腕上提醒，明确“黄色提示 + 双短震”。
- `takeover_L2`：显示驾驶 Heads-up 通知，说明预计晚到和腕上已同步提醒；保留到阶段切换或用户关闭。
- `takeover_L3`：显示高负荷提醒，明确已减少非必要提示和腕上组合振动。
- 提醒只有来源、核心结论和反馈方式，不展示长消息或多个并列动作。
- 左侧跨端接力卡持续显示手机、腕上、车机的主端/只读/反馈状态，证明同一 World State 已同步到三端。

## Agent 接入方式

HMI 是 World State 渲染器，不是状态机。页面启动后读取 `/v1/state`，并默认连接 `/v1/stream` 接收 SSE 更新。

```html
<script>
  window.AURI_CONFIG = {
    apiBase: "https://auri-langchain-agent-api.onrender.com",
    token: "",
    stream: true
  };
</script>
```

如果使用云端 Agent，可在本地调试页注入 `apiBase` 和 `token`。不要把团队 Token 或 API Key 提交到代码仓库。

当前 HMI 左侧快捷栏底部提供 `连接` 配置入口。团队协同时：

1. 打开车机 HMI 页面。
2. 点击左侧快捷栏底部 `连接`。
3. 选择 `LangChain 公网` 或手动填写 `Agent API`。
4. 在 `Team Token` 输入框填写团队令牌。
5. 点击 `保存并重连`。

配置保存在当前浏览器 `localStorage`，不会写入仓库。公网页面不能继续使用 `127.0.0.1` 作为 Agent API，因为那只代表访问者自己的电脑。

HMI 同时兼容本地 Agent 和公网 Agent：

- 本地开发：`http://127.0.0.1:8000`
- 团队公网联调：`https://auri-langchain-agent-api.onrender.com`
- 旧版回退：`https://auri-agent-api.onrender.com`

状态同步采用 SSE `/v1/stream` 加 `/v1/state` 轮询兜底。公网环境中如果 SSE 被浏览器、代理或部署平台中断，HMI 仍会通过轮询更新状态。

新版公网 Agent 使用 LangChain 工具编排自然语言，但 HMI 不直接调用工具。HMI 仍只消费 `WorldState`，并通过 `/v1/confirm` 处理车机确认。

## 主驾驶侧 Agent 交互

左侧 Agent 面板提供驾驶中可操作的轻量入口：

- `我还来得及吗？`：在 `primary_surface=vehicle_hmi` 且未进入待确认状态时启用，点击后向 Agent 发送标准 `user.utterance` 事件。
- `方案`：查看刚性责任、弹性任务、动作组和服务方案摘要。
- `车况`：查看空调、风量、驾驶场景、主交互端和腕上反馈。
- `同步`：查看手机、腕上和车机三端状态。
- `消息草稿` / `行程详情`：查看草稿摘要和 ETA 解释。

左侧快捷栏、Agent 面板按钮、地图任务卡和底部 Dock 共用同一组二级页。二级页打开后替换左侧 Agent 面板，地图、ETA 和底部确认入口保持可见；返回后回到 AURI 主判断。二级页在 World State 更新时同步刷新。

这些入口只承载驾驶中可快速理解的信息；长文本、商品明细和复杂选择仍放到手机端或停车后复盘。Agent 返回的长回复不会原样铺在主屏，HMI 会按驾驶输出预算压缩为一条现实结论，完整摘要进入二级页。

消息二级页按“联系人 / 模拟消息 / 状态 / 分段正文”排版。长消息必须自然换行，完成摘要会按消息结果、订单数量金额和配送时间拆段，禁止用单行省略号隐藏关键事实。

## 车辆状态展示

HMI 读取 `WorldState.vehicle_state` 展示空调状态：

- `ac_on`
- `ac_target_temp`
- `ac_mode`
- `fan_speed`

该字段由 Agent 的 `control_ac` 工具写入。HMI 只读展示，不提供直接改写空调的按钮；如果后续需要车机语音或方向盘键控制，应提交标准用户意图或事件，让 Agent 工具链处理。

## 允许的写操作

- 标准事件：`POST /v1/event`
- 车机确认：`POST /v1/confirm`
- 演示重置：`POST /v1/session/reset`

页面禁止直接改写 stage、pressure、tasks、actions、confirmation 或 service order。语音和按钮使用同一个 `confirmation_id`，由后端保证幂等。

## 确认入口规则

确认按钮只有在以下条件同时满足时才可点击：

- `primary_surface=vehicle_hmi`
- `confirmation.owner_surface=vehicle_hmi`
- `confirmation.status=pending`

生活服务方案在车机只显示商品数、总价和配送时间，不显示完整商品列表。

调试时可在 URL 后追加 `?debug=1` 显示 HMI 内置事件按钮；正式展示默认隐藏，现场推进统一使用独立 Demo 控制台。

调试指定二级页可追加 `?detail=plan`，支持 `plan`、`drafts`、`route`、`sync` 和 `vehicle`。
