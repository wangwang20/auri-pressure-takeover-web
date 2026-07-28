const DEFAULT_CONFIG = {
  apiBase: "https://auri-langchain-agent-api.onrender.com",
  token: "",
  stream: true,
  pollIntervalMs: 3000,
  mapProvider: "auto",
  amapKey: "",
  amapSecurityJsCode: "",
  amapServiceHost: "",
  amapStyle: "amap://styles/normal"
};

const PUBLIC_AGENT_API = "https://auri-langchain-agent-api.onrender.com";
const LEGACY_AGENT_API = "https://auri-agent-api.onrender.com";
const LOCAL_AGENT_API = "http://127.0.0.1:8000";
const storedConfig = JSON.parse(localStorage.getItem("auri-hmi-config") || "{}");
const queryParams = new URLSearchParams(window.location.search);
const queryConfig = {
  ...(queryParams.get("apiBase") ? { apiBase: queryParams.get("apiBase") } : {}),
  ...(queryParams.get("streamUrl") ? { streamUrl: queryParams.get("streamUrl") } : {})
};
const windowConfig = window.AURI_CONFIG || {};
const hasExplicitStreamUrl = Boolean(windowConfig.streamUrl || queryConfig.streamUrl);
let CONFIG = normalizeConfig({ ...DEFAULT_CONFIG, ...storedConfig, ...windowConfig, ...queryConfig }, hasExplicitStreamUrl);

const DRAFTS = {
  teacher: {
    target: "王老师",
    lines: [
      "老师您好，我这边路况拥堵，预计会晚到约 18 分钟。",
      "请您帮忙照看一下孩子，我到达后会立即联系您。"
    ]
  },
  family: {
    target: "家人",
    lines: [
      "会议延迟加上路况拥堵，接孩子可能晚一点。",
      "AURI 已将超市任务调整为配送方案，我会按当前路线安全驾驶。"
    ]
  }
};

const STAGE_VIEW = {
  connecting: ["idle", "AURI 正在连接", "正在读取当前行程和座舱状态。", "正在同步当前状态。", "正在连接 Agent", "无需确认", "请稍候", "连接中"],
  off_vehicle_idle: ["idle", "等待任务创建", "手机端创建任务后，AURI 会识别刚性责任和弹性任务。", "暂无风险结论。", "手机端可语音创建任务", "无需确认", "等待风险成立", "待机"],
  pre_departure_warning: ["delayed", "最晚出发窗口被压缩", "会议延迟 20 分钟，腕上设备已发出黄色提醒。", "仍可能准时，但可用时间明显减少。", "腕上已提醒，车机保持低干扰", "无需确认", "继续观察 ETA", "监控中"],
  handover_to_vehicle: ["warning", "路线正在接续", "接近车辆后，学校路线自动流转到车机。", "手机即将进入只读状态。", "准备进入车辆", "无需确认", "等待车辆状态", "交接中"],
  vehicle_observation: ["vehicle", "导航已接续", "阳光小学路线已经准备，当前按路线正常行驶。", "当前预计可以按时到达。", "可语音询问：“我还来得及吗？”", "无需确认", "保持当前路线", "观察中"],
  takeover_L2: ["risk", "预计晚到 18 分钟", "刚性责任窗口被突破，等待用户明确求助后生成方案。", "继续加速无法明显缩短时间。", "你可以说：“我还来得及吗？”", "等待方案", "Agent 尚未生成确认项", "分析中"],
  takeover_L3: ["risk", "高负荷保护", "多源辅助信号显示驾驶负荷升高，非必要内容已暂停。", "车机只保留必要判断和安全确认。", "保持驾驶，AURI 正在处理", "等待方案", "高负荷保护中", "保护中"],
  planning: ["takeover", "压力源接管中", "Agent 正在保护接孩子任务，并准备消息与服务方案。", "继续加速无法明显缩短时间，正在处理现实后果。", "AURI 正在准备方案", "准备中", "等待确认项生成", "规划中"],
  service_prepared: ["takeover", "方案已准备", "消息和生活服务方案已准备，等待确认。", "消息与服务方案已备好。", "可说：“确认处理”", "确认处理", "等待车机确认", "待确认"],
  waiting_confirmation: ["takeover", "方案等待确认", "已后置超市任务，并生成老师、家人消息和模拟配送方案。", "继续加速无法明显缩短时间；消息和采购方案已备好。", "可说：“确认处理”", "确认处理", "执行消息和模拟订单", "待确认"],
  executing: ["takeover", "正在执行", "AURI 正在执行已确认的动作组。", "请继续安全驾驶，动作正在处理。", "正在处理", "执行中", "请勿重复操作", "执行中"],
  action_completed: ["done", "问题已处理", "消息已模拟发送，服务订单已模拟提交，三端同步已处理。", "已处理，按当前速度驾驶即可。", "AURI 已降低打扰", "已完成", "三端绿态同步", "完成"],
  cooldown: ["done", "低干扰恢复", "压力源已处理，AURI 进入冷却状态。", "后续详情停车后在手机端复盘。", "AURI 保持安静", "已完成", "等待停车复盘", "恢复"],
  parked_review: ["done", "停车后复盘", "主交互端回到手机，车机结束本次处理。", "请在手机端查看消息、订单和 Action Ledger。", "手机端复盘", "车机结束", "手机为主端", "复盘"],
  error: ["risk", "连接暂时中断", "AURI 正在重新连接，当前不会执行新的动作。", "请保持当前路线，稍后再试。", "连接异常", "不可确认", "等待状态恢复", "错误"]
};

const MAP_STAGE_VIEW = {
  connecting: ["overview", "同步中", "", "正在读取路线和车辆状态", "等待 Agent", "◎"],
  off_vehicle_idle: ["overview", "路线", "预览", "手机创建任务后准备学校路线", "路线预览", "⌖"],
  pre_departure_warning: ["preview", "17:38", "前出发", "最晚出发窗口已压缩", "出发窗口提醒", "◷"],
  handover_to_vehicle: ["preview", "路线", "流转中", "手机路线正在交接到车机", "导航流转中", "⇢"],
  vehicle_observation: ["guidance", "1.5", "公里", "左转进入 学院路高架", "驾驶导航", "⌖"],
  takeover_L2: ["alert", "420", "米", "前方拥堵，保持当前车道", "拥堵风险成立", "!"],
  takeover_L3: ["alert", "420", "米", "高负荷保护，减少非必要提示", "高负荷保护", "!"],
  planning: ["takeover", "420", "米", "继续当前路线，AURI 正在处理", "Agent 接管中", "●"],
  service_prepared: ["takeover", "420", "米", "方案已准备，保持当前路线", "方案等待确认", "●"],
  waiting_confirmation: ["takeover", "420", "米", "方案已准备，保持当前路线", "3 项动作待确认", "●"],
  executing: ["takeover", "420", "米", "正在执行动作，继续安全驾驶", "动作执行中", "●"],
  action_completed: ["recovery", "1.3", "公里", "方案已处理，继续安全驾驶", "压力源已处理", "✓"],
  cooldown: ["recovery", "1.3", "公里", "保持当前路线，AURI 已降低打扰", "低干扰恢复", "✓"],
  parked_review: ["overview", "已到达", "", "本次行程已结束", "停车后复盘", "✓"],
  error: ["overview", "--", "", "导航状态暂不可用", "等待连接恢复", "!"]
};

const EVENT_BUTTONS = {
  create_task: ["task.created", "mobile", { text: "今天18:10接孩子，之后去超市" }],
  meeting_delayed: ["meeting.overrun", "demo_console", { delay_minutes: 20 }],
  departure_warning: ["scene.approaching", "demo_console", {}],
  enter_vehicle: ["scene.vehicle_entered", "demo_console", {}],
  traffic_jam: ["traffic.updated", "demo_console", { eta: "2026-07-15T18:28:00+08:00", late_minutes: 18 }],
  stress_signal: ["wearable.signal", "wearable", { heart_rate: 120, confidence: 0.9 }],
  agent_takeover: ["user.utterance", "vehicle_hmi", { text: "我还来得及吗？帮我处理" }],
  restore: ["cooldown.elapsed", "demo_console", {}]
};

const $ = (id) => document.querySelector(id);
const ui = {
  root: $(".screen"), speed: $("#speed"), headline: $("#headline"), eta: $("#eta"), etaNote: $("#etaNote"),
  windowState: $("#windowState"), modeChip: $("#modeChip"), phoneStatus: $("#phoneStatus"), watchStatus: $("#watchStatus"),
  carStatus: $("#carStatus"), phoneNode: $("#phoneNode"), watchNode: $("#watchNode"), carNode: $("#carNode"),
  handoffSummary: $("#handoffSummary"), kidTask: $("#kidTask"),
  shopTask: $("#shopTask"), kidTaskState: $("#kidTaskState"), shopTaskState: $("#shopTaskState"), agentTitle: $("#agentTitle"),
  agentText: $("#agentText"), realConclusion: $("#realConclusion"), riskBadge: $("#riskBadge"), actionState: $("#actionState"),
  actionList: $("#actionList"), draftState: $("#draftState") || $("#draftStateHidden"), draftBody: $("#draftBody"), tabs: $(".tabs"), syncPhone: $("#syncPhone"),
  syncWatch: $("#syncWatch"), syncWatchDot: $("#syncWatchDot"), syncCar: $("#syncCar"), voiceHint: $("#voiceHint"),
  confirmBtn: $("#confirmBtn"), confirmLabel: $("#confirmLabel"), confirmSub: $("#confirmSub"), timeline: $("#timeline"),
  speedLimit: $("#speedLimit"), lightCountdown: $("#lightCountdown"), turnDistance: $("#turnDistance"), turnUnit: $("#turnUnit"),
  routeProgress: $("#routeProgress"), turnInstruction: $("#turnInstruction"), laneGuidance: $("#laneGuidance"),
  mapStageLabel: $("#mapStageLabel"), mapStageIcon: $("#mapStageIcon"), mapWrap: $(".map-wrap"),
  routePath: $("#routePathGeometry"), routePassed: $("#routePassed"), carPin: $("#carPin"),
  signalToast: $("#signalToast"), signalToastIcon: $("#signalToastIcon"), signalToastSource: $("#signalToastSource"),
  signalToastTitle: $("#signalToastTitle"), signalToastDetail: $("#signalToastDetail"), dismissSignalToast: $("#dismissSignalToast"),
  amapRemain: $("#amapRemain"), amapDuration: $("#amapDuration"), amapArrival: $("#amapArrival"), configBtn: $("#configBtn"),
  configPanel: $("#configPanel"), configForm: $("#configForm"), closeConfig: $("#closeConfig"), configApiBase: $("#configApiBase"),
  configToken: $("#configToken"), usePublicAgent: $("#usePublicAgent"), useLegacyAgent: $("#useLegacyAgent"), useLocalAgent: $("#useLocalAgent"),
  configMapProvider: $("#configMapProvider"), configAmapKey: $("#configAmapKey"),
  configAmapSecurityCode: $("#configAmapSecurityCode"), configAmapServiceHost: $("#configAmapServiceHost"),
  mapConfigStatus: $("#mapConfigStatus"), amapCanvas: $("#amapCanvas"),
  connectionState: $("#connectionState"), connectionDetail: $("#connectionDetail"), acState: $("#acState"), acTemp: $("#acTemp"),
  acMode: $("#acMode"), acFan: $("#acFan"), climateTemp: $("#climateTemp"), climateMode: $("#climateMode"),
  quickAskBtn: $("#quickAskBtn"), openPlan: $("#openPlan"), openVehicle: $("#openVehicle"), openSync: $("#openSync"),
  quickAskMode: $("#quickAskMode"), quickAskLabel: $("#quickAskLabel"),
  openDrafts: $("#openDrafts"), openRoute: $("#openRoute"), routeSummary: $("#routeSummary"), detailPanel: $("#detailPanel"),
  closeDetail: $("#closeDetail"), detailTitle: $("#detailTitle"), detailBody: $("#detailBody"),
  syncSummary: $("#syncSummary"), openRouteSummary: $("#openRouteSummary")
};

let worldState = null;
let activeDraft = "teacher";
let activeTaskDetail = "pickup";
let lastRevision = -1;
let eventSeq = 0;
let pollTimer = null;
let healthState = null;
let activeDetail = null;
let lastMapStage = null;
let mapAnimationTimer = null;
let routeAnimationFrame = null;
let currentRouteProgress = null;
let confirmInFlight = false;
let lastSignalToastKey = null;
let signalToastTimer = null;
let amapRouteMeta = null;
let mapRuntimeStatus = { mode: "offline", message: "离线演示地图" };
const timeline = [];

function mapStatusText(status = mapRuntimeStatus) {
  if (!status.usage) return status.message;
  return `${status.message} · 本浏览器本月地图 ${status.usage.mapLoads} 次 / 路线 ${status.usage.routePlans} 次`;
}

const mapAdapter = window.AuriAmapAdapter?.create({
  container: ui.amapCanvas,
  mapWrap: ui.mapWrap,
  onStatus(status) {
    mapRuntimeStatus = status;
    if (ui.mapConfigStatus) ui.mapConfigStatus.textContent = mapStatusText(status);
    log("map", status.message);
  },
  onRouteMeta(meta) {
    amapRouteMeta = meta;
    render();
  }
});

function normalizeConfig(config, useProvidedStreamUrl = false) {
  const apiBase = (config.apiBase || DEFAULT_CONFIG.apiBase).replace(/\/$/, "");
  const mapProvider = ["auto", "amap", "offline"].includes(config.mapProvider)
    ? config.mapProvider
    : DEFAULT_CONFIG.mapProvider;
  return {
    ...config,
    apiBase,
    streamUrl: useProvidedStreamUrl && config.streamUrl ? config.streamUrl : `${apiBase}/v1/stream`,
    token: config.token || "",
    pollIntervalMs: Number(config.pollIntervalMs || DEFAULT_CONFIG.pollIntervalMs),
    mapProvider,
    amapKey: String(config.amapKey || "").trim(),
    amapSecurityJsCode: String(config.amapSecurityJsCode || "").trim(),
    amapServiceHost: String(config.amapServiceHost || "").trim(),
    amapStyle: config.amapStyle || DEFAULT_CONFIG.amapStyle
  };
}

function authHeaders(extra = {}) {
  return CONFIG.token ? { ...extra, "X-Agent-Token": CONFIG.token } : extra;
}

async function hydrateMapConfig() {
  if (CONFIG.mapProvider === "offline" || CONFIG.amapKey) return;
  try {
    const response = await fetch(`${CONFIG.apiBase}/v1/map-config`, {
      headers: authHeaders({ Accept: "application/json" })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${response.status}: ${data?.detail?.message || response.statusText}`);
    if (!data?.enabled || !data.key || !data.service_host) {
      log("map-config", "Agent 未配置高德安全代理");
      return;
    }
    CONFIG = normalizeConfig({
      ...CONFIG,
      mapProvider: "amap",
      amapKey: data.key,
      amapSecurityJsCode: "",
      amapServiceHost: data.service_host,
      amapStyle: data.style || "amap://styles/normal"
    });
    log("map-config", "已从 Agent 获取高德在线地图配置");
  } catch (error) {
    log("map-config-error", friendlyError(error));
  }
}

function eventId(type) {
  eventSeq += 1;
  return `hmi_${type.replaceAll(".", "_")}_${Date.now()}_${eventSeq}`;
}

function log(type, detail = "") {
  timeline.unshift({ time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), type, detail });
  timeline.splice(6);
  ui.timeline.innerHTML = timeline.map((item) => `<div>${item.time} · ${item.type}${item.detail ? ` · ${item.detail}` : ""}</div>`).join("");
}

function setConnection(text) {
  ui.connectionState.textContent = text.length > 8 ? text.slice(0, 8) : text;
  ui.connectionDetail.textContent = `${worldState?.session_id || "session --"} · r${worldState?.revision ?? "--"}`;
  log("connection", text);
}

function initConfigPanel() {
  ui.configApiBase.value = CONFIG.apiBase;
  ui.configToken.value = CONFIG.token;
  ui.configMapProvider.value = CONFIG.mapProvider;
  ui.configAmapKey.value = CONFIG.amapKey;
  ui.configAmapSecurityCode.value = CONFIG.amapSecurityJsCode;
  ui.configAmapServiceHost.value = CONFIG.amapServiceHost;
  ui.mapConfigStatus.textContent = mapStatusText();
}

function openConfig() {
  initConfigPanel();
  ui.configPanel.hidden = false;
}

function closeConfig() {
  ui.configPanel.hidden = true;
}

function saveConfig() {
  const next = normalizeConfig({
    apiBase: ui.configApiBase.value,
    token: ui.configToken.value,
    stream: true,
    mapProvider: ui.configMapProvider.value,
    amapKey: ui.configAmapKey.value,
    amapSecurityJsCode: ui.configAmapSecurityCode.value,
    amapServiceHost: ui.configAmapServiceHost.value
  });
  localStorage.setItem("auri-hmi-config", JSON.stringify({
    apiBase: next.apiBase,
    token: next.token,
    stream: true,
    pollIntervalMs: next.pollIntervalMs,
    mapProvider: next.mapProvider,
    amapKey: next.amapKey,
    amapSecurityJsCode: next.amapSecurityJsCode,
    amapServiceHost: next.amapServiceHost,
    amapStyle: next.amapStyle
  }));
  CONFIG = next;
  log("config", `saved ${CONFIG.apiBase}`);
  window.location.reload();
}

function friendlyError(error) {
  const message = error?.message || String(error);
  if (message.includes("NetworkError") || message.includes("Failed to fetch") || message.includes("Load failed")) {
    return `${message}；请确认 Agent 后端已启动、Agent API 地址正确，且后端 CORS 放行当前页面端口。`;
  }
  if (message.includes("UNAUTHORIZED") || message.includes("401")) {
    return `${message}；请填写正确 Team Token，或确认本地后端未开启共享访问。`;
  }
  if (message.includes("WRONG_SURFACE")) return "当前确认入口已经切换到其他设备。";
  if (message.includes("CONFIRMATION_EXPIRED")) return "当前方案已过期，AURI 将重新检查状态。";
  if (message.includes("CONFIRMATION_NOT_FOUND")) return "方案已经变化，正在重新同步。";
  return message;
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${CONFIG.apiBase}${path}`, {
    ...options,
    headers: authHeaders({
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    })
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const code = data?.detail?.code || response.status;
    throw new Error(`${code}: ${data?.detail?.message || response.statusText}`);
  }
  return data;
}

async function loadHealth(reason = "health") {
  const response = await fetch(`${CONFIG.apiBase}/health`, {
    headers: { Accept: "application/json" }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status}: ${data?.detail?.message || response.statusText}`);
  healthState = data;
  const framework = data.llm_framework || "agent";
  const mode = data.llm_last_mode || "mode --";
  ui.connectionState.textContent = data.status === "ok" ? "已预检" : "异常";
  ui.connectionDetail.textContent = `${framework} · ${mode}`;
  log(reason, `${framework} · ${mode}`);
  return data;
}

async function loadState(reason = "load") {
  const state = await apiFetch("/v1/state");
  consumeWorldState(state, reason);
}

function consumeWorldState(next, reason = "state") {
  if (!next || next.schema_version !== "0.2.0") return;
  if (worldState && next.session_id === worldState.session_id && next.revision <= lastRevision) return;
  if (worldState && next.session_id !== worldState.session_id) {
    activeDraft = "teacher";
    closeDetail();
    currentRouteProgress = null;
  }
  worldState = next;
  lastRevision = next.revision;
  log(reason, `${next.stage} r${next.revision}`);
  render();
}

async function submitEvent(definition) {
  if (!worldState) await loadState("before-event");
  const [type, source, payload] = definition;
  const accepted = await apiFetch("/v1/event", {
    method: "POST",
    body: JSON.stringify({
      schema_version: "0.2.0",
      event_id: eventId(type),
      session_id: worldState.session_id,
      type,
      source,
      timestamp: new Date().toISOString(),
      payload
    })
  });
  consumeWorldState(accepted.state, accepted.duplicate ? "duplicate-event" : "event");
}

async function confirmAction(inputMode = "button") {
  if (!worldState?.confirmation || confirmInFlight) return;
  confirmInFlight = true;
  const confirmationId = worldState.confirmation.confirmation_id;
  try {
    const state = await apiFetch("/v1/confirm", {
      method: "POST",
      body: JSON.stringify({
        confirmation_id: confirmationId,
        decision: "accept",
        confirmed_by: "vehicle_hmi",
        input_mode: inputMode
      })
    });
    consumeWorldState(state, "confirm");
  } catch (error) {
    try {
      await loadState("confirm-reconcile");
    } catch (_stateError) {
      // Preserve the confirmation error; the snapshot request is only reconciliation.
    }
    const stillPending = worldState?.confirmation?.confirmation_id === confirmationId
      && worldState.confirmation.status === "pending";
    if (stillPending) throw error;
  } finally {
    confirmInFlight = false;
  }
}

async function resetSession() {
  const state = await apiFetch("/v1/session/reset", {
    method: "POST",
    body: JSON.stringify({ scenario_id: "happy-path" })
  });
  consumeWorldState(state, "reset");
}

async function connectStream() {
  if (!CONFIG.stream) return;
  try {
    const response = await fetch(CONFIG.streamUrl, {
      headers: authHeaders({ Accept: "text/event-stream" })
    });
    if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
    setConnection("已连接");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      chunks.forEach(parseStreamChunk);
    }
  } catch (error) {
    setConnection("连接异常");
    log("stream-error", friendlyError(error));
    setTimeout(connectStream, 2500);
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    loadState("poll").catch((error) => log("poll-error", friendlyError(error)));
  }, CONFIG.pollIntervalMs);
}

function parseStreamChunk(chunk) {
  const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) return;
  try {
    consumeWorldState(JSON.parse(dataLine.slice(6)), "stream");
  } catch (error) {
    log("stream-parse-error", friendlyError(error));
  }
}

function stageView() {
  if (!worldState) return STAGE_VIEW.connecting;
  return STAGE_VIEW[worldState?.stage] || STAGE_VIEW.error;
}

function mapStageView() {
  if (!worldState) return MAP_STAGE_VIEW.connecting;
  return MAP_STAGE_VIEW[worldState?.stage] || MAP_STAGE_VIEW.error;
}

function animateMapStage(nextStage) {
  if (!ui.mapWrap || nextStage === lastMapStage) return;
  lastMapStage = nextStage;
  ui.mapWrap.classList.remove("is-stage-changing");
  void ui.mapWrap.offsetWidth;
  ui.mapWrap.classList.add("is-stage-changing");
  window.clearTimeout(mapAnimationTimer);
  mapAnimationTimer = window.setTimeout(() => ui.mapWrap.classList.remove("is-stage-changing"), 720);
}

function routeProgressForStage(stage) {
  return {
    connecting: 0.02,
    off_vehicle_idle: 0.03,
    pre_departure_warning: 0.05,
    handover_to_vehicle: 0.09,
    vehicle_observation: 0.22,
    takeover_L2: 0.43,
    takeover_L3: 0.43,
    planning: 0.48,
    service_prepared: 0.5,
    waiting_confirmation: 0.52,
    executing: 0.58,
    action_completed: 0.72,
    cooldown: 0.78,
    parked_review: 1
  }[stage] ?? 0.03;
}

const ROUTE_SAMPLES = [
  [0, 78, 648],
  [.05, 145, 626],
  [.09, 205, 615],
  [.22, 363, 574],
  [.35, 480, 466],
  [.43, 566, 421],
  [.52, 690, 389],
  [.58, 770, 375],
  [.72, 900, 306],
  [.78, 960, 226],
  [.9, 1050, 108],
  [1, 1164, 42]
];

function sampledRoutePoint(progress) {
  const clamped = Math.max(0, Math.min(1, progress));
  const upperIndex = ROUTE_SAMPLES.findIndex(([position]) => position >= clamped);
  if (upperIndex <= 0) return { x: ROUTE_SAMPLES[0][1], y: ROUTE_SAMPLES[0][2], angle: 73 };
  const lower = ROUTE_SAMPLES[upperIndex - 1];
  const upper = ROUTE_SAMPLES[upperIndex];
  const ratio = (clamped - lower[0]) / (upper[0] - lower[0]);
  return {
    x: lower[1] + (upper[1] - lower[1]) * ratio,
    y: lower[2] + (upper[2] - lower[2]) * ratio,
    angle: Math.atan2(upper[2] - lower[2], upper[1] - lower[1]) * 180 / Math.PI + 90
  };
}

function routePoint(progress) {
  const clamped = Math.max(0, Math.min(1, progress));
  try {
    const length = ui.routePath.getTotalLength();
    const point = ui.routePath.getPointAtLength(length * clamped);
    const lookAhead = ui.routePath.getPointAtLength(Math.min(length, length * clamped + 8));
    return {
      x: point.x,
      y: point.y,
      angle: Math.atan2(lookAhead.y - point.y, lookAhead.x - point.x) * 180 / Math.PI + 90
    };
  } catch (_error) {
    return sampledRoutePoint(clamped);
  }
}

function positionVehicle(progress) {
  if (!ui.carPin || !ui.routePath || !ui.routePassed) return;
  const clamped = Math.max(0, Math.min(1, progress));
  const point = routePoint(clamped);
  ui.carPin.setAttribute("transform", `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)}) rotate(${point.angle.toFixed(2)})`);
  ui.routePassed.setAttribute("stroke-dasharray", `${(clamped * 100).toFixed(2)} 100`);
  ui.routeProgress.style.height = `${Math.round(clamped * 100)}%`;
}

function animateVehicleTo(target) {
  window.cancelAnimationFrame(routeAnimationFrame);
  if (currentRouteProgress === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    currentRouteProgress = target;
    positionVehicle(target);
    return;
  }
  if (Math.abs(target - currentRouteProgress) < 0.001) {
    positionVehicle(target);
    return;
  }
  const start = currentRouteProgress;
  const startedAt = performance.now();
  const duration = 900;
  const step = (now) => {
    const elapsed = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - elapsed, 3);
    currentRouteProgress = start + (target - start) * eased;
    positionVehicle(currentRouteProgress);
    if (elapsed < 1) routeAnimationFrame = window.requestAnimationFrame(step);
  };
  routeAnimationFrame = window.requestAnimationFrame(step);
}

function handoffText(stage) {
  return {
    connecting: "正在同步手机、腕上和车机",
    off_vehicle_idle: "手机录入任务，腕上和车机待命",
    pre_departure_warning: "手机显示风险，腕上黄色双短震",
    handover_to_vehicle: "任务与路线正在接续到车机",
    vehicle_observation: "车机已接管，手机进入只读",
    takeover_L2: "车机处理风险，腕上同步提醒",
    takeover_L3: "车机进入保护态，腕上减少打扰",
    planning: "AURI 正在准备跨端协助方案",
    service_prepared: "方案已同步，等待车机确认",
    waiting_confirmation: "车机等待确认，手机和腕上同步",
    executing: "动作正在执行，三端同步更新",
    action_completed: "手机、腕上和车机均已完成",
    cooldown: "三端恢复低干扰状态",
    parked_review: "手机已接回主端，可查看完整复盘"
  }[stage] || "三端保持同步";
}

function signalToastView(stage) {
  if (stage === "pre_departure_warning") {
    return ["warning", "腕上提醒", "最晚出发窗口已压缩", "黄色提示 · 双短震", "◷"];
  }
  if (stage === "takeover_L3") {
    return ["critical", "腕上压力信号", "驾驶负荷升高", "红色保护提示 · 一次组合振动", "!"];
  }
  if (stage === "takeover_L2") {
    if (worldState?.wearable?.text === "压力信号升高") {
      return ["warning", "腕上压力信号", "压力趋势升高", "黄色提示 · 双短震", "◉"];
    }
    return ["warning", "AURI 风险提醒", "预计晚到 18 分钟", "车机进入低干扰 · 腕上保持驾驶连接", "◉"];
  }
  return null;
}

function renderSignalToast(stage) {
  const view = signalToastView(stage);
  if (!view) {
    window.clearTimeout(signalToastTimer);
    ui.signalToast.hidden = true;
    return;
  }
  const signalKey = `${stage}:${worldState?.wearable?.command_id || worldState?.revision || "0"}`;
  if (signalKey === lastSignalToastKey) return;
  lastSignalToastKey = signalKey;
  const [tone, source, title, detail, icon] = view;
  ui.signalToast.className = `signal-toast ${tone}`;
  ui.signalToastSource.textContent = source;
  ui.signalToastTitle.textContent = title;
  ui.signalToastDetail.textContent = detail;
  ui.signalToastIcon.textContent = icon;
  ui.signalToast.hidden = false;
  window.clearTimeout(signalToastTimer);
  if (stage === "pre_departure_warning") {
    signalToastTimer = window.setTimeout(() => {
      ui.signalToast.hidden = true;
    }, 6500);
  }
}

function riskLabel(stage, risk) {
  if (stage === "error") return "⚠ 连接异常";
  if (["action_completed", "cooldown", "parked_review"].includes(stage)) return "✓ 已处理";
  if (risk.pressure_level === "L3") return "⚠ L3 高负荷";
  if (risk.pressure_level === "L2") return "⚠ L2 接管";
  if (risk.pressure_level === "L1") return "⏱ L1 注意";
  return "○ L0 低干扰";
}

function driverConclusion(viewConclusion, risk, order) {
  if (order?.error_code) return `服务暂不可用，已保留消息方案。`;
  if (risk.late_minutes > 0 && worldState?.confirmation?.status === "pending") {
    return "继续加速无法明显缩短时间。方案已准备，确认后执行。";
  }
  const output = worldState?.output?.conclusion?.trim();
  return output && output.length <= 42 ? output : viewConclusion;
}

function formatTime(value) {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function pickupTask() {
  return (worldState?.tasks || []).find((task) => task.task_type === "rigid" || task.task_id.includes("pickup"));
}

function groceryTask() {
  return (worldState?.tasks || []).find((task) => task.capability_tags?.includes("grocery_delivery") || task.task_type === "flexible");
}

function acModeLabel(mode) {
  return { auto: "自动", cool: "制冷", heat: "制热", fan: "送风" }[mode] || "自动";
}

function fanLabel(speed) {
  return { low: "低", medium: "中", high: "高" }[speed] || "中";
}

function hapticLabel(haptic) {
  return {
    none: "保持静默",
    single_short: "一次短震",
    double_short: "双短震",
    three_beat: "三拍提示",
    clear: "明确提示",
    soft_short: "柔和短震"
  }[haptic] || (haptic ? "触觉提醒" : "保持静默");
}

function sceneLabel(scene) {
  return {
    off_vehicle: "车外待机",
    approaching_vehicle: "接近车辆",
    driving: "驾驶中",
    high_load_driving: "高负荷驾驶",
    parked: "已停车"
  }[scene] || "车外待机";
}

function surfaceLabel(surface) {
  return {
    mobile: "手机主端",
    vehicle_hmi: "车机主端",
    wearable: "腕上设备"
  }[surface] || "手机主端";
}

function orderStatusLabel(status) {
  return {
    awaiting_confirmation: "待确认",
    completed: "已完成",
    blocked: "已阻断",
    failed: "失败",
    preview: "预览"
  }[status] || status || "待准备";
}

function actionText(action) {
  const prefix = action.type === "message"
    ? `${action.target || "联系人"}消息`
    : action.type === "service_order"
      ? "超市配送"
      : "任务调整";
  const status = {
    awaiting_confirmation: "待确认",
    completed: "已完成",
    blocked: "已阻断",
    failed: "失败",
    planned: "已规划",
    ready: "已准备"
  }[action.status] || action.status;
  return `${prefix} · ${status}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function splitDisplayText(value) {
  const normalized = String(value || "")
    .replace(/，并(?=已|完成|将|把)/g, "。")
    .replace(/：(?=\d+\s*件)/g, "。")
    .replace(/，(?=\d{1,2}:\d{2})/g, "。");
  const sentences = normalized.match(/[^。；]+[。；]?/g) || [];
  return sentences.map((sentence) => sentence.trim()).filter(Boolean);
}

function renderTripValue(element, value, unit) {
  element.innerHTML = `<b>${escapeHtml(value)}</b><small>${escapeHtml(unit)}</small>`;
}

function detailCopyItem(label, value, cls = "") {
  const lines = splitDisplayText(value);
  return `
    <div class="detail-copy-item ${cls}">
      <span>${escapeHtml(label)}</span>
      <div>${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>
    </div>
  `;
}

function draftMarkup(action, kind) {
  const draft = DRAFTS[kind];
  const status = action?.status === "completed" ? "已发送" : action ? "等待确认" : "尚未生成";
  return `
    <article class="message-preview">
      <header>
        <span><strong>${escapeHtml(draft.target)}</strong><em>模拟消息</em></span>
        <b class="${action?.status === "completed" ? "done" : ""}">${status}</b>
      </header>
      <div>${draft.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>
    </article>
  `;
}

function renderActions() {
  const actions = worldState?.actions || [];
  if (!actions.length) {
    ui.actionList.innerHTML = "<li>等待 Agent 生成动作组</li>";
    return;
  }
  ui.actionList.innerHTML = actions.slice(0, 3).map((action) => {
    const cls = action.status === "completed" ? "done" : action.status === "awaiting_confirmation" ? "pending" : "";
    return `<li class="${cls}">${escapeHtml(actionText(action))}</li>`;
  }).join("");
}

function renderDraft() {
  const messageActions = (worldState?.actions || []).filter((action) => action.type === "message");
  if (!messageActions.length) {
    ui.draftState.textContent = "未生成";
    const hidden = $("#draftStateHidden");
    if (hidden) hidden.textContent = "未生成";
    ui.draftBody.textContent = "风险成立后生成老师和家人的模拟消息草稿。";
    return;
  }
  const current = activeDraft === "family"
    ? messageActions.find((action) => action.target.includes("家")) || messageActions[1] || messageActions[0]
    : messageActions.find((action) => action.target.includes("老师")) || messageActions[0];
  const draftLabel = current.status === "completed" ? "已模拟发送" : "等待确认";
  ui.draftState.textContent = draftLabel;
  const hidden = $("#draftStateHidden");
  if (hidden) hidden.textContent = draftLabel;
  ui.draftBody.textContent = DRAFTS[activeDraft].lines.join("");
}

function canQuickAsk() {
  if (!worldState) return false;
  if (worldState.primary_surface !== "vehicle_hmi") return false;
  if (worldState.confirmation?.status === "pending") return false;
  return ["vehicle_observation", "takeover_L2", "takeover_L3", "planning"].includes(worldState.stage);
}

function detailItem(label, value, cls = "") {
  return `<div class="detail-item ${cls}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function actionStatusLabel(status) {
  return {
    awaiting_confirmation: "待确认",
    completed: "已完成",
    blocked: "已阻断",
    failed: "失败",
    planned: "已规划",
    ready: "已准备"
  }[status] || status || "等待";
}

function taskFlowCard({
  id,
  icon,
  type,
  title,
  status,
  meta,
  detail,
  selected,
  tone
}) {
  return `
    <button class="task-flow-card ${tone} ${selected ? "selected" : ""}" type="button"
      data-task-detail="${escapeHtml(id)}" aria-expanded="${selected ? "true" : "false"}">
      <span class="task-flow-icon" aria-hidden="true">${escapeHtml(icon)}</span>
      <span class="task-flow-copy">
        <span class="task-flow-label">${escapeHtml(type)}<b>${escapeHtml(status)}</b></span>
        <strong>${escapeHtml(title)}</strong>
        <em>${escapeHtml(meta)}</em>
        <span class="task-flow-detail">${escapeHtml(detail)}</span>
      </span>
      <i aria-hidden="true">${selected ? "−" : "+"}</i>
    </button>
  `;
}

function deviceSyncCard({ icon, name, state, detail, active, tone }) {
  return `
    <article class="device-sync-card ${tone} ${active ? "active" : ""}">
      <span class="device-sync-icon" aria-hidden="true">${escapeHtml(icon)}</span>
      <span><strong>${escapeHtml(name)}</strong><em>${escapeHtml(detail)}</em></span>
      <b>${escapeHtml(state)}</b>
    </article>
  `;
}

function setActiveLauncher(kind = "home") {
  document.querySelectorAll(".launch[data-detail], .launch[data-home]").forEach((button) => {
    button.classList.toggle("active", kind === "home" ? button.hasAttribute("data-home") : button.dataset.detail === kind);
  });
}

function planResultSummary(order) {
  if (["action_completed", "cooldown", "parked_review"].includes(worldState?.stage) && order) {
    const itemCount = (order.items || []).length;
    return `已通知孩子进度（模拟消息），并完成模拟商超订单：${itemCount}件商品共${order.total || 0}元，${order.delivery_window || "配送时间待定"}送达。`;
  }
  return worldState?.output?.conclusion || "等待风险判断";
}

function openDetail(kind) {
  const risk = worldState?.risk || { pressure_level: "L0", late_minutes: 0 };
  const eta = formatTime(worldState?.eta);
  const pickup = pickupTask();
  const grocery = groceryTask();
  const vehicleState = worldState?.vehicle_state || {};
  const actions = worldState?.actions || [];
  const order = worldState?.service_orders?.[0];

  if (kind === "drafts") {
    renderDraft();
    const messageActions = actions.filter((action) => action.type === "message");
    const currentAction = activeDraft === "family"
      ? messageActions.find((action) => action.target?.includes("家")) || messageActions[1]
      : messageActions.find((action) => action.target?.includes("老师")) || messageActions[0];
    ui.detailTitle.textContent = "消息";
    ui.detailBody.innerHTML = `
      <section class="message-overview">
        <span>消息协助</span>
        <strong>${messageActions.length ? `${messageActions.length} 条草稿已准备` : "等待风险成立"}</strong>
        <p>${messageActions.length ? "确认后统一发送，驾驶中无需编辑长文本。" : "风险成立后，AURI 会准备必要联系人消息。"}</p>
      </section>
      <div class="detail-tabs contact-tabs">
        <button type="button" data-detail-draft="teacher" class="${activeDraft === "teacher" ? "active" : ""}">
          <span class="contact-avatar">师</span><span><strong>王老师</strong><em>${messageActions[0] ? actionStatusLabel(messageActions[0].status) : "未生成"}</em></span>
        </button>
        <button type="button" data-detail-draft="family" class="${activeDraft === "family" ? "active" : ""}">
          <span class="contact-avatar">家</span><span><strong>家人</strong><em>${messageActions[1] ? actionStatusLabel(messageActions[1].status) : "未生成"}</em></span>
        </button>
      </div>
      ${draftMarkup(currentAction, activeDraft)}
      <div class="message-state-strip">
        <span class="${messageActions.length ? "done" : ""}"><i></i>生成草稿</span>
        <b></b>
        <span class="${currentAction?.status === "completed" ? "done" : "current"}"><i></i>${currentAction?.status === "completed" ? "已模拟发送" : "等待确认"}</span>
      </div>
    `;
  } else if (kind === "plan") {
    ui.detailTitle.textContent = "接管方案";
    const completedActions = actions.filter((action) => action.status === "completed").length;
    const taskRisk = risk.late_minutes > 0;
    ui.detailBody.innerHTML = `
      <section class="task-overview ${taskRisk ? "warning" : ""}">
        <span class="task-overview-kicker">今日关键责任</span>
        <strong>${pickup ? "18:10 接孩子" : "等待手机创建任务"}</strong>
        <p>${taskRisk ? `当前预计晚到 ${risk.late_minutes} 分钟，AURI 已优先保护刚性责任。` : "接孩子保持最高优先级，弹性事项可自动调整。"}</p>
        <div class="task-overview-meta">
          <span><b>${actions.length}</b> 个动作</span>
          <span><b>${completedActions}</b> 已完成</span>
          <span class="${worldState?.confirmation?.status === "pending" ? "warning" : ""}">${worldState?.confirmation?.status === "pending" ? "等待确认" : "状态同步"}</span>
        </div>
      </section>
      <div class="task-flow-list">
        ${taskFlowCard({
          id: "pickup",
          icon: "◷",
          type: "刚性责任",
          title: pickup ? "18:10 接孩子" : "等待创建",
          status: "不可后置",
          meta: pickup?.location || "阳光小学",
          detail: taskRisk ? `预计晚到 ${risk.late_minutes} 分钟，老师消息已准备。` : "系统持续计算最晚出发时间和 ETA。",
          selected: activeTaskDetail === "pickup",
          tone: "rigid"
        })}
        ${taskFlowCard({
          id: "grocery",
          icon: "↻",
          type: "弹性任务",
          title: grocery ? "之后去超市" : "等待识别",
          status: grocery?.status === "rescheduled" ? "已后置" : "可调整",
          meta: order ? `${(order.items || []).length} 件 · ${order.total || 0} 元` : "不影响接孩子",
          detail: order ? `${orderStatusLabel(order.status)}，预计 ${order.delivery_window || "配送时间待定"} 送达。` : "风险成立后可切换为模拟配送方案。",
          selected: activeTaskDetail === "grocery",
          tone: "flexible"
        })}
      </div>
      <section class="task-action-summary">
        <header><span>处理进度</span><strong>${actions.length ? `${completedActions}/${actions.length}` : "0/0"}</strong></header>
        <div class="task-action-track"><i style="--task-progress:${actions.length ? Math.round((completedActions / actions.length) * 100) : 0}%"></i></div>
        <p>${escapeHtml(planResultSummary(order))}</p>
      </section>
    `;
  } else if (kind === "vehicle") {
    ui.detailTitle.textContent = "座舱状态";
    const acOn = vehicleState.ac_on === true;
    const temperature = Number(vehicleState.ac_target_temp ?? 24).toFixed(1);
    const mode = acModeLabel(vehicleState.ac_mode);
    const fan = fanLabel(vehicleState.fan_speed);
    const fanLevel = { low: 1, medium: 2, high: 3 }[vehicleState.fan_speed] || 2;
    ui.detailBody.innerHTML = `
      <section class="cabin-overview ${acOn ? "is-on" : "is-off"}">
        <div class="cabin-temperature">
          <span>目标温度</span>
          <strong>${temperature}<small>°C</small></strong>
          <em><i></i> AC ${acOn ? "已开启" : "已关闭"}</em>
        </div>
        <div class="cabin-airflow">
          <span>AUTO</span>
          <div class="fan-meter" aria-label="风量${fan}">
            ${[1, 2, 3].map((level) => `<i class="${level <= fanLevel ? "active" : ""}"></i>`).join("")}
          </div>
          <strong>风量 ${fan}</strong>
        </div>
      </section>
      <div class="cabin-control-grid">
        <article class="${acOn ? "active" : ""}">
          <span>温控模式</span>
          <strong>${mode}</strong>
          <em>${acOn ? "正在调节" : "当前待机"}</em>
        </article>
        <article>
          <span>当前场景</span>
          <strong>${sceneLabel(worldState?.scene)}</strong>
          <em>${worldState?.scene === "high_load_driving" ? "减少非必要提示" : "保持驾驶上下文"}</em>
        </article>
        <article>
          <span>交互设备</span>
          <strong>${surfaceLabel(worldState?.primary_surface)}</strong>
          <em>确认入口跟随主端</em>
        </article>
        <article class="${worldState?.wearable?.mode === "warning" ? "warning" : worldState?.wearable?.mode === "completed" ? "done" : ""}">
          <span>腕上反馈</span>
          <strong>${escapeHtml(worldState?.wearable?.text || "AURI 就绪")}</strong>
          <em>${escapeHtml(hapticLabel(worldState?.wearable?.haptic))}</em>
        </article>
      </div>
      <div class="cabin-sync-note"><i></i><span>座舱状态已同步至手机、腕上与车机</span></div>
    `;
  } else if (kind === "route") {
    ui.detailTitle.textContent = "行程详情";
    ui.detailBody.innerHTML = `
      <div class="detail-list">
        ${detailItem("目的地", "阳光小学")}
        ${detailItem("ETA", eta === "--:--" ? "等待路线" : eta, risk.late_minutes > 0 ? "warning" : "")}
        ${detailItem("预计晚到", risk.late_minutes > 0 ? `${risk.late_minutes} 分钟` : "暂无晚到风险", risk.late_minutes > 0 ? "warning" : "done")}
        ${detailItem("剩余距离", ui.amapRemain.textContent)}
        ${detailItem("下一动作", ui.voiceHint.textContent)}
      </div>
    `;
  } else {
    ui.detailTitle.textContent = "设备同步";
    const surface = worldState?.primary_surface || "mobile";
    const phoneActive = surface === "mobile";
    const watchActive = surface === "wearable";
    const carActive = surface === "vehicle_hmi";
    ui.detailBody.innerHTML = `
      <section class="sync-overview">
        <header><span>多端状态</span><b>revision ${escapeHtml(worldState?.revision ?? "--")}</b></header>
        <strong>${escapeHtml(surfaceLabel(surface))}正在响应</strong>
        <p>${escapeHtml(ui.handoffSummary.textContent)}</p>
        <div class="sync-flow" aria-label="手机、腕上设备与车机状态流">
          <span class="${phoneActive ? "active" : ""}"><i>▯</i><b>手机</b></span>
          <em class="${!phoneActive ? "passed" : ""}">›</em>
          <span class="${watchActive ? "active" : ""}"><i>◉</i><b>腕上</b></span>
          <em class="${carActive ? "passed" : ""}">›</em>
          <span class="${carActive ? "active" : ""}"><i>◇</i><b>车机</b></span>
        </div>
      </section>
      <div class="device-sync-list">
        ${deviceSyncCard({ icon: "▯", name: "手机", state: ui.syncPhone.textContent, detail: phoneActive ? "当前主交互端" : "任务与权限中心", active: phoneActive, tone: "phone" })}
        ${deviceSyncCard({ icon: "◉", name: "腕上", state: ui.syncWatch.textContent, detail: hapticLabel(worldState?.wearable?.haptic), active: watchActive, tone: "watch" })}
        ${deviceSyncCard({ icon: "◇", name: "车机", state: ui.syncCar.textContent, detail: carActive ? "驾驶中主交互端" : "导航与安全确认", active: carActive, tone: "car" })}
      </div>
      <section class="sync-context">
        <span><em>当前场景</em><strong>${escapeHtml(sceneLabel(worldState?.scene))}</strong></span>
        <span><em>压力等级</em><strong>${escapeHtml(risk.pressure_level)}</strong></span>
        <span><em>同步状态</em><strong>${worldState ? "已连接" : "等待连接"}</strong></span>
      </section>
    `;
  }
  activeDetail = kind;
  setActiveLauncher(kind);
  ui.detailPanel.hidden = false;
}

function closeDetail() {
  activeDetail = null;
  ui.detailPanel.hidden = true;
  setActiveLauncher("home");
}

function render() {
  const view = stageView();
  const mapView = mapStageView();
  const [className, title, text, conclusion, voice, confirmLabel, confirmSub, actionState] = view;
  const [mapStage, mapDistance, mapUnit, mapInstruction, mapLabel, mapIcon] = mapView;
  const risk = worldState?.risk || { pressure_level: "L0", late_minutes: 0 };
  const eta = formatTime(worldState?.eta);
  const pickup = pickupTask();
  const grocery = groceryTask();
  const canConfirm = worldState?.primary_surface === "vehicle_hmi"
    && worldState?.confirmation?.owner_surface === "vehicle_hmi"
    && worldState?.confirmation?.status === "pending";
  const driving = ["driving", "high_load_driving"].includes(worldState?.scene);
  const order = worldState?.service_orders?.[0];
  const vehicleState = worldState?.vehicle_state || {};
  const acOn = vehicleState.ac_on === true;
  const acTemp = Number(vehicleState.ac_target_temp ?? 24).toFixed(1);
  const acMode = acModeLabel(vehicleState.ac_mode);
  const acFan = fanLabel(vehicleState.fan_speed);
  const showDebugDemo = queryParams.get("debug") === "1" || queryParams.get("demo") === "1";

  ui.root.className = `screen state-${className} map-stage-${mapStage}${showDebugDemo ? " debug-demo" : ""}`;
  animateMapStage(mapStage);
  ui.speed.textContent = driving ? "42" : "--";
  ui.headline.textContent = "博世苏州 · 星龙街455号 → 阳光小学";
  ui.eta.textContent = eta;
  ui.etaNote.textContent = risk.late_minutes > 0 ? `晚到 ${risk.late_minutes} 分钟` : eta === "--:--" ? "等待路线" : "准时";
  ui.windowState.textContent = risk.late_minutes > 0 ? "突破" : worldState?.stage === "pre_departure_warning" ? "压缩" : pickup ? "已建立" : "未建立";
  ui.modeChip.textContent = worldState?.primary_surface === "vehicle_hmi" ? "驾驶模式" : "手机为主端";
  ui.phoneStatus.textContent = worldState?.primary_surface === "mobile"
    ? "主端"
    : worldState?.stage === "action_completed"
      ? "已同步"
      : "只读";
  ui.watchStatus.textContent = worldState?.wearable?.text || "常态";
  ui.carStatus.textContent = worldState?.primary_surface === "vehicle_hmi" ? "主端" : worldState ? "同步" : "待机";
  ui.phoneNode.classList.toggle("active", worldState?.primary_surface === "mobile");
  ui.carNode.classList.toggle("active", worldState?.primary_surface === "vehicle_hmi");
  ui.watchNode.classList.toggle("warning", worldState?.wearable?.mode === "warning");
  ui.watchNode.classList.toggle("done", worldState?.wearable?.mode === "completed");
  ui.handoffSummary.textContent = handoffText(worldState?.stage);
  ui.connectionState.textContent = worldState ? "已连接" : "未连接";
  ui.connectionDetail.textContent = healthState
    ? `${healthState.llm_framework || "agent"} · r${worldState?.revision ?? "--"}`
    : `${worldState?.session_id || "session --"} · r${worldState?.revision ?? "--"}`;
  ui.kidTask.classList.toggle("active", Boolean(pickup));
  ui.shopTask.classList.toggle("active", Boolean(grocery));
  ui.kidTaskState.textContent = pickup ? (pickup.adjustable ? "可调整" : "不可后置") : "等待创建";
  ui.shopTaskState.textContent = grocery ? (grocery.status === "rescheduled" ? "已后置" : "可调整") : "等待创建";
  ui.agentTitle.textContent = title;
  ui.agentText.textContent = text;
  ui.realConclusion.textContent = driverConclusion(conclusion, risk, order);
  ui.riskBadge.textContent = riskLabel(worldState?.stage, risk);
  ui.actionState.textContent = actionState;
  renderActions();
  renderDraft();
  ui.syncPhone.textContent = worldState?.primary_surface === "mobile" ? "主端" : "只读";
  ui.syncWatch.textContent = worldState?.wearable?.text || "常态";
  ui.syncCar.textContent = worldState?.primary_surface === "vehicle_hmi" ? "主端" : "同步";
  if (ui.syncSummary) ui.syncSummary.textContent = worldState ? "三端状态一致" : "等待连接";
  ui.syncWatchDot.className = worldState?.wearable?.mode === "completed" ? "done" : worldState?.wearable?.mode === "warning" ? "warn" : "ok";
  if (ui.routeSummary) {
    ui.routeSummary.textContent = risk.late_minutes > 0 ? `晚到 ${risk.late_minutes} 分钟` : eta === "--:--" ? "等待路线" : `${eta} 到达`;
  }
  ui.quickAskBtn.disabled = !canQuickAsk();
  ui.quickAskBtn.classList.toggle("enabled", canQuickAsk());
  if (["action_completed", "cooldown", "parked_review"].includes(worldState?.stage)) {
    ui.quickAskMode.textContent = "低干扰";
    ui.quickAskLabel.textContent = "需要时再叫我";
  } else if (worldState?.confirmation?.status === "pending") {
    ui.quickAskMode.textContent = "方案已准备";
    ui.quickAskLabel.textContent = "请在下方确认处理";
  } else {
    ui.quickAskMode.textContent = "语音求助";
    ui.quickAskLabel.textContent = "我还来得及吗？";
  }
  ui.voiceHint.textContent = voice;
  ui.confirmBtn.disabled = !canConfirm || confirmInFlight;
  ui.confirmBtn.classList.toggle("enabled", canConfirm);
  ui.confirmLabel.textContent = confirmLabel;
  ui.confirmSub.textContent = canConfirm ? confirmSub : (worldState?.confirmation?.owner_surface && worldState.confirmation.owner_surface !== "vehicle_hmi" ? "确认入口不在车机" : confirmSub);
  ui.acState.textContent = `AC ${acOn ? "开启" : "关闭"} · ${acTemp}° · 风量${acFan}`;
  ui.acTemp.textContent = `${acTemp}°`;
  ui.acMode.textContent = acMode;
  ui.acFan.textContent = acFan;
  ui.climateTemp.textContent = `${acTemp}°`;
  ui.climateMode.textContent = `${acOn ? "AC 开启" : "AC 关闭"} · ${acMode} · 风量${acFan}`;
  ui.speedLimit.textContent = driving ? "40" : "--";
  ui.lightCountdown.textContent = risk.late_minutes > 0 ? "21" : "65";
  const useAmapInstruction = mapRuntimeStatus.mode === "online"
    && amapRouteMeta?.instruction
    && ["guidance", "alert", "takeover", "recovery"].includes(mapStage);
  ui.turnDistance.textContent = useAmapInstruction ? amapRouteMeta.nextDistance.value : mapDistance;
  ui.turnUnit.textContent = useAmapInstruction ? amapRouteMeta.nextDistance.unit : mapUnit;
  ui.turnInstruction.textContent = useAmapInstruction ? amapRouteMeta.instruction : mapInstruction;
  ui.laneGuidance.textContent = mapStage === "overview"
    ? "等待车辆导航信号"
    : mapStage === "preview"
      ? "路线与车辆状态同步"
      : mapStage === "alert"
        ? "保持当前车道"
        : mapStage === "takeover"
          ? "无需额外操作"
          : "保持左侧 2 车道";
  ui.mapStageLabel.textContent = mapLabel;
  ui.mapStageIcon.textContent = mapIcon;
  renderSignalToast(worldState?.stage);
  const routeProgress = routeProgressForStage(worldState?.stage || "connecting");
  const showVehicleMarker = driving || ["planning", "service_prepared", "waiting_confirmation", "executing", "action_completed", "cooldown"].includes(worldState?.stage);
  mapAdapter?.update({
    stage: worldState?.stage || "connecting",
    mapStage,
    progress: routeProgress,
    showVehicle: showVehicleMarker,
    driving,
    riskLevel: risk.pressure_level,
    lateMinutes: risk.late_minutes
  });
  ui.carPin.classList.toggle("is-hidden", !showVehicleMarker);
  if (showVehicleMarker) {
    animateVehicleTo(routeProgress);
  } else {
    currentRouteProgress = null;
    ui.routePassed.setAttribute("stroke-dasharray", `${(routeProgress * 100).toFixed(2)} 100`);
    ui.routeProgress.style.height = `${Math.round(routeProgress * 100)}%`;
  }
  const routeDistanceKm = mapRuntimeStatus.mode === "online" && amapRouteMeta?.totalDistanceMeters
    ? amapRouteMeta.totalDistanceMeters / 1000
    : 7.8;
  const remainingKm = Math.max(0, routeDistanceKm * (1 - routeProgress));
  const remainingMinutes = Math.max(1, Math.round(18 * (1 - routeProgress)));
  renderTripValue(ui.amapRemain, driving ? remainingKm.toFixed(1) : "--", driving ? "公里" : "");
  const duration = risk.late_minutes > 0 && !["action_completed", "cooldown", "parked_review"].includes(worldState?.stage)
    ? "36"
    : driving
      ? String(remainingMinutes)
      : "--";
  renderTripValue(ui.amapDuration, duration, driving ? "分钟" : "");
  ui.amapArrival.textContent = eta;
  if (activeDetail && !ui.detailPanel.hidden) openDetail(activeDetail);
}

document.querySelector(".demo")?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-event]");
  if (!button) return;
  button.disabled = true;
  try {
    if (button.dataset.event === "confirm_send") await confirmAction("button");
    else if (button.dataset.event === "reset") await resetSession();
    else await submitEvent(EVENT_BUTTONS[button.dataset.event]);
  } catch (error) {
    log("error", friendlyError(error));
    setConnection(`错误：${friendlyError(error)}`);
  } finally {
    button.disabled = false;
  }
});

ui.confirmBtn.addEventListener("click", async () => {
  ui.confirmBtn.disabled = true;
  try {
    await confirmAction("button");
  } catch (error) {
    log("confirm-error", friendlyError(error));
  } finally {
    render();
  }
});

ui.dismissSignalToast.addEventListener("click", () => {
  window.clearTimeout(signalToastTimer);
  ui.signalToast.hidden = true;
});

ui.tabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-draft]");
  if (!button) return;
  activeDraft = button.dataset.draft;
  ui.tabs.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
  renderDraft();
});
ui.openDrafts.addEventListener("click", () => openDetail("drafts"));
ui.openPlan.addEventListener("click", () => openDetail("plan"));
ui.openVehicle.addEventListener("click", () => openDetail("vehicle"));
ui.openSync.addEventListener("click", () => openDetail("sync"));
ui.openRoute.addEventListener("click", () => openDetail("route"));
ui.openRouteSummary?.addEventListener("click", () => openDetail("route"));
ui.kidTask.addEventListener("click", () => {
  activeTaskDetail = "pickup";
  openDetail("plan");
});
ui.shopTask.addEventListener("click", () => {
  activeTaskDetail = "grocery";
  openDetail("plan");
});
document.querySelectorAll("[data-detail]").forEach((button) => {
  button.addEventListener("click", () => openDetail(button.dataset.detail));
});
document.querySelectorAll("[data-home], .launch-brand").forEach((button) => {
  button.addEventListener("click", closeDetail);
});
ui.quickAskBtn.addEventListener("click", async () => {
  if (!canQuickAsk()) return;
  ui.quickAskBtn.disabled = true;
  try {
    await submitEvent(EVENT_BUTTONS.agent_takeover);
  } catch (error) {
    log("ask-error", friendlyError(error));
  } finally {
    render();
  }
});
ui.closeDetail.addEventListener("click", closeDetail);
ui.detailPanel.addEventListener("click", (event) => {
  if (event.target === ui.detailPanel) closeDetail();
  const draftButton = event.target.closest("button[data-detail-draft]");
  if (draftButton) {
    activeDraft = draftButton.dataset.detailDraft;
    openDetail("drafts");
    return;
  }
  const taskButton = event.target.closest("button[data-task-detail]");
  if (taskButton) {
    activeTaskDetail = taskButton.dataset.taskDetail;
    openDetail("plan");
  }
});

ui.configBtn.addEventListener("click", openConfig);
ui.closeConfig.addEventListener("click", closeConfig);
ui.configPanel.addEventListener("click", (event) => {
  if (event.target === ui.configPanel) closeConfig();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!ui.configPanel.hidden) closeConfig();
  if (!ui.detailPanel.hidden) closeDetail();
});
ui.usePublicAgent.addEventListener("click", () => {
  ui.configApiBase.value = PUBLIC_AGENT_API;
});
ui.useLegacyAgent.addEventListener("click", () => {
  ui.configApiBase.value = LEGACY_AGENT_API;
});
ui.useLocalAgent.addEventListener("click", () => {
  ui.configApiBase.value = LOCAL_AGENT_API;
  ui.configToken.value = "";
});
ui.configForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveConfig();
});
ui.configMapProvider.addEventListener("change", () => {
  if (ui.configMapProvider.value === "offline") {
    ui.mapConfigStatus.textContent = "将使用离线演示地图，不调用外部地图服务。";
  } else if (!ui.configAmapKey.value.trim()) {
    ui.mapConfigStatus.textContent = "需要填写高德 Web JS API Key；未配置时自动回退离线地图。";
  } else if (ui.configAmapServiceHost.value.trim()) {
    ui.mapConfigStatus.textContent = "将通过安全代理加载高德在线地图。";
  } else {
    ui.mapConfigStatus.textContent = "将使用 Security JS Code 明文 Demo 方式加载高德地图。";
  }
});
document.querySelector(".map-tools")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-map-action]");
  if (!button) return;
  if (!mapAdapter?.control(button.dataset.mapAction)) {
    ui.mapWrap.classList.remove("is-map-tool-active");
    void ui.mapWrap.offsetWidth;
    ui.mapWrap.classList.add("is-map-tool-active");
  }
});

window.AURI_HMI = {
  loadState,
  submitEvent,
  confirm: confirmAction,
  reset: resetSession,
  consumeWorldState,
  getState: () => structuredClone(worldState),
  getMapStatus: () => ({ ...mapRuntimeStatus }),
  getMapUsage: () => mapAdapter?.getUsage?.() || null
};

async function bootstrap() {
  render();
  await hydrateMapConfig();
  await mapAdapter?.init(CONFIG);
  const initialDetail = queryParams.get("detail");
  if (["plan", "drafts", "route", "sync", "vehicle"].includes(initialDetail)) openDetail(initialDetail);
  loadHealth("health").catch((error) => log("health-error", friendlyError(error)));
  loadState("load").then(() => {
    connectStream();
    startPolling();
  }).catch((error) => {
    setConnection(`连接失败：${friendlyError(error)}`);
    startPolling();
    render();
  });
}

void bootstrap();
