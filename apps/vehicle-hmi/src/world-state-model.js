(function initAuriWorldStateModel(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AuriWorldStateModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createWorldStateModel() {
  "use strict";

  const SCHEMA_VERSION = "0.2.0";
  const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
  const TASK_STATUS = { pending: "待处理", rescheduled: "已调整", completed: "已完成" };
  const ACTION_STATUS = {
    planned: "已规划",
    ready: "已准备",
    awaiting_confirmation: "待确认",
    completed: "已完成",
    blocked: "已阻断",
    failed: "失败"
  };
  const STAGE_LABEL = {
    off_vehicle_idle: "等待任务",
    pre_departure_warning: "出发窗口收紧",
    handover_to_vehicle: "路线接续中",
    vehicle_observation: "行程观察中",
    takeover_L2: "行程风险成立",
    takeover_L3: "高负荷保护",
    planning: "AURI 正在处理",
    service_prepared: "方案已准备",
    waiting_confirmation: "等待确认",
    executing: "正在执行",
    service_executed: "服务已执行",
    action_completed: "问题已处理",
    cooldown: "低干扰恢复",
    parked_review: "停车后复盘",
    error: "连接异常"
  };
  const RISK_VIEW = {
    L0: { label: "状态平稳", tone: "calm", icon: "✓" },
    L1: { label: "时间窗口收紧", tone: "warning", icon: "◷" },
    L2: { label: "需要处理", tone: "processing", icon: "A" },
    L3: { label: "高负荷保护", tone: "critical", icon: "!" },
    Recovery: { label: "正在恢复", tone: "success", icon: "✓" }
  };
  const STAGES = new Set(Object.keys(STAGE_LABEL));
  const SCENES = new Set(["off_vehicle", "approaching_vehicle", "driving", "high_load_driving", "parked"]);
  const SURFACES = new Set(["mobile", "vehicle_hmi", "none"]);

  function asArray(value) {
    return Array.isArray(value) ? value.filter(Boolean) : [];
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatClock(value, locale = "zh-CN", timeZone = "Asia/Shanghai") {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone
    }).format(date);
  }

  function previewText(value, maxLength = 72) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }

  function isClimateOnlyConclusion(value) {
    const text = String(value || "");
    if (!text) return false;
    const mentionsClimate = /(空调|AC|温度|制冷|制热|送风|风量|座舱温控)/i.test(text);
    const mentionsJourney = /(晚到|到达|ETA|路线|驾驶|拥堵|出发|确认|消息|订单|任务|方案|已处理)/i.test(text);
    return mentionsClimate && !mentionsJourney;
  }

  function validateEnvelope(state) {
    if (!state || typeof state !== "object") return { valid: false, reason: "invalid_payload" };
    if (state.schema_version !== SCHEMA_VERSION) return { valid: false, reason: "schema_incompatible" };
    if (!String(state.session_id || "").trim()) return { valid: false, reason: "missing_session" };
    if (!Number.isInteger(state.revision) || state.revision < 0) return { valid: false, reason: "invalid_revision" };
    if (!String(state.updated_at || "").trim() || Number.isNaN(Date.parse(state.updated_at))) return { valid: false, reason: "invalid_updated_at" };
    if (!STAGES.has(state.stage)) return { valid: false, reason: "invalid_stage" };
    if (!SCENES.has(state.scene)) return { valid: false, reason: "invalid_scene" };
    if (!SURFACES.has(state.primary_surface)) return { valid: false, reason: "invalid_primary_surface" };
    if (!state.risk || typeof state.risk !== "object") return { valid: false, reason: "missing_risk" };
    for (const key of ["tasks", "actions", "service_orders", "action_ledger"]) {
      if (!Array.isArray(state[key])) return { valid: false, reason: `invalid_${key}` };
    }
    if (!state.profile || typeof state.profile !== "object") return { valid: false, reason: "missing_profile" };
    if (!state.wearable || typeof state.wearable !== "object") return { valid: false, reason: "missing_wearable" };
    if (!state.vehicle_state || typeof state.vehicle_state !== "object") return { valid: false, reason: "missing_vehicle_state" };
    return { valid: true, reason: null };
  }

  function acceptWorldState(previousMeta, incomingState) {
    const validation = validateEnvelope(incomingState);
    if (!validation.valid) return { accepted: false, resetRequired: false, reason: validation.reason };
    if (!previousMeta?.sessionId) return { accepted: true, resetRequired: true, reason: "initial" };
    if (previousMeta.retiredSessionIds?.includes(incomingState.session_id)) {
      return { accepted: false, resetRequired: false, reason: "retired_session" };
    }
    if (previousMeta.sessionId !== incomingState.session_id) {
      return { accepted: true, resetRequired: true, reason: "new_session" };
    }
    if (incomingState.revision <= Number(previousMeta.revision ?? -1)) {
      return { accepted: false, resetRequired: false, reason: "stale_revision" };
    }
    return { accepted: true, resetRequired: false, reason: "new_revision" };
  }

  function taskSortValue(task, index) {
    const completed = task.status === "completed" ? 1000 : 0;
    const rigid = task.task_type === "rigid" ? 0 : 100;
    const priority = PRIORITY_RANK[task.priority] ?? 1;
    const timestamp = Date.parse(task.scheduled_at || "");
    return [completed + rigid + priority, Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp, index];
  }

  function sortedTasks(state) {
    return asArray(state?.tasks)
      .map((task, index) => ({ task, sort: taskSortValue(task, index) }))
      .sort((left, right) => left.sort[0] - right.sort[0] || left.sort[1] - right.sort[1] || left.sort[2] - right.sort[2])
      .map((item) => item.task);
  }

  function taskStatus(task) {
    if (TASK_STATUS[task.status] && task.status !== "pending") return TASK_STATUS[task.status];
    if (task.task_type === "rigid" && task.adjustable === false) return "不可后置";
    if (task.adjustable === true) return "可调整";
    return TASK_STATUS[task.status] || "待处理";
  }

  function taskView(task, locale, timeZone) {
    const time = formatClock(task.scheduled_at, locale, timeZone);
    return {
      id: task.task_id || "",
      title: String(task.title || "未命名任务"),
      displayTitle: time ? `${time} ${task.title || "未命名任务"}` : String(task.title || "未命名任务"),
      time,
      location: String(task.location || ""),
      type: task.task_type === "rigid" ? "刚性责任" : "弹性任务",
      tone: task.task_type === "rigid" ? "rigid" : "flexible",
      status: taskStatus(task),
      completed: task.status === "completed",
      waitingParty: asArray(task.waiting_party).map(String),
      raw: task
    };
  }

  function geoPointView(point) {
    if (!point || typeof point !== "object") return null;
    const name = String(point.name || "").trim();
    const longitude = finiteNumber(point.longitude);
    const latitude = finiteNumber(point.latitude);
    if (!name || longitude === null || latitude === null || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
    return {
      name,
      address: String(point.address || "").trim(),
      longitude,
      latitude,
      coordinates: [longitude, latitude]
    };
  }

  function navigationContractView(state) {
    const navigation = state?.navigation;
    if (!navigation || typeof navigation !== "object") return null;
    const id = String(navigation.route_id || "").trim();
    const taskId = String(navigation.task_id || "").trim();
    const source = navigation.source;
    const taskExists = asArray(state.tasks).some((task) => task?.task_id === taskId);
    if (!id || !taskId || !taskExists || !["agent", "vehicle_api", "demo_fixture"].includes(source) || typeof navigation.is_simulated !== "boolean") return null;
    const origin = geoPointView(navigation.origin);
    const destination = geoPointView(navigation.destination);
    if (!origin || !destination) return null;
    const progressValue = navigation.progress === null || navigation.progress === undefined
      ? null
      : finiteNumber(navigation.progress);
    return {
      id,
      taskId,
      origin,
      destination,
      currentLocation: geoPointView(navigation.current_location),
      progress: progressValue === null ? null : Math.min(1, Math.max(0, progressValue)),
      source,
      isSimulated: navigation.is_simulated,
      updatedAt: navigation.updated_at || null
    };
  }

  function actionView(action) {
    const summary = String(action.summary || "Agent 动作");
    const draft = action.message_draft && typeof action.message_draft === "object"
      ? action.message_draft
      : null;
    let messageBody = "";
    if (action.type === "message") {
      messageBody = String(draft?.body || summary).trim();
      const draftPrefix = `给${String(action.target || "")}的消息草稿：`;
      const sentPrefix = `已模拟发送给${String(action.target || "")}：`;
      if (!draft && messageBody.startsWith(draftPrefix)) messageBody = messageBody.slice(draftPrefix.length).trim();
      if (!draft && messageBody.startsWith(sentPrefix)) messageBody = messageBody.slice(sentPrefix.length).trim();
    }
    return {
      id: action.action_id || "",
      type: action.type || "unknown",
      target: String(action.target || ""),
      status: action.status || "planned",
      statusLabel: ACTION_STATUS[action.status] || "待处理",
      summary,
      preview: previewText(summary, 88),
      messageBody,
      messagePreview: messageBody ? previewText(messageBody, 72) : "",
      messageDraft: messageBody ? {
        body: messageBody,
        channel: String(draft?.channel || "demo"),
        isSimulated: draft?.is_simulated !== false
      } : null,
      errorCode: action.error_code || null,
      requiresConfirmation: action.requires_confirmation === true,
      detailsRef: action.details_ref || null
    };
  }

  function actionSummary(actions) {
    const counts = { total: actions.length, completed: 0, pending: 0, blocked: 0, failed: 0 };
    actions.forEach((action) => {
      if (action.status === "completed") counts.completed += 1;
      else if (action.status === "blocked") counts.blocked += 1;
      else if (action.status === "failed") counts.failed += 1;
      else counts.pending += 1;
    });
    counts.percent = counts.total ? Math.round((counts.completed / counts.total) * 100) : 0;
    return counts;
  }

  function vehicleView(state) {
    const vehicle = state?.vehicle_state;
    if (!vehicle || typeof vehicle !== "object") {
      return { available: false, acOn: null, temperature: null, temperatureLabel: "--", rawMode: "auto", rawFan: "medium", mode: "数据不可用", fan: "数据不可用", summary: "等待座舱状态同步" };
    }
    const temperature = finiteNumber(vehicle.ac_target_temp);
    const mode = { auto: "自动", cool: "制冷", heat: "制热", fan: "送风" }[vehicle.ac_mode] || "数据不可用";
    const fan = { low: "低风量", medium: "中风量", high: "高风量" }[vehicle.fan_speed] || "数据不可用";
    const temperatureLabel = temperature === null ? "--" : `${Number.isInteger(temperature) ? temperature : temperature.toFixed(1)}°C`;
    return {
      available: temperature !== null && mode !== "数据不可用" && fan !== "数据不可用",
      acOn: vehicle.ac_on === true,
      temperature,
      temperatureLabel,
      rawMode: vehicle.ac_mode,
      rawFan: vehicle.fan_speed,
      mode,
      fan,
      summary: `AC ${vehicle.ac_on === true ? "已开启" : "已关闭"} · ${temperatureLabel} · ${mode} · ${fan}`
    };
  }

  function wearableView(state) {
    const wearable = state?.wearable || {};
    const modeLabel = {
      idle: "保持安静",
      warning: "提醒已送达",
      handover: "正在接续",
      processing: "处理状态已同步",
      completed: "问题已处理",
      error: "设备异常"
    }[wearable.mode] || "等待状态";
    return {
      connected: wearable.connected === true,
      mode: wearable.mode || "idle",
      modeLabel,
      text: String(wearable.text || modeLabel),
      color: wearable.color || null,
      haptic: wearable.haptic || null,
      commandId: wearable.command_id || null,
      heartRate: finiteNumber(wearable.heart_rate),
      signalConfidence: finiteNumber(wearable.signal_confidence)
    };
  }

  function orderView(order) {
    const items = asArray(order.items).map((item) => ({
      sku: String(item.sku || ""),
      name: String(item.name || "商品"),
      quantity: finiteNumber(item.quantity) || 0,
      unitPrice: finiteNumber(item.unit_price),
      subtotal: finiteNumber(item.subtotal),
      substitution: item.substitution ? String(item.substitution) : null
    }));
    const itemSummary = items.map((item) => `${item.name}×${item.quantity}`).join("、");
    return {
      id: order.order_id || order.preview_id || "",
      orderId: order.order_id || null,
      previewId: order.preview_id || null,
      status: order.status || "planned",
      items,
      itemSummary,
      itemPreview: previewText(itemSummary, 68),
      itemKinds: items.length,
      itemCount: items.reduce((total, item) => total + item.quantity, 0),
      total: finiteNumber(order.total),
      budgetLimit: finiteNumber(order.budget_limit),
      budgetStatus: order.budget_status || null,
      deliveryWindow: order.delivery_window || "",
      errorCode: order.error_code || null
    };
  }

  function interactionView(state, now) {
    const confirmation = state.confirmation;
    const expiresAt = confirmation?.expires_at ? Date.parse(confirmation.expires_at) : null;
    const expired = Number.isFinite(expiresAt) && expiresAt <= now;
    const vehicleOwns = state.primary_surface === "vehicle_hmi" && confirmation?.owner_surface === "vehicle_hmi";
    const canConfirm = Boolean(vehicleOwns && confirmation?.status === "pending" && asArray(confirmation.action_ids).length && !expired);
    let disabledReason = null;
    if (!confirmation) disabledReason = "no_confirmation";
    else if (!vehicleOwns) disabledReason = "wrong_surface";
    else if (confirmation.status !== "pending") disabledReason = "not_pending";
    else if (expired) disabledReason = "expired";
    else if (!asArray(confirmation.action_ids).length) disabledReason = "empty_action_group";
    return {
      mode: state.primary_surface === "vehicle_hmi" ? "primary" : state.primary_surface === "none" ? "suppressed" : "read_only",
      canConfirm,
      disabledReason,
      expiresAt,
      confirmationId: confirmation?.confirmation_id || null,
      actionIds: asArray(confirmation?.action_ids)
    };
  }

  function buildVehicleHmiViewModel(state, options = {}) {
    const validation = validateEnvelope(state);
    const locale = options.locale || "zh-CN";
    const timeZone = options.timeZone || "Asia/Shanghai";
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    if (!validation.valid) {
      return {
        meta: { isCompatible: false, reason: validation.reason, sessionId: null, revision: -1 },
        lifecycle: { stage: "error", stageLabel: "数据不可用", scene: "off_vehicle", primarySurface: "none" },
        tasks: { total: 0, rigid: 0, flexible: 0, completed: 0, items: [], primary: null, navigation: null },
        navigation: { hasDestination: false, hasRouteLocation: false, destination: "等待手机同步路线", hasEta: false, etaLabel: "--:--", lateMinutes: 0 },
        risk: { level: "L0", label: "状态未知", tone: "calm", icon: "○", lateMinutes: 0, reasonCodes: [], auxiliarySignals: [] },
        interaction: { mode: "suppressed", canConfirm: false, disabledReason: validation.reason, expiresAt: null },
        actions: { items: [], counts: actionSummary([]) },
        agentOutput: { available: false, fullText: "", preview: "" },
        utterance: { available: false, text: "", sourceLabel: "等待手机语音" },
        wearable: wearableView({}), vehicle: vehicleView({}), serviceOrders: { items: [], totalAmount: 0 }
      };
    }

    const sourceTasks = sortedTasks(state);
    const taskItems = sourceTasks.map((task) => taskView(task, locale, timeZone));
    const primary = taskItems.find((task) => !task.completed) || taskItems[0] || null;
    const taskNavigation = taskItems.find((task) => !task.completed && task.location)
      || taskItems.find((task) => task.location)
      || primary;
    const route = navigationContractView(state);
    const routeTask = taskItems.find((task) => task.id === route?.taskId) || taskNavigation;
    const lateMinutes = Math.max(0, finiteNumber(state.risk?.late_minutes) || 0);
    const riskBase = RISK_VIEW[state.risk?.pressure_level] || RISK_VIEW.L0;
    const etaLabel = formatClock(state.eta, locale, timeZone);
    const actionItems = asArray(state.actions).map(actionView);
    const orderItems = asArray(state.service_orders).map(orderView);
    const output = state.output || null;
    const outputExpiresAt = output?.expires_at ? Date.parse(output.expires_at) : null;
    const outputExpired = Number.isFinite(outputExpiresAt) && outputExpiresAt <= now;
    const suppressed = asArray(output?.suppressed_surfaces).includes("vehicle_hmi");
    const ownedByVehicle = output?.owner_surface === "vehicle_hmi";
    const outputText = String(output?.conclusion || "").trim();
    const climateOnlyOutput = isClimateOnlyConclusion(outputText);
    const utterance = state.last_utterance || null;
    const utteranceText = String(utterance?.text || "").trim();
    const sourceLabel = { mobile: "手机语音", wearable: "腕上设备", demo_console: "演示控制台", agent_api: "Agent" }[utterance?.source] || "外部设备";

    return {
      meta: {
        isCompatible: true,
        reason: null,
        schemaVersion: state.schema_version,
        sessionId: state.session_id,
        revision: state.revision,
        updatedAt: state.updated_at || null
      },
      lifecycle: {
        stage: state.stage,
        stageLabel: STAGE_LABEL[state.stage] || "状态已更新",
        scene: state.scene,
        primarySurface: state.primary_surface
      },
      interaction: interactionView(state, now),
      navigation: {
        hasDestination: Boolean(route?.destination || taskNavigation),
        hasRouteLocation: Boolean(route || taskNavigation?.location),
        destination: route?.destination.name || taskNavigation?.location || taskNavigation?.title || "等待手机同步路线",
        taskTitle: routeTask?.title || "",
        hasEta: Boolean(etaLabel),
        etaIso: state.eta || null,
        etaLabel: etaLabel || "--:--",
        lateMinutes,
        route
      },
      risk: {
        level: state.risk?.pressure_level || "L0",
        label: riskBase.label,
        tone: riskBase.tone,
        icon: riskBase.icon,
        lateMinutes,
        reasonCodes: asArray(state.risk?.reason_codes),
        auxiliarySignals: asArray(state.risk?.auxiliary_signals)
      },
      tasks: {
        total: taskItems.length,
        rigid: taskItems.filter((task) => task.tone === "rigid").length,
        flexible: taskItems.filter((task) => task.tone === "flexible").length,
        completed: taskItems.filter((task) => task.completed).length,
        items: taskItems,
        primary,
        navigation: routeTask
      },
      actions: { items: actionItems, counts: actionSummary(actionItems) },
      agentOutput: {
        available: Boolean(outputText && ownedByVehicle && !suppressed && !outputExpired && !climateOnlyOutput),
        messageId: output?.message_id || null,
        fullText: outputText,
        preview: previewText(outputText, 76),
        ownerSurface: output?.owner_surface || null,
        suppressed,
        expired: outputExpired,
        requiresConfirmation: output?.requires_confirmation === true,
        climateOnly: climateOnlyOutput
      },
      utterance: {
        available: Boolean(utteranceText),
        text: utteranceText,
        preview: previewText(utteranceText, 74),
        source: utterance?.source || null,
        sourceLabel: utteranceText ? sourceLabel : "等待手机语音",
        inputMode: utterance?.input_mode || null,
        receivedAt: utterance?.received_at || null,
        receivedAtLabel: formatClock(utterance?.received_at, locale, timeZone)
      },
      wearable: wearableView(state),
      vehicle: vehicleView(state),
      serviceOrders: {
        items: orderItems,
        totalAmount: orderItems.reduce((total, order) => total + (order.total || 0), 0),
        hasFailure: orderItems.some((order) => Boolean(order.errorCode) || ["failed", "blocked"].includes(order.status))
      }
    };
  }

  return {
    SCHEMA_VERSION,
    acceptWorldState,
    buildVehicleHmiViewModel,
    formatClock,
    previewText,
    isClimateOnlyConclusion,
    sortedTasks,
    validateEnvelope
  };
});
