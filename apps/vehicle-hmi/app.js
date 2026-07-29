const PUBLIC_AGENT_API = "https://auri-agent-api.onrender.com";
const LEGACY_AGENT_API = "https://auri-langchain-agent-api.onrender.com";
const LOCAL_AGENT_API = "http://127.0.0.1:8000";
const DEMO_PRESET_TASK_TEXT = "今天18:10接孩子，之后去超市";
const DEMO_TRAFFIC_DELAY_MINUTES = 18;

const DEFAULT_CONFIG = {
  apiBase: PUBLIC_AGENT_API,
  token: "",
  stream: true,
  pollIntervalMs: 3000,
  mapProvider: "auto",
  amapKey: "",
  amapSecurityJsCode: "",
  amapServiceHost: "",
  amapStyle: "amap://styles/normal"
};

const storedConfigRaw = JSON.parse(localStorage.getItem("auri-hmi-config") || "{}");
const storedConfig = storedConfigRaw.apiBase === LEGACY_AGENT_API && storedConfigRaw.configVersion !== 2
  ? { ...storedConfigRaw, apiBase: PUBLIC_AGENT_API }
  : storedConfigRaw;
const queryParams = new URLSearchParams(window.location.search);
const queryConfig = {
  ...(queryParams.get("apiBase") ? { apiBase: queryParams.get("apiBase") } : {}),
  ...(queryParams.get("streamUrl") ? { streamUrl: queryParams.get("streamUrl") } : {})
};
const windowConfig = window.AURI_CONFIG || {};
const hasExplicitStreamUrl = Boolean(windowConfig.streamUrl || queryConfig.streamUrl);
let CONFIG = normalizeConfig({ ...DEFAULT_CONFIG, ...storedConfig, ...windowConfig, ...queryConfig }, hasExplicitStreamUrl);
const stateView = window.AuriWorldStateView;

const STAGE_VIEW = {
  connecting: ["idle", "AURI 正在连接", "正在读取当前行程和座舱状态。", "正在同步当前状态。", "正在连接 Agent", "无需确认", "请稍候", "连接中"],
  off_vehicle_idle: ["idle", "等待任务创建", "手机端创建任务后，AURI 会识别刚性责任和弹性任务。", "暂无风险结论。", "手机端可语音创建任务", "无需确认", "等待风险成立", "待机"],
  pre_departure_warning: ["delayed", "最晚出发窗口被压缩", "会议延迟 20 分钟，腕上设备已发出黄色提醒。", "仍可能准时，但可用时间明显减少。", "腕上已提醒，车机保持低干扰", "无需确认", "继续观察 ETA", "监控中"],
  handover_to_vehicle: ["warning", "路线正在接续", "接近车辆后，当前路线自动流转到车机。", "手机即将进入只读状态。", "准备进入车辆", "无需确认", "等待车辆状态", "交接中"],
  vehicle_observation: ["vehicle", "导航已接续", "当前目的地路线已经准备，正在持续计算 ETA。", "当前预计可以按时到达。", "可语音询问：“我还来得及吗？”", "无需确认", "保持当前路线", "观察中"],
  takeover_L2: ["risk", "行程风险成立", "关键任务受到影响，等待用户明确求助后生成方案。", "继续加速无法明显缩短时间。", "你可以说：“我还来得及吗？”", "等待方案", "Agent 尚未生成确认项", "分析中"],
  takeover_L3: ["risk", "高负荷保护", "多源辅助信号显示驾驶负荷升高，非必要内容已暂停。", "车机只保留必要判断和安全确认。", "保持驾驶，AURI 正在处理", "等待方案", "高负荷保护中", "保护中"],
  planning: ["takeover", "压力源接管中", "Agent 正在分析任务冲突，并准备消息与服务方案。", "继续加速无法明显缩短时间，正在处理现实后果。", "AURI 正在准备方案", "准备中", "等待确认项生成", "规划中"],
  service_prepared: ["takeover", "方案已准备", "消息和生活服务方案已准备，等待确认。", "消息与服务方案已备好。", "可说：“确认处理”", "确认处理", "等待车机确认", "待确认"],
  waiting_confirmation: ["takeover", "方案等待确认", "任务调整和必要协助已经准备。", "继续加速无法明显缩短时间；Agent 动作组已备好。", "可说：“确认处理”", "确认处理", "执行 Agent 动作组", "待确认"],
  executing: ["takeover", "正在执行", "AURI 正在执行已确认的动作组。", "请继续安全驾驶，动作正在处理。", "正在处理", "执行中", "请勿重复操作", "执行中"],
  action_completed: ["done", "问题已处理", "Agent 动作组已执行，最新结果已同步到各端。", "已处理，按当前速度驾驶即可。", "AURI 已降低打扰", "已完成", "多端状态已同步", "完成"],
  cooldown: ["done", "低干扰恢复", "压力源已处理，AURI 进入冷却状态。", "后续详情停车后在手机端复盘。", "AURI 保持安静", "已完成", "等待停车复盘", "恢复"],
  parked_review: ["done", "停车后复盘", "主交互端回到手机，车机结束本次处理。", "请在手机端查看消息、订单和 Action Ledger。", "手机端复盘", "车机结束", "手机为主端", "复盘"],
  error: ["risk", "连接暂时中断", "AURI 正在重新连接，当前不会执行新的动作。", "请保持当前路线，稍后再试。", "连接异常", "不可确认", "等待状态恢复", "错误"]
};

const MAP_STAGE_VIEW = {
  connecting: ["overview", "同步中", "", "正在读取路线和车辆状态", "等待 Agent", "◎"],
  off_vehicle_idle: ["overview", "路线", "预览", "手机创建任务后准备学校路线", "路线预览", "⌖"],
  pre_departure_warning: ["preview", "出发", "窗口", "最晚出发窗口已压缩", "出发窗口提醒", "◷"],
  handover_to_vehicle: ["preview", "路线", "流转中", "手机路线正在交接到车机", "导航流转中", "⇢"],
  vehicle_observation: ["guidance", "1.5", "公里", "左转进入 学院路高架", "驾驶导航", "⌖"],
  takeover_L2: ["alert", "420", "米", "前方拥堵，保持当前车道", "拥堵风险成立", "!"],
  takeover_L3: ["alert", "420", "米", "高负荷保护，减少非必要提示", "高负荷保护", "!"],
  planning: ["takeover", "420", "米", "继续当前路线，AURI 正在处理", "Agent 接管中", "●"],
  service_prepared: ["takeover", "420", "米", "方案已准备，保持当前路线", "方案等待确认", "●"],
  waiting_confirmation: ["takeover", "420", "米", "方案已准备，保持当前路线", "动作等待确认", "●"],
  executing: ["takeover", "420", "米", "正在执行动作，继续安全驾驶", "动作执行中", "●"],
  action_completed: ["recovery", "1.3", "公里", "方案已处理，继续安全驾驶", "压力源已处理", "✓"],
  cooldown: ["recovery", "1.3", "公里", "保持当前路线，AURI 已降低打扰", "低干扰恢复", "✓"],
  parked_review: ["overview", "已到达", "", "本次行程已结束", "停车后复盘", "✓"],
  error: ["overview", "--", "", "导航状态暂不可用", "等待连接恢复", "!"]
};

const EVENT_BUTTONS = {
  create_task: ["task.created", "mobile", { text: DEMO_PRESET_TASK_TEXT }],
  meeting_delayed: ["meeting.overrun", "demo_console", { delay_minutes: 20 }],
  departure_warning: ["scene.approaching", "demo_console", {}],
  enter_vehicle: ["scene.vehicle_entered", "demo_console", {}],
  traffic_jam: ["traffic.updated", "demo_console", null],
  stress_signal: ["wearable.signal", "wearable", { heart_rate: 120, confidence: 0.9 }],
  agent_takeover: ["user.utterance", "vehicle_hmi", { text: "我还来得及吗？帮我处理" }],
  restore: ["cooldown.elapsed", "demo_console", {}]
};

function trafficPayload(state) {
  const tasks = stateView.sortedTasks(state);
  const referenceTask = tasks.find((task) => task.task_type === "rigid" && task.scheduled_at)
    || tasks.find((task) => task.scheduled_at);
  const scheduledAt = Date.parse(referenceTask?.scheduled_at || "");
  if (Number.isFinite(scheduledAt)) {
    return {
      eta: new Date(scheduledAt + DEMO_TRAFFIC_DELAY_MINUTES * 60_000).toISOString(),
      late_minutes: DEMO_TRAFFIC_DELAY_MINUTES
    };
  }
  return { late_minutes: DEMO_TRAFFIC_DELAY_MINUTES };
}

function eventDefinition(definition) {
  const [type, source, payload] = definition;
  return [type, source, type === "traffic.updated" ? trafficPayload(worldState) : payload];
}

const $ = (id) => document.querySelector(id);
const ui = {
  root: $(".screen"), speed: $("#speed"), headline: $("#headline"), destination: $("#destination"),
  mapDestinationLabel: $("#mapDestinationLabel"), eta: $("#eta"), etaNote: $("#etaNote"),
  windowState: $("#windowState"), windowLabel: $("#windowLabel"), windowDetail: $("#windowDetail"),
  modeChip: $("#modeChip"), phoneStatus: $("#phoneStatus"), watchStatus: $("#watchStatus"),
  carStatus: $("#carStatus"), phoneNode: $("#phoneNode"), watchNode: $("#watchNode"), carNode: $("#carNode"),
  handoffSummary: $("#handoffSummary"), taskBoard: $("#taskBoard"), agentState: $("#agentState"), agentTitle: $("#agentTitle"),
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
  syncSummary: $("#syncSummary"), openRouteSummary: $("#openRouteSummary"),
  decisionStage: $("#decisionStage"), decisionIcon: $("#decisionIcon"), decisionSurface: $("#decisionSurface"),
  decisionProgress: $("#decisionProgress"), conclusionStage: $("#conclusionStage"), reviewLinks: $("#reviewLinks")
};

let worldState = null;
let activeDraft = null;
let activeTaskDetail = null;
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
  const candidates = [...new Set([CONFIG.apiBase, LEGACY_AGENT_API])];
  for (const apiBase of candidates) {
    try {
      const response = await fetch(`${apiBase}/v1/map-config`, {
        headers: authHeaders({ Accept: "application/json" })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.enabled || !data.key || !data.service_host) continue;
      CONFIG = normalizeConfig({
        ...CONFIG,
        mapProvider: "amap",
        amapKey: data.key,
        amapSecurityJsCode: "",
        amapServiceHost: data.service_host,
        amapStyle: data.style || "amap://styles/normal"
      });
      log("map-config", apiBase === CONFIG.apiBase ? "已从 Agent 获取高德在线地图配置" : "已从备用地图服务获取高德配置");
      return;
    } catch (error) {
      log("map-config-retry", `${apiBase} · ${friendlyError(error)}`);
    }
  }
  log("map-config", "未获取高德配置，使用离线演示地图");
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
    configVersion: 2,
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
    activeDraft = null;
    activeTaskDetail = null;
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
  const [type, source, payload] = eventDefinition(definition);
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
  const view = [...(STAGE_VIEW[worldState.stage] || STAGE_VIEW.error)];
  const counts = stateView.taskCounts(worldState);
  const primary = stateView.primaryTask(worldState);
  const navigation = stateView.navigationTask(worldState);
  const progress = stateView.actionProgress(worldState);
  const lateMinutes = Number(worldState.risk?.late_minutes || 0);
  const primaryTitle = primary?.title || "关键任务";
  const destination = navigation?.location || navigation?.title || "目的地";

  if (worldState.stage === "off_vehicle_idle" && counts.total) {
    view[1] = `${counts.total} 项任务已同步`;
    view[2] = `${counts.rigid} 项刚性、${counts.flexible} 项弹性任务，AURI 将持续检查时间冲突。`;
    view[3] = lateMinutes > 0 ? `当前预计晚到 ${lateMinutes} 分钟。` : "当前任务暂无行程风险。";
  } else if (worldState.stage === "pre_departure_warning") {
    view[1] = `${primaryTitle}出发时间紧张`;
    view[2] = lateMinutes > 0
      ? `${primaryTitle}当前预计晚到 ${lateMinutes} 分钟，腕上设备已提醒。`
      : `${primaryTitle}的可用出发时间正在减少，腕上设备已提醒。`;
  } else if (worldState.stage === "handover_to_vehicle") {
    view[1] = `${destination}路线正在接续`;
    view[2] = `${counts.total} 项任务和当前路线正在从手机同步到车机。`;
  } else if (worldState.stage === "vehicle_observation") {
    view[1] = `${destination}导航已接续`;
    view[2] = `${primaryTitle}保持当前计划，AURI 正在持续计算 ETA。`;
  } else if (["takeover_L2", "takeover_L3"].includes(worldState.stage)) {
    view[1] = lateMinutes > 0 ? `预计晚到 ${lateMinutes} 分钟` : `${primaryTitle}存在风险`;
    view[2] = `${primaryTitle}受到影响，等待用户求助或 Agent 生成处理方案。`;
  } else if (worldState.stage === "planning") {
    view[2] = `Agent 正在分析 ${counts.total} 项任务，并准备可执行的调整方案。`;
  } else if (["service_prepared", "waiting_confirmation"].includes(worldState.stage)) {
    view[1] = progress.total ? `${progress.total} 项动作已准备` : "等待 Agent 方案";
    view[2] = progress.total
      ? `方案基于当前 ${counts.total} 项任务生成，等待确认后统一执行。`
      : "当前 World State 中没有可确认动作。";
    view[3] = progress.total ? view[3] : "Agent 尚未生成可执行方案。";
    view[5] = progress.total ? view[5] : "无需确认";
    view[6] = progress.total ? `执行 ${progress.total} 项 Agent 动作` : "等待确认内容";
    view[7] = progress.total ? view[7] : "等待";
  } else if (["executing", "action_completed", "cooldown"].includes(worldState.stage)) {
    view[2] = progress.total
      ? `${progress.completed}/${progress.total} 项动作已完成，状态正在同步到各端。`
      : view[2];
  } else if (worldState.stage === "parked_review") {
    view[2] = `本次共处理 ${counts.total} 项任务，完整结果已同步到手机。`;
  }

  if (progress.total) view[7] = `${progress.completed}/${progress.total}`;
  return view;
}

function mapStageView() {
  if (!worldState) return MAP_STAGE_VIEW.connecting;
  const view = [...(MAP_STAGE_VIEW[worldState.stage] || MAP_STAGE_VIEW.error)];
  const navigation = stateView.navigationTask(worldState);
  const progress = stateView.actionProgress(worldState);
  if (worldState.stage === "off_vehicle_idle" && navigation) {
    view[3] = `${navigation.location || navigation.title}路线等待接续`;
  }
  if (worldState.stage === "handover_to_vehicle" && navigation) {
    view[3] = `${navigation.location || navigation.title}路线正在交接到车机`;
  }
  if (["service_prepared", "waiting_confirmation"].includes(worldState.stage)) {
    view[4] = progress.total ? `${progress.total} 项动作待确认` : "方案等待确认";
  }
  return view;
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
  const primary = stateView.primaryTask(worldState);
  const taskTitle = primary?.title || "关键任务";
  const lateMinutes = Number(worldState?.risk?.late_minutes || 0);
  const wearable = worldState?.wearable;
  const haptic = hapticLabel(wearable?.haptic);
  if (wearable?.mode === "warning" && wearable?.haptic && wearable.haptic !== "none") {
    return [
      "warning",
      "腕上设备提醒",
      wearable.text || `${taskTitle}需要关注`,
      `黄色提示 · ${haptic}`,
      "◉"
    ];
  }
  if (wearable?.mode === "handover" && wearable?.haptic && wearable.haptic !== "none") {
    return ["warning", "腕上设备", wearable.text || "驾驶已连接", `蓝色连接提示 · ${haptic}`, "↔"];
  }
  if (stage === "pre_departure_warning") {
    return ["warning", "腕上提醒", `${taskTitle}出发时间临近`, "黄色提示 · 双短震", "◷"];
  }
  if (stage === "takeover_L3") {
    return ["critical", "腕上压力信号", "驾驶负荷升高", "红色保护提示 · 一次组合振动", "!"];
  }
  if (stage === "takeover_L2") {
    if (worldState?.wearable?.text === "压力信号升高") {
      return ["warning", "腕上压力信号", "压力趋势升高", "黄色提示 · 双短震", "◉"];
    }
    return [
      "warning",
      "AURI 风险提醒",
      lateMinutes > 0 ? `${taskTitle}预计晚到 ${lateMinutes} 分钟` : `${taskTitle}存在时间风险`,
      "车机进入低干扰 · 腕上保持驾驶连接",
      "◉"
    ];
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
}

function riskLabel(stage, risk) {
  if (stage === "error") return "⚠ 连接异常";
  if (["action_completed", "cooldown", "parked_review"].includes(stage)) return "✓ 已处理";
  if (risk.pressure_level === "L3") return "⚠ L3 高负荷";
  if (risk.pressure_level === "L2") return "⚠ L2 接管";
  if (risk.pressure_level === "L1") return "⏱ L1 注意";
  return "○ L0 低干扰";
}

function driverConclusion(viewConclusion) {
  return stateView.driverConclusion(worldState, viewConclusion);
}

function formatTime(value) {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
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

function decisionMeta(stage) {
  if (stage === "error") return { icon: "!", label: "连接异常", tone: "critical" };
  if (stage === "takeover_L3") return { icon: "!", label: "高负荷保护", tone: "critical" };
  if (["pre_departure_warning", "takeover_L2"].includes(stage)) {
    return { icon: "◷", label: "需要注意", tone: "warning" };
  }
  if (["planning", "executing", "handover_to_vehicle", "connecting"].includes(stage)) {
    return { icon: "↻", label: "正在处理", tone: "processing" };
  }
  if (["service_prepared", "waiting_confirmation"].includes(stage)) {
    return { icon: "✓", label: "方案已准备", tone: "warning" };
  }
  if (stage === "parked_review") return { icon: "▯", label: "手机接续", tone: "success" };
  if (["action_completed", "cooldown"].includes(stage)) {
    return { icon: "✓", label: "已处理", tone: "success" };
  }
  if (stage === "vehicle_observation") return { icon: "⌖", label: "行程正常", tone: "success" };
  return { icon: "○", label: "低干扰", tone: "idle" };
}

function actionText(action) {
  return stateView.actionText(action);
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

function draftMarkup(action) {
  const target = action?.target || "联系人";
  const status = action?.status === "completed" ? "已发送" : action ? "等待确认" : "尚未生成";
  const lines = splitDisplayText(action?.summary || "等待 Agent 生成消息内容。");
  return `
    <article class="message-preview">
      <header>
        <span><strong>${escapeHtml(target)}</strong><em>Agent 消息</em></span>
        <b class="${action?.status === "completed" ? "done" : ""}">${status}</b>
      </header>
      <div>${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>
    </article>
  `;
}

function renderActions() {
  const actions = stateView.actions(worldState);
  if (!actions.length) {
    ui.actionList.innerHTML = "<li>等待 Agent 生成动作组</li>";
    return;
  }
  const visible = actions.slice(0, 3).map((action) => {
    const cls = action.status === "completed" ? "done" : action.status === "awaiting_confirmation" ? "pending" : "";
    return `<li class="${cls}">${escapeHtml(actionText(action))}</li>`;
  });
  if (actions.length > 3) visible.push(`<li class="more">另有 ${actions.length - 3} 项，点击“方案”查看</li>`);
  ui.actionList.innerHTML = visible.join("");
}

function renderDraft() {
  const messageActions = stateView.actions(worldState).filter((action) => action.type === "message");
  if (!messageActions.length) {
    ui.draftState.textContent = "未生成";
    const hidden = $("#draftStateHidden");
    if (hidden) hidden.textContent = "未生成";
    ui.draftBody.textContent = "Agent 尚未生成消息动作。";
    return;
  }
  const current = messageActions.find((action) => action.action_id === activeDraft) || messageActions[0];
  activeDraft = current.action_id;
  const draftLabel = current.status === "completed" ? "已模拟发送" : "等待确认";
  ui.draftState.textContent = draftLabel;
  const hidden = $("#draftStateHidden");
  if (hidden) hidden.textContent = draftLabel;
  ui.draftBody.textContent = current.summary || `${current.target || "联系人"}消息已生成`;
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
  return stateView.actionStatusLabel(status);
}

function renderTaskBoard() {
  const tasks = stateView.sortedTasks(worldState);
  if (!tasks.length) {
    ui.taskBoard.className = "task-board empty";
    ui.taskBoard.style.setProperty("--task-columns", "1");
    ui.taskBoard.innerHTML = `
      <div class="task-empty">
        <strong>等待任务同步</strong>
        <span>手机创建任务后在此显示</span>
      </div>
    `;
    return;
  }
  const columns = Math.min(tasks.length, 2);
  ui.taskBoard.className = `task-board count-${Math.min(tasks.length, 4)}${tasks.length > 2 ? " many" : ""}`;
  ui.taskBoard.style.setProperty("--task-columns", String(columns));
  ui.taskBoard.innerHTML = tasks.map((task) => {
    const item = stateView.taskView(task, worldState?.risk);
    return `
      <button class="task-card ${item.tone} active" type="button" data-task-id="${escapeHtml(item.id)}">
        <span class="task-copy">
          <em>${escapeHtml(item.type)} · ${escapeHtml(item.meta)}</em>
          <strong>${escapeHtml(item.title)}</strong>
        </span>
        <span class="task-status">${escapeHtml(item.status)}</span>
      </button>
    `;
  }).join("");
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

function planResultSummary() {
  return stateView.planSummary(worldState);
}

function openDetail(kind) {
  const risk = worldState?.risk || { pressure_level: "L0", late_minutes: 0 };
  const eta = formatTime(worldState?.eta);
  const tasks = stateView.sortedTasks(worldState);
  const counts = stateView.taskCounts(worldState);
  const primary = stateView.primaryTask(worldState);
  const navigation = stateView.navigationTask(worldState);
  const actions = stateView.actions(worldState);
  const progress = stateView.actionProgress(worldState);
  const climate = stateView.climate(worldState);

  if (kind === "drafts") {
    renderDraft();
    const messageActions = actions.filter((action) => action.type === "message");
    const currentAction = messageActions.find((action) => action.action_id === activeDraft) || messageActions[0];
    if (currentAction) activeDraft = currentAction.action_id;
    ui.detailTitle.textContent = "消息";
    ui.detailBody.innerHTML = `
      <section class="message-overview">
        <span>消息协助</span>
        <strong>${messageActions.length ? `${messageActions.length} 条草稿已准备` : "等待 Agent 生成"}</strong>
        <p>${messageActions.length ? "联系人和消息状态来自当前 Agent 动作组。" : "当前 World State 中没有消息动作。"}</p>
      </section>
      ${messageActions.length ? `
        <div class="detail-tabs contact-tabs">
          ${messageActions.map((action) => `
            <button type="button" data-detail-draft="${escapeHtml(action.action_id)}" class="${activeDraft === action.action_id ? "active" : ""}">
              <span class="contact-avatar">${escapeHtml((action.target || "联").slice(0, 1))}</span>
              <span><strong>${escapeHtml(action.target || "联系人")}</strong><em>${escapeHtml(actionStatusLabel(action.status))}</em></span>
            </button>
          `).join("")}
        </div>
        ${draftMarkup(currentAction)}
      ` : detailCopyItem("当前状态", "Agent 尚未生成消息动作。")}
      <div class="message-state-strip">
        <span class="${messageActions.length ? "done" : ""}"><i></i>生成草稿</span>
        <b></b>
        <span class="${currentAction?.status === "completed" ? "done" : "current"}"><i></i>${currentAction?.status === "completed" ? "已模拟发送" : "等待确认"}</span>
      </div>
    `;
  } else if (kind === "plan") {
    ui.detailTitle.textContent = "任务与方案";
    const taskRisk = risk.late_minutes > 0;
    if (!activeTaskDetail || !tasks.some((task) => task.task_id === activeTaskDetail)) {
      activeTaskDetail = primary?.task_id || null;
    }
    ui.detailBody.innerHTML = `
      <section class="task-overview ${taskRisk ? "warning" : ""}">
        <span class="task-overview-kicker">当前任务组合</span>
        <strong>${escapeHtml(stateView.taskTitle(primary))}</strong>
        <p>${taskRisk
          ? `关键任务预计晚到 ${risk.late_minutes} 分钟，AURI 正按优先级处理全部任务。`
          : counts.total
            ? `${counts.rigid} 项刚性、${counts.flexible} 项弹性任务已从 Agent 同步。`
            : "等待手机创建任务并同步到 Agent。"
        }</p>
        <div class="task-overview-meta">
          <span><b>${counts.total}</b> 个任务</span>
          <span><b>${progress.total}</b> 个动作</span>
          <span class="${worldState?.confirmation?.status === "pending" ? "warning" : ""}">${worldState?.confirmation?.status === "pending" ? "等待确认" : "状态同步"}</span>
        </div>
      </section>
      <div class="task-flow-list">
        ${tasks.length
          ? tasks.map((task) => taskFlowCard({
              ...stateView.taskView(task, risk),
              selected: activeTaskDetail === task.task_id
            })).join("")
          : detailCopyItem("任务", "当前 World State 中没有任务。")
        }
      </div>
      <section class="task-action-summary">
        <header><span>动作进度</span><strong>${progress.completed}/${progress.total}</strong></header>
        <div class="task-action-track"><i style="--task-progress:${progress.percent}%"></i></div>
        <p>${escapeHtml(planResultSummary())}</p>
        ${actions.length ? `<ul class="detail-action-list">${actions.map((action) => `
          <li class="${escapeHtml(action.status)}">
            <span>${escapeHtml(action.summary || actionText(action))}</span>
            <b>${escapeHtml(actionStatusLabel(action.status))}</b>
          </li>
        `).join("")}</ul>` : ""}
      </section>
    `;
  } else if (kind === "vehicle") {
    ui.detailTitle.textContent = "座舱状态";
    const fanLevel = { 低: 1, 中: 2, 高: 3 }[climate.fan] || 0;
    ui.detailBody.innerHTML = `
      <section class="cabin-overview ${climate.on ? "is-on" : "is-off"}">
        <div class="cabin-temperature">
          <span>目标温度</span>
          <strong>${escapeHtml(climate.temperature)}<small>°C</small></strong>
          <em><i></i> ${climate.available ? `AC ${climate.on ? "已开启" : "已关闭"}` : "等待 Agent 同步"}</em>
        </div>
        <div class="cabin-airflow">
          <span>${escapeHtml(climate.mode)}</span>
          <div class="fan-meter" aria-label="风量${escapeHtml(climate.fan)}">
            ${[1, 2, 3].map((level) => `<i class="${level <= fanLevel ? "active" : ""}"></i>`).join("")}
          </div>
          <strong>风量 ${escapeHtml(climate.fan)}</strong>
        </div>
      </section>
      <div class="cabin-control-grid">
        <article class="${climate.on ? "active" : ""}">
          <span>温控模式</span>
          <strong>${escapeHtml(climate.mode)}</strong>
          <em>${climate.available ? (climate.on ? "正在调节" : "当前待机") : "等待状态"}</em>
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
      <div class="cabin-sync-note"><i></i><span>${climate.available ? `来自 Agent revision ${escapeHtml(worldState?.revision ?? "--")}` : "等待 Agent 返回 vehicle_state"}</span></div>
    `;
  } else if (kind === "route") {
    ui.detailTitle.textContent = "行程详情";
    ui.detailBody.innerHTML = `
      <div class="detail-list">
        ${detailItem("目的地", navigation?.location || navigation?.title || "等待路线")}
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
  const primary = stateView.primaryTask(worldState);
  const navigation = stateView.navigationTask(worldState);
  const actionProgress = stateView.actionProgress(worldState);
  const canConfirm = worldState?.primary_surface === "vehicle_hmi"
    && worldState?.confirmation?.owner_surface === "vehicle_hmi"
    && worldState?.confirmation?.status === "pending";
  const driving = ["driving", "high_load_driving"].includes(worldState?.scene);
  const climate = stateView.climate(worldState);
  const showDebugDemo = queryParams.get("debug") === "1" || queryParams.get("demo") === "1";

  const stage = worldState?.stage || "connecting";
  const decision = decisionMeta(stage);
  ui.root.className = `screen state-${className} stage-${stage} map-stage-${mapStage}${showDebugDemo ? " debug-demo" : ""}`;
  animateMapStage(mapStage);
  ui.speed.textContent = driving ? "42" : "--";
  ui.headline.textContent = navigation
    ? `博世苏州 · 星龙街455号 → ${navigation.location || navigation.title}`
    : "博世苏州 · 星龙街455号 → 目的地待定";
  const destinationName = navigation?.location || navigation?.title || "目的地待定";
  ui.destination.textContent = destinationName;
  ui.mapDestinationLabel.textContent = destinationName.length > 8 ? `${destinationName.slice(0, 8)}…` : destinationName;
  ui.eta.textContent = eta;
  ui.etaNote.textContent = risk.late_minutes > 0 ? `晚到 ${risk.late_minutes} 分钟` : eta === "--:--" ? "等待路线" : "准时";
  ui.windowLabel.textContent = primary ? (primary.task_type === "rigid" ? "关键任务" : "当前任务") : "任务状态";
  ui.windowState.textContent = risk.late_minutes > 0
    ? `晚到 ${risk.late_minutes} 分钟`
    : stage === "pre_departure_warning"
      ? "出发时间紧张"
      : primary
        ? "可按时到达"
        : "等待创建";
  ui.windowDetail.textContent = primary
    ? `${stateView.formatClock(primary.scheduled_at) || "时间待定"} · ${primary.title}`
    : "手机端创建任务";
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
  renderTaskBoard();
  ui.agentTitle.textContent = title;
  ui.agentText.textContent = text;
  ui.realConclusion.textContent = driverConclusion(conclusion);
  ui.agentState.dataset.tone = decision.tone;
  ui.decisionStage.textContent = decision.label;
  ui.decisionIcon.textContent = decision.icon;
  ui.decisionSurface.textContent = surfaceLabel(worldState?.primary_surface);
  ui.decisionProgress.textContent = actionState;
  ui.conclusionStage.textContent = stage === "parked_review"
    ? "停车后继续"
    : ["action_completed", "cooldown"].includes(stage)
      ? "保持低干扰"
      : risk.late_minutes > 0
        ? "当前建议"
        : "行程建议";
  ui.reviewLinks.hidden = stage !== "parked_review";
  ui.riskBadge.textContent = riskLabel(worldState?.stage, risk);
  ui.actionState.textContent = actionProgress.total ? `${actionProgress.completed}/${actionProgress.total}` : actionState;
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
  ui.acState.textContent = climate.summary;
  ui.acTemp.textContent = `${climate.temperature}°`;
  ui.acMode.textContent = climate.mode;
  ui.acFan.textContent = climate.fan;
  ui.climateTemp.textContent = `${climate.temperature}°`;
  ui.climateMode.textContent = climate.available
    ? `AC ${climate.on ? "开启" : "关闭"} · ${climate.mode} · 风量${climate.fan}`
    : climate.summary;
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
    : navigation
      ? 7.8
      : 0;
  const remainingKm = Math.max(0, routeDistanceKm * (1 - routeProgress));
  const mapRemainingMinutes = mapRuntimeStatus.mode === "online" && amapRouteMeta?.totalDurationSeconds
    ? Math.max(1, Math.round((amapRouteMeta.totalDurationSeconds * (1 - routeProgress)) / 60))
    : null;
  const etaTime = Date.parse(worldState?.eta || "");
  const etaRemainingMinutes = Number.isFinite(etaTime) && etaTime > Date.now()
    ? Math.max(1, Math.ceil((etaTime - Date.now()) / 60_000))
    : null;
  const remainingMinutes = etaRemainingMinutes ?? mapRemainingMinutes;
  renderTripValue(ui.amapRemain, driving ? remainingKm.toFixed(1) : "--", driving ? "公里" : "");
  renderTripValue(
    ui.amapDuration,
    driving && remainingMinutes ? String(remainingMinutes) : "--",
    driving && remainingMinutes ? "分钟" : ""
  );
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
ui.taskBoard.addEventListener("click", (event) => {
  const taskButton = event.target.closest("button[data-task-id]");
  if (!taskButton) return;
  activeTaskDetail = taskButton.dataset.taskId;
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
  getViewState: () => ({
    tasks: stateView.sortedTasks(worldState).map((task) => stateView.taskView(task, worldState?.risk)),
    taskCounts: stateView.taskCounts(worldState),
    actionProgress: stateView.actionProgress(worldState),
    climate: stateView.climate(worldState),
    conclusion: ui.realConclusion.textContent
  }),
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
