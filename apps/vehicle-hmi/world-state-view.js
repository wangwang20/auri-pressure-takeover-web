(function initAuriWorldStateView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AuriWorldStateView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createAuriWorldStateView() {
  const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
  const TASK_STATUS = {
    pending: "待处理",
    rescheduled: "已调整",
    completed: "已完成"
  };
  const ACTION_STATUS = {
    planned: "已规划",
    ready: "已准备",
    awaiting_confirmation: "待确认",
    completed: "已完成",
    blocked: "已阻断",
    failed: "失败"
  };

  function tasks(state) {
    return Array.isArray(state?.tasks) ? state.tasks.filter(Boolean) : [];
  }

  function actions(state) {
    return Array.isArray(state?.actions) ? state.actions.filter(Boolean) : [];
  }

  function taskRank(task) {
    const completedPenalty = task.status === "completed" ? 100 : 0;
    const typeRank = task.task_type === "rigid" ? 0 : 20;
    return completedPenalty + typeRank + (PRIORITY_RANK[task.priority] ?? 1);
  }

  function sortedTasks(state) {
    return [...tasks(state)].sort((left, right) => {
      const rankDifference = taskRank(left) - taskRank(right);
      if (rankDifference) return rankDifference;
      const leftTime = Date.parse(left.scheduled_at || "") || Number.MAX_SAFE_INTEGER;
      const rightTime = Date.parse(right.scheduled_at || "") || Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime;
    });
  }

  function primaryTask(state) {
    return sortedTasks(state)[0] || null;
  }

  function navigationTask(state) {
    return sortedTasks(state).find((task) => task.location) || primaryTask(state);
  }

  function formatClock(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  function taskTypeLabel(task) {
    return task?.task_type === "rigid" ? "刚性任务" : "弹性任务";
  }

  function taskStatusLabel(task) {
    if (!task) return "等待同步";
    if (task.status === "completed") return TASK_STATUS.completed;
    if (task.status === "rescheduled") return TASK_STATUS.rescheduled;
    if (task.task_type === "rigid" && !task.adjustable) return "不可后置";
    if (task.adjustable) return "可调整";
    return TASK_STATUS[task.status] || "待处理";
  }

  function taskTitle(task, includeTime = true) {
    if (!task) return "等待手机创建任务";
    const time = formatClock(task.scheduled_at);
    return includeTime && time ? `${time} ${task.title}` : task.title;
  }

  function taskMeta(task) {
    if (!task) return "等待同步";
    const fields = [];
    if (task.location) fields.push(task.location);
    if (!task.location && formatClock(task.scheduled_at)) fields.push(formatClock(task.scheduled_at));
    if (task.waiting_party?.length) fields.push(task.waiting_party.join("、"));
    return fields.join(" · ") || (task.priority === "high" ? "高优先级" : "已同步");
  }

  function taskDetail(task, risk) {
    if (task.status === "completed") return "该任务已完成并同步到各端。";
    if (task.status === "rescheduled") return "Agent 已根据当前状态调整该任务。";
    if (task.task_type === "rigid" && Number(risk?.late_minutes || 0) > 0) {
      return `当前预计晚到 ${risk.late_minutes} 分钟，保持最高处理优先级。`;
    }
    if (task.task_type === "rigid") return "持续监测 ETA 和可用出发时间。";
    return task.adjustable ? "发生冲突时可由 Agent 提出调整方案。" : "当前按原计划执行。";
  }

  function taskView(task, risk) {
    return {
      id: task.task_id,
      type: taskTypeLabel(task),
      title: taskTitle(task),
      shortTitle: taskTitle(task, false),
      status: taskStatusLabel(task),
      meta: taskMeta(task),
      detail: taskDetail(task, risk),
      tone: task.task_type === "rigid" ? "rigid" : "flexible",
      icon: task.task_type === "rigid" ? "刚" : "弹"
    };
  }

  function taskCounts(state) {
    const list = tasks(state);
    return {
      total: list.length,
      rigid: list.filter((task) => task.task_type === "rigid").length,
      flexible: list.filter((task) => task.task_type === "flexible").length,
      completed: list.filter((task) => task.status === "completed").length,
      rescheduled: list.filter((task) => task.status === "rescheduled").length
    };
  }

  function actionStatusLabel(status) {
    return ACTION_STATUS[status] || status || "等待";
  }

  function actionProgress(state) {
    const list = actions(state);
    const completed = list.filter((action) => action.status === "completed").length;
    const pending = list.filter((action) => ["planned", "ready", "awaiting_confirmation"].includes(action.status)).length;
    return {
      total: list.length,
      completed,
      pending,
      percent: list.length ? Math.round((completed / list.length) * 100) : 0
    };
  }

  function actionText(action) {
    const type = {
      message: `${action.target || "联系人"}消息`,
      service_order: action.target || "服务订单",
      reschedule: action.target || "任务调整"
    }[action.type] || action.summary || "Agent 动作";
    return `${type} · ${actionStatusLabel(action.status)}`;
  }

  function climate(state) {
    const vehicle = state?.vehicle_state;
    if (!vehicle || typeof vehicle !== "object") {
      return {
        available: false,
        on: false,
        temperature: "--",
        mode: "等待同步",
        fan: "等待同步",
        summary: "座舱状态等待 Agent 同步"
      };
    }
    const temperature = Number(vehicle.ac_target_temp);
    const mode = { auto: "自动", cool: "制冷", heat: "制热", fan: "送风" }[vehicle.ac_mode] || "自动";
    const fan = { low: "低", medium: "中", high: "高" }[vehicle.fan_speed] || "中";
    const displayTemperature = Number.isFinite(temperature) ? temperature.toFixed(1) : "24.0";
    return {
      available: true,
      on: vehicle.ac_on === true,
      temperature: displayTemperature,
      mode,
      fan,
      summary: `AC ${vehicle.ac_on === true ? "开启" : "关闭"} · ${displayTemperature}° · ${mode} · 风量${fan}`
    };
  }

  function isClimateConclusion(value) {
    const text = String(value || "");
    if (!text) return false;
    return /(空调|AC|温度|制冷|制热|送风|风量|座舱温控)/i.test(text);
  }

  function driverConclusion(state, fallback) {
    const risk = state?.risk || { late_minutes: 0 };
    const order = state?.service_orders?.[0];
    if (order?.error_code) return "服务暂不可用，其他可执行方案已保留。";
    if (Number(risk.late_minutes || 0) > 0 && state?.confirmation?.status === "pending") {
      return "继续加速无法明显缩短时间。方案已准备，确认后执行。";
    }
    const output = String(state?.output?.conclusion || "").trim();
    if (!output || isClimateConclusion(output)) return fallback;
    const drivingOutput = /(晚到|到达|ETA|路线|驾驶|拥堵|出发|确认|消息|订单|方案已|动作已|已处理)/i.test(output);
    const takeoverStage = [
      "takeover_L2",
      "takeover_L3",
      "planning",
      "service_prepared",
      "waiting_confirmation",
      "executing",
      "service_executed",
      "action_completed",
      "cooldown",
      "parked_review"
    ].includes(state?.stage);
    if (!drivingOutput && !takeoverStage) return fallback;
    return output.length <= 64 ? output : fallback;
  }

  function planSummary(state) {
    const list = actions(state);
    if (!list.length) return "Agent 尚未生成处理动作。";
    const progress = actionProgress(state);
    const summaries = list
      .map((action) => action.summary || actionText(action))
      .filter(Boolean)
      .slice(0, 3);
    const prefix = progress.completed === progress.total
      ? `${progress.completed} 项动作已完成`
      : `${progress.completed}/${progress.total} 项动作已完成`;
    return `${prefix}。${summaries.join("；")}`;
  }

  function utterance(state) {
    const item = state?.last_utterance;
    const text = String(item?.text || "").trim();
    if (!text) {
      return { available: false, text: "", source: null, inputMode: null, sourceLabel: "等待手机语音" };
    }
    const sourceLabel = {
      mobile: "手机",
      vehicle_hmi: "车机",
      wearable: "腕上设备",
      demo_console: "演示控制台",
      agent_api: "Agent"
    }[item.source] || "外部设备";
    return {
      available: true,
      text,
      source: item.source,
      inputMode: item.input_mode || "voice",
      sourceLabel
    };
  }

  return {
    actions,
    actionProgress,
    actionStatusLabel,
    actionText,
    climate,
    driverConclusion,
    formatClock,
    isClimateConclusion,
    navigationTask,
    planSummary,
    primaryTask,
    sortedTasks,
    taskCounts,
    taskStatusLabel,
    taskTitle,
    taskView,
    tasks,
    utterance
  };
});
