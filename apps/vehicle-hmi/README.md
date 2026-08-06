# AURI Vehicle HMI

这是基于 Bosch-Agent 真实运行底座重建的 AURI 正式车机 HMI。旧版原型保留在 `apps/vehicle-hmi-legacy/`，仅用于回溯，不再作为产品入口。

团队运行与联调请先阅读 [TEAM_GUIDE.md](./TEAM_GUIDE.md)。

当前完成 Route / Location 导航契约验收：AURI 品牌外壳、Agent World State、高德真实底图与路线、驾驶员侧接管确认、本地完整主线和 AURI 体验补全均已实现。页面保留 Bosch-Agent 的高清车辆、地图舞台、路线控制器、右侧驾驶概览和底部 Dock；标准 16:9 与超宽座舱会扩展中央地图并重排驾驶区，避免黑边和小字号。任务、ETA、风险、手机语音、腕上设备、动作、空调和导航坐标来自 Agent 完整快照；座舱调节通过标准 Event 回写 Agent，不在浏览器内直接改状态。

## 运行

在仓库根目录执行：

```bash
python -m http.server 5174
```

访问：

```text
http://127.0.0.1:5174/apps/vehicle-hmi/
```

## 已完成能力

- AURI Logo、名称、口号和品牌 Token。
- 无任务首屏与“等待手机同步路线”状态。
- 底部 Dock 冻结为五个明确入口：AURI 首页、导航、任务、处理、座舱；音乐等未实现入口不伪装成可用功能。
- 所有二级内容仍留在驾驶员侧 AURI 区域：任务按刚性/弹性分组，处理页展示动作队列，座舱页使用温度和模式控件；设备同步从设备状态行进入，不重复占用 Dock。
- 旧疲劳、咖啡和演示控制入口在正式页面休眠并不可操作。
- 车辆可见 Bosch 字样由 AURI 标识层遮盖，保持原高清车辆资产质量。
- 原地图路线、道路层次、车辆路径控制器和驾驶区动画机制保持可用。
- 1920x1080、1600x900、1280x720 浏览器回归通过。
- `GET /health`、`GET /v1/state` 和带 `X-Agent-Token` 的流式 `fetch` SSE。
- SSE 中断后轮询兜底、指数退避、重连快照对账和请求超时。
- 相同 Session 只接受更高 revision；Session 切换后拒绝已退休 Session 的延迟响应。
- 任务支持 0-N 项；不写死接孩子、超市、目的地、18:28 或动作数量。
- 只读展示 `last_utterance`、`wearable`、`actions` 和 `service_orders`；`vehicle_state` 由 Agent 统一写入，HMI 只能通过 `vehicle.control` 标准 Event 请求变更。
- 消息卡直接读取 Agent `actions[type=message].message_draft.body`，主屏显示短预览、二级页显示完整正文；旧后端仅回退到 `summary`，不再显示前端预设消息。
- 采购方案通过 `Action.details_ref` 关联 `service_orders[].preview_id/order_id`，二级页保留逐项商品、数量、单价和小计。给车机负责人的完整映射与验收步骤见 [`docs/hmi-agent-actions-contract.md`](../../docs/hmi-agent-actions-contract.md)。
- 座舱页支持 AC 开关、16-30°C 温度、自动/制冷/制热/送风和低/中/高风量；一次只提供一个“应用设置”CTA，请求失败不显示假成功。
- 车机设置成功后 revision 增加，手机和 HMI 通过同一 World State/SSE 显示相同座舱状态；相同 `event_id` 重试不会重复执行。
- 空调类输出只进入座舱状态，不占用驾驶现实结论。
- 本地、公网和 LangChain Agent 地址可配置；Token 不写入仓库，界面和诊断 API 均脱敏。
- 高德 Web JS API 提供真实底图、驾车路线、交通图层、路况分段和下一导航动作。
- 高德地图挂载在 Bosch 中央舞台内；路线成功后才切换，加载失败、无任务、无坐标或额度触发时保留 Bosch 离线地图。
- 同一 Session 和目的地只规划一次路线；SSE revision 更新只推进车辆和路线分段，不重复消耗路线规划次数。
- Demo 车辆进度按 Agent `navigation.progress` 在路线累计距离上插值，箭头朝向来自路线切线；跟车相机随路线旋转，路线总览和缩放可操作。当前是“真实地图与路线 + Demo 位置回放”，不对外宣称真实 GPS 或原生高德导航 SDK。
- 跟车视觉按高德导航的“锁车态 + 车头朝上”实现：真实高德底图和真实规划路线随进度移动，自车固定在地图下部，路线向屏幕前方延伸；全览态使用高德 `setFitView` 展示完整路线，返回后恢复跟车相机。
- 底图强制保留 `road/point/building` 与 `showLabel`。跟车缩放采用接近旧公网高德页的 `15.8-16.2`，保留 `24-28°` 轻度 3D；缩放、俯仰和旋转仅在距离档位、阶段或航向确有变化时更新。HMI 从真实 `DrivingResult.steps[].road` 提取导航道路名，并对每条路线执行一次 `AMap.PlaceSearch.searchNearBy`，最多补充 10 个真实周边地点；跟车和全览均可展示，但不会随进度反复搜索。道路和地点均不写死，搜索失败不影响原生底图和路线。
- Agent 形成可执行方案时，驾驶员左侧常驻卡片以更大字号展示处理项和状态；进入待确认阶段后只出现一次低干扰方案提示，随后仍可从左侧查看全部方案并通过唯一主按钮确认，不遮挡持续导航。
- `service_prepared` / `waiting_confirmation` 时，HMI 根据当前 World State 的晚到分钟、动作数量和确认端生成一次中文语音简报，具体联系人和订单细节留在视觉卡片；同一 Session 与方案指纹不重复播报，无关 revision（例如空调状态更新）不会重播。`action_completed` 使用当前执行结果生成完成简报。勿扰/静音时不播报，TTS 不可用不阻塞视觉和确认流程；`window.AURI_HMI_NEXT.replaySolutionBriefing()` 提供用户主动重播钩子，不新增第二个主 CTA。
- 桌面 Linux 上仅当浏览器 WebGL 实测可用、且高德平台门禁错误降级为 2D 时，SDK 加载器才临时提供桌面 WebGL 兼容提示；SDK 完成加载后立即恢复原始 `navigator`。随后必须回读有效 `pitch` 才标记为原生 3D，不能用请求参数冒充生效结果。
- 高德仍回读 `pitch=0` 时保留真实 2D 高德路线全览和地理位置车标，并禁用“3D 跟车”；不旋转整个高德 DOM，也不切换成 Bosch-Agent 假导航。当前实现是 Web Demo 的真实地图/路线回放，不对外宣称已接入 Android/iOS 原生导航 SDK。
- Agent 通过可选 `WorldState.navigation` 发布 `route_id`、关联任务、起终点坐标、来源、模拟属性和进度；HMI 优先消费正式对象。
- 旧服务没有 `navigation` 时才使用 HMI 冻结映射；未知地址不调用地理编码并保持离线降级。
- Agent `eta` 和 `risk.late_minutes` 仍是业务真相；高德距离、道路、路况和转向只用于导航表现。真实定位、偏航检测、动态重规划和原生语音引导属于产品化接口。
- 浏览器按月软限制默认 200 次地图初始化、200 次路线规划和 60 次周边 POI 搜索，避免演示误触持续消耗免费额度。
- 风险接管阶段在驾驶员侧原导航卡位置切换为 AURI 判断卡，不增加第二列网页卡片。
- 判断卡保持一句结论、最多三条动态动作、三端状态和一个主要确认入口。
- 手机语音转写在接管卡状态行和 AURI 二级页同步显示，车机不提供语音输入。
- 腕上状态以一次性通知横幅出现，按 `session_id + command_id` 去重，可自动消失或手动关闭。
- 只有 `primary_surface=vehicle_hmi`、owner 为车机且 confirmation pending/未过期时才显示确认按钮。
- 点击和方向盘 Enter 共用后端 `confirmation_id`；重复点击不会产生第二次执行请求。
- `/v1/confirm` 成功后消费 Agent 返回快照；完成态来自更高 revision，不由 HMI 提前推演。
- 401、WRONG_SURFACE、EXPIRED、NOT_FOUND 和网络失败显示低干扰错误，保留导航和原方案，不显示假成功。
- 停车后原导航卡切换为“手机继续处理”，完整消息、订单和处理记录转回手机端，车机不继续显示过期 ETA。
- 本地真实 Agent 主线从空任务推进到停车复盘，连续 10 次通过；公网只读检查仅确认 State 可读取且 SSE 返回 200，新版心跳和持续实时更新必须在部署后单独验收。
- 原导航卡加入动态责任摘要：最多显示两项刚性/弹性任务及 `+N`，点击进入完整任务页，不写死任务数量或名称。
- 导航卡恢复 ETA、剩余分钟和剩余公里；高德路线元数据提供动态剩余时长，离线时仅显示可确认的数据。
- 增加行程详情、设备状态、任务详情、联系人/动作详情等 Bosch 风格二级页；长消息和订单明细不占据驾驶主屏。
- 接管主屏的“AURI 已准备”和每一项动作均可点击进入“处理进度”二级页；完成态显示动态完成数和百分比，再从列表进入消息或订单详情。
- 手机、腕表、车机的主端和同步状态可随 `primary_surface`、`last_utterance`、`wearable` 和连接状态查看。
- 车辆接续、正常导航、完成恢复使用非模态通知；车外/L1 和停车后车机保持静默，不抢占手机主端。
- 腕表提示仅在车机成为主端后展示；设备未连接时明确显示“等待同步”，不冒充已送达。
- 服务订单主卡使用结构化摘要，显示模拟属性、件数/种类、金额和配送时段；失败时保留消息和任务调整方案。
- `action_completed` 只进行一次恢复 TTS，并按 `session_id + output.message_id` 去重；cooldown 不重复播报。
- 确认按钮按过期时间自动关闭；网络结果未知时保持锁定，完成 `/v1/state` 对账后才允许重试。
- World State 校验覆盖必填字段、Stage、Scene、Owner 和主要数组；非车机 Owner 的 output 不进入车机主结论。
- 正式页不再加载旧 Leaflet/二维码外部依赖，旧咖啡订单恢复、旧语音和旧导演控制器在 AURI 模式下不启动。
- 手机使用的 `/v1/chat`、Demo Console 和 HMI 已在同一本地 Session 完成跨端主线：任务创建、会议延迟、进入车辆、拥堵、手机语音求助、车机确认、cooldown 和停车复盘均由统一 revision 驱动。
- Console 会在收到手机首个非空任务 revision 后自动放行“会议延迟”，不再要求演示者手工确认任务同步；自动化回归直接使用手机 `/v1/chat` 创建任务和求助。
- 手机空调口令可结构化写入 `vehicle_state` 的开关、温度、模式和风量；Console 与 HMI 通过同一 SSE 快照同步展示，不保留本地业务副本。
- HMI 主动断开状态流后，由 Console 推进 Agent；重新连接会先拉取最新 State 再恢复 SSE，验证无状态漂移。
- 1920x720 超宽座舱验收通过：画布覆盖全屏，现实结论实际 32px、动作正文 18px、主按钮 56px，确认卡、地图、腕上通知和底部 Dock 无重叠或裁切。
- 9 个真实稳定阶段和 6 个只读瞬态/错误阶段完成 1920x1080 截图回归，关键容器无越界、内部溢出、破图或 JavaScript 错误。
- Bosch 离线路线在 9 个真实阶段产生 9 组不同 transform，验证路线和车辆场景确实随 World State 推进。
- 车外、接近车辆和停车阶段速度归零；驾驶阶段的 `68` 明确标记为 Demo 车辆信号，不冒充 Agent 契约字段。
- SSE 真正断开 15 秒期间页面不假更新；恢复网络后先取最新快照并重新进入 streaming。
- 30 分钟长稳采样通过：Heap、DOM、Document、Timeout、Interval 和 RAF 均无持续增长，未检测到重复计时器。
- 高德 SDK 加载或路线规划永不返回时，1800ms 硬超时并恢复离线演示地图；外部配置不能放宽到 2 秒以上。
- 同一失败路线在后续 revision 中不会重复规划或消耗免费额度；新路线仍可重新尝试。
- 地图故障的技术原因只保留在返回值和状态详情中，甲方界面统一显示“已切换离线导航”。

## 当前没有实现

- 目标展示设备上的 45 FPS 实机验收；无 GPU headless Chromium 只作为资源稳定性基线。
- WebSocket 可选兼容路径、真实腕表硬件和完整四端现场联调。
- 公网共享 Agent 的完整写入主线；当前只允许在团队约定的专用 Session 和时间窗口执行，避免改写他人演示状态。
- 真实车辆 `current_location` 与非模拟路线进度；当前 Demo 明确标记 `source=demo_fixture`、`is_simulated=true`。

剩余能力按 `myProj/Bosch-Agent底座_AURI重构/todolist.md` 完成真实腕表联调、公网写入和目标设备实机验收。旧版 `apps/vehicle-hmi-legacy/` 不再接受功能开发。

## 开发约束

- `apps/vehicle-hmi-bosch-reference/` 是只读视觉基准，不得修改。
- `index.html` 仍包含休眠的原业务控制器。Phase 1 不删除它们，避免破坏视觉和动效；后续按场景逐步替换。
- AURI 覆盖层位于 `auri-theme.css` 和 `auri-shell.js`。
- Agent 同步层位于 `src/agent-client.js`；纯视图模型位于 `src/world-state-model.js`，两者不依赖旧 HMI DOM/CSS。
- 页面默认不显示开发控制条。后续 Debug 能力必须显式受 `?debug=1` 控制。
- 任何完成态必须来自更高 revision 的 Agent World State，不能由前端自行推演。

## Agent 配置

点击左上角连接状态，在 Bosch 风格浮层中选择公网、本地或 LangChain 服务并填写 Team Token。配置只保存在当前浏览器的 `localStorage`，仓库内没有默认 Token。

正式 HMI 与 Demo Console 使用同一个同源共享连接配置。Console 保存 API/Token 后，新打开的 HMI 会直接继承；两个页面都已打开时，HMI 会停止旧 State/SSE 并按新 API 自动重连。API 与 `/v1/stream` 始终成对更新，禁止 State 连接新实例而 SSE 残留旧实例。不同域名或端口仍需分别配置。

地图默认选择“自动读取 Agent 配置”，通过鉴权接口 `GET /v1/map-config` 获取公开 Web Key 和服务端安全代理；接口不会返回安全码。当前公网部署若返回 `{"enabled":false,"provider":"offline"}`，页面会继续使用 Bosch 离线地图。仅限本机诊断时，可在折叠的“地图连接设置”中填写 Web Key 和安全码，它们同样只保存在当前浏览器，不得写入仓库或共享截图。

本机需要默认加载真实高德地图时，复制 `env.local.example.js` 为 `env.local.js` 并填写 Web Key 和安全码。`env.local.js` 已被 Git 忽略；它只在浏览器没有保存地图 Key、且没有明确选择离线模式时作为本机兜底。团队公网页面不能依赖这个文件，必须在 Render 配置 `AMAP_JS_API_KEY`、`AMAP_SECURITY_JS_CODE`、`AMAP_PUBLIC_BASE_URL` 和允许的 HMI Origin，并确认 `/health` 返回 `amap_configured=true`、`/v1/map-config` 返回 `provider=amap`。

本机语音演示同样在 `env.local.js` 配置 `SAFEDRIVER_CONFIG.ttsKey`。HMI 默认只使用已配置的 Bosch TTS；Linux/Firefox 的系统语音可能把汉字读成 “Chinese letter”，因此系统语音兜底默认关闭，只有显式设置 `systemSpeechFallback: true` 才会启用。真实 Key 不得提交到仓库。

也可在本机 `env.js` 中设置（不得提交真实 Token）：

```js
window.AURI_HMI_CONFIG = {
  apiBase: "https://auri-agent-api.onrender.com",
  token: "",
  stream: true,
  mapProvider: "auto"
};
```

使用 `?offline=1` 可跳过自动连接，用于固定夹具和视觉回归。

## 验证

```bash
node apps/vehicle-hmi/tests/world-state-model.test.cjs
node apps/vehicle-hmi/tests/agent-client.test.cjs
node apps/vehicle-hmi/tests/amap-adapter.test.cjs

/home/fly/miniconda3/envs/bosch-agent-dev/bin/python \
  apps/demo-console/tests/e2e_connection_layout.py

/home/fly/miniconda3/envs/bosch-agent-dev/bin/python \
  apps/vehicle-hmi/tests/e2e_config_interaction.py

/home/fly/miniconda3/envs/bosch-agent-dev/bin/python \
  apps/vehicle-hmi/tests/e2e_ultrawide_readability.py
```

真实高德双视角专项测试需通过环境变量临时提供 Web Key 和安全码；测试会验证实际 `rotation/pitch`、固定锁车锚点、路线移动、拥堵停车、黄/红/深红路段、全览和返回跟车，不会把密钥写入仓库：

```bash
AURI_AGENT_URL=http://127.0.0.1:8795 \
AURI_AGENT_TOKEN=<local-test-token> \
AURI_HMI_URL=http://127.0.0.1:5174/apps/vehicle-hmi/ \
AURI_AMAP_KEY=<web-key> \
AURI_AMAP_SECURITY=<security-code> \
/home/fly/miniconda3/envs/bosch-agent-dev/bin/python \
  apps/vehicle-hmi/tests/e2e_live_amap_navigation.py
```

通过截图位于 `/tmp/auri-live-amap-lock-car5/`。跟车态必须满足 `cameraRotation=requestedCameraRotation`、`cameraPitch>=50`、固定车标中心约为 `(0.50, 0.72)`，且真实路线位置投影误差不超过 4px；全览态必须为 `rotation=0`、`pitch=0` 且起终点均在地图视野内。

浏览器回归覆盖空任务、契约示例、全部二级面板、1920x1080、1600x900、1280x720，以及本地 Agent 的 `/v1/state`、`/v1/stream` 实时更新和断线追平。公网只读检查验证 State 与 SSE 建连；15 秒心跳必须在对应 Agent 版本部署后再做公网持续连接验收，不能用本地结果替代。

### 全阶段视觉回归

在独立的 `127.0.0.1:8795` Agent 已启动时运行：

```bash
/home/fly/miniconda3/envs/bosch-agent-dev/bin/python \
  apps/vehicle-hmi/tests/e2e_stage_visual_regression.py
```

脚本会真实推进 9 个稳定阶段，并从真实 `waiting_confirmation` 快照派生 6 个只读夹具。截图和结构化结果分别写入：

```text
/tmp/auri-hmi-stage-visual-regression/*.png
/tmp/auri-hmi-stage-visual-regression/summary.json
```

### 断线恢复与 30 分钟长稳

```bash
/home/fly/miniconda3/envs/bosch-agent-dev/bin/python \
  apps/vehicle-hmi/tests/e2e_resilience_soak.py
```

该脚本自行占用并清理本地 `8795` Agent，检测到公网地址或其他端口会拒绝执行。默认中断 SSE 15 秒，再每 60 秒采集一次资源和 RAF 指标，持续 30 分钟。结果写入：

```text
/tmp/auri-hmi-resilience-soak.json
```

2026-08-02 基线：断网 15.06 秒期间 revision 保持 1，恢复后 0.27 秒追到 revision 4；1805.17 秒内 31 次采样，Heap 净增 6,428 bytes，DOM/Document 净增 0，活动 Timeout/Interval/RAF 始终各 1，无重复计时器或页面错误。headless RAF 中位数 43.73 FPS，仅作为自动化基线，目标展示设备 45 FPS 仍需实机验收。

2026-08-03 正式路径复测：断网 15.07 秒期间浏览器 revision 保持 1，恢复后 0.93 秒追到 revision 4；92.18 秒内 7 次采样，Heap 净减 12,956 bytes，DOM/Document 净增 0，活动 Timeout/Interval/RAF 最大为 2/1/1，无重复定时器和页面错误，headless RAF 中位数 40.97 FPS。

### 高德故障快速降级

```bash
/home/fly/miniconda3/envs/bosch-agent-dev/bin/python \
  apps/vehicle-hmi/tests/e2e_amap_fallback.py
```

测试在 Chromium 中注入可初始化但路线永不回调的高德替身，使用正式 World State 示例触发导航。2026-08-03 正式路径复测为 1.867 秒切换到 Bosch 离线地图，路线规划计数为 1，JavaScript 错误为 0；截图写入 `/tmp/auri-hmi-amap-fallback.png`。

### 本地完整主线

先在独立端口启动本地 Agent，并在仓库根目录启动静态服务器。随后运行：

```bash
AURI_AGENT_URL=http://127.0.0.1:8795 \
AURI_HMI_URL=http://127.0.0.1:5174/apps/vehicle-hmi/ \
/home/fly/miniconda3/envs/bosch-agent-dev/bin/python \
  apps/vehicle-hmi/tests/e2e_local_happy_path.py
```

脚本会重置目标 Agent Session，只能指向独立本地 Agent；检测到 `onrender.com` 会直接拒绝执行。它真实提交标准事件、等待 SSE revision、点击车机确认，并验证停车后主端回到手机。脚本不包含任何 API Key 或 Team Token。

### Console + 手机 Chat + HMI 多端联调

使用同一独立本地 Agent 和静态服务器，运行：

```bash
AURI_AGENT_URL=http://127.0.0.1:8795 \
AURI_WEB_ROOT=http://127.0.0.1:5174 \
/home/fly/miniconda3/envs/bosch-agent-dev/bin/python \
  apps/vehicle-hmi/tests/e2e_console_hmi_sync.py
```

脚本通过手机实际使用的 `/v1/chat` 创建任务和控制空调，通过 Console 页面真实按钮推进外部事件，通过 HMI 按钮确认动作，并验证两个页面的 Session、revision、任务、语音、动作和 `vehicle_state` 一致。脚本还会暂停 HMI 状态流、推进 Agent 后重新连接，验证快照追平与 SSE 恢复。检测到 `onrender.com` 时会拒绝重置和运行。

该脚本不会预先点击“同步手机语音任务”：它要求 Console 在收到手机任务 revision 后自动将主按钮推进到“会议延迟”，用于防止真实手机联调停在第 1 步。
