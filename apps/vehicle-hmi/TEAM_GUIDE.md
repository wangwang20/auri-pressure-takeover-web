# AURI 正式车机 HMI 团队操作指南

本指南面向团队协作同事。不要在本文档、源码、Issue、截图或提交记录中写入 Team Token、高德安全码、OpenAI API Key、真实联系人或个人地址。

## 模块定位

`apps/vehicle-hmi/` 是唯一正式车机 HMI，负责只读消费 Agent World State，并在确认 owner 属于车机时提供唯一确认入口。旧版位于 `apps/vehicle-hmi-legacy/`，仅用于回溯。

HMI 不负责：

- 直接改写 `stage`、`risk`、`tasks`、`actions` 或 `vehicle_state`。
- 代替手机创建语音任务。
- 在前端自行计算业务 ETA 或伪造完成态。
- 绕过 `confirmation_id` 调用动作。

## 访问地址

团队 GitHub Pages 部署后：

```text
https://954593946.github.io/pressure-takeover-agent/apps/vehicle-hmi/
```

这是团队异地协作的正式公网入口，不要求访问者与开发机处于同一局域网，也不要求开发机保持开机。异地访问时，Agent API 必须使用团队公网 HTTPS 地址；`127.0.0.1` 只指访问者自己的电脑，`192.168.*` 只能在同一局域网使用。

本机从仓库根目录启动：

```bash
python -m http.server 5174
```

然后打开：

```text
http://127.0.0.1:5174/apps/vehicle-hmi/
```

同一局域网共享时改用 `python -m http.server 5174 --bind 0.0.0.0`，其他设备访问 `http://<开发机局域网IP>:5174/apps/vehicle-hmi/`。不同网络的成员不要使用该地址，直接使用上面的 GitHub Pages。

## 连接 Agent

推荐先在同源 Demo Console 中填写 Agent API 和负责人单独提供的 Team Token，再打开 HMI。两页会共享同源浏览器配置。

源码和 GitHub Pages 部署产物不内置 Team Token；用户填写的连接配置会保存在当前浏览器的同源 `localStorage`。不要在公共电脑长期保存，也不要在截图、URL 或公开文档中传播 Token。

HMI 左上角连接状态可打开配置页。保存后必须同时满足：

```text
同步方式 = 实时流
Session != --
Revision != --
Agent Health = 正常
```

Health 正常只表示服务在线，不表示 Token 鉴权成功。错误 Token 应显示“Team Token 无效或缺失”，Session 和 Revision 保持 `--`。

## 高德地图

默认模式为“自动读取 Agent 配置”：

```text
GET /v1/map-config
```

公网真实地图必须由 Agent 返回 `provider=amap`。若返回 `provider=offline`，HMI 会显示 Bosch 离线地图；这不是空白或连接成功的假状态。

本机地图负责人可复制 `env.local.example.js` 为 `env.local.js` 做真实 Key 诊断。`env.local.js` 已被 Git 忽略，禁止提交。

高德 SDK、路线或额度异常时，HMI 应在 2 秒内回退离线地图。Agent 的 ETA、晚到分钟、任务和风险仍是业务真相，高德只提供道路和路线表现。

导航页提供“3D 跟车”和“路线全览”两种驾驶视角。跟车态应看到真实高德底图的道路、社区/园区、楼宇、商户和公共设施文字、路线向前、自车固定在下部，路线当前位置投影与固定车标误差不得超过 4px。补充道路名来自高德 `DrivingResult`；每条路线最多一次 `AMap.PlaceSearch.searchNearBy`，最多 10 个真实地点，以中性高德风格文字同时增强跟车与全览，不得写死地点或使用品牌金强调。搜索失败不得阻断原生底图和路线。高德没有返回可靠路名时隐藏补充路名，不显示“当前道路”等假标签。全览态应看到整条路线和起终点。若设备没有可用 WebGL，页面保持真实高德 2D 全览并禁用跟车。正式展示设备必须提前运行 `e2e_live_amap_navigation.py`，并人工核对跟车文字密度、拥堵停车、恢复行驶和全览切换。

Agent 处理方案必须保留在驾驶员左侧常驻区，动作名称、摘要和状态应能快速扫读。`service_prepared` / `waiting_confirmation` 可出现一次非模态提示，但不得覆盖主导航、持续闪烁或要求复杂选择；`waiting_confirmation` 只保留一个主要确认入口。15 阶段视觉回归会检查处理方案标题、动作标题字号、确认按钮高度和方案提示内容。

方案语音简报必须从当前 World State 动态生成，至少反映 `risk.late_minutes`、动作数量和确认端；具体联系人、金额和配送时段留在视觉卡片，不在驾驶语音中逐项朗读。不得写死老师、家人、采购或时间。只在车机为主交互端且方案指纹变化时自动播报，同一方案因无关 revision（例如空调变化）更新时不得重播；完成态同样根据执行后的状态生成。自动化测试通过拦截 `speechSynthesis.speak()` 验证准备和完成两段动态文本。

## 标准联调

1. Console 与 HMI 连接同一个 Agent，核对 Session 和 revision。
2. 初始应为 0 项任务；手机通过 `/v1/chat` 创建任务，或 Console 选择性载入演示预置。
3. Console 依次推进会议延迟、接近车辆、进入车辆、拥堵和压力辅助信号。
4. 手机语音求助后，HMI 显示语音转写、动态动作组和三端状态。
5. 只有 `primary_surface=vehicle_hmi`、confirmation pending 且未过期时出现确认按钮。
6. 确认后等待更高 revision 的完成态；HMI 不提前显示成功。
7. 点击接管主屏“AURI 已准备”或任一动作，应进入处理进度页；完成态显示 `完成数/总数` 和 `100%`，可继续进入消息/订单详情。
8. cooldown 后降低打扰；停车后主端回到手机，HMI 只保留结束摘要。

## 验收命令

先启动启用测试鉴权的隔离 Agent。服务端变量必须叫 `AGENT_SHARED_TOKEN`；测试脚本读取的客户端变量才叫 `AURI_AGENT_TOKEN`，两者不要混用：

```bash
AGENT_SHARED_TOKEN=test-shared-token LLM_ENABLED=false BUILD_SHA=local-audit \
/home/fly/miniconda3/envs/auri-agent-dev/bin/python -m uvicorn \
  auri_agent.app:app --app-dir services/agent-api/src \
  --host 127.0.0.1 --port 8795
```

静态服务 `127.0.0.1:5174` 也已启动后执行：

```bash
node apps/vehicle-hmi/tests/world-state-model.test.cjs
node apps/vehicle-hmi/tests/agent-client.test.cjs
node apps/vehicle-hmi/tests/amap-adapter.test.cjs

/home/fly/miniconda3/envs/bosch-agent-dev/bin/python \
  apps/vehicle-hmi/tests/e2e_config_interaction.py

AURI_AGENT_TOKEN=test-shared-token \
/home/fly/miniconda3/envs/bosch-agent-dev/bin/python \
  apps/vehicle-hmi/tests/e2e_ultrawide_readability.py

AURI_AGENT_TOKEN=test-shared-token \
/home/fly/miniconda3/envs/bosch-agent-dev/bin/python \
  apps/vehicle-hmi/tests/e2e_console_hmi_sync.py
```

破坏性 E2E 只允许指向隔离本地 Agent，禁止对共享公网 Session 执行 reset 或完整写入测试。

## 常见问题

### Health 正常，但 Session 为 `--`

检查 Token、浏览器 Network 中 `/v1/state` 的 HTTP 状态，以及 Console/HMI 是否同源。401 不是 SSE 问题。

### 地图设置自动收起

当前版本不应发生。强制刷新后重试；若仍发生，记录 revision、浏览器版本和页面错误，并运行 `e2e_config_interaction.py`。

### 显示离线地图

检查 Agent `/health` 的 `amap_configured` 和 `/v1/map-config` 的 `provider`。公网环境不要把安全码写进浏览器或仓库。

### Console 更新但 HMI 不更新

核对两端 Session、revision 和 API Origin。HMI 应优先使用 SSE，断开时进入轮询并自动重连追平。
