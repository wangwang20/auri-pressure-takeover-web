const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const model = require("../src/world-state-model.js");

const fixture = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "../../../contracts/examples/world-state.json"),
  "utf8"
));
const now = Date.parse("2026-07-15T18:29:00+08:00");

const vm = model.buildVehicleHmiViewModel(fixture, { now });
assert.equal(vm.meta.isCompatible, true);
assert.equal(vm.meta.sessionId, "demo_run_001");
assert.equal(vm.tasks.total, 2);
assert.equal(vm.tasks.rigid, 1);
assert.equal(vm.tasks.flexible, 1);
assert.equal(vm.tasks.primary.title, "接孩子");
assert.equal(vm.tasks.navigation.location, "阳光小学");
assert.equal(vm.navigation.destination, "阳光小学");
assert.equal(vm.navigation.route.id, "route_demo_task_pickup_child");
assert.deepEqual(vm.navigation.route.origin.coordinates, [120.791879, 31.33468]);
assert.deepEqual(vm.navigation.route.destination.coordinates, [120.7359, 31.3048]);
assert.equal(vm.navigation.route.progress, 0.7);
assert.equal(vm.navigation.route.source, "demo_fixture");
assert.equal(vm.navigation.route.isSimulated, true);
assert.equal(vm.navigation.etaLabel, "18:28");
assert.equal(vm.navigation.lateMinutes, 18);
assert.equal(vm.risk.level, "L2");
assert.equal(vm.actions.counts.total, 3);
assert.equal(vm.actions.counts.pending, 3);
assert.equal(vm.actions.items[0].messageBody, fixture.actions[0].message_draft.body);
assert.equal(vm.actions.items[0].messageDraft.isSimulated, true);
assert.ok(vm.actions.items[0].messagePreview.includes("预计18:28到"));
assert.equal(vm.agentOutput.available, true);
assert.ok(vm.agentOutput.fullText.length > vm.agentOutput.preview.length);
assert.equal(vm.utterance.text, "我还来得及吗？帮我处理");
assert.equal(vm.utterance.sourceLabel, "手机语音");
assert.equal(vm.wearable.connected, true);
assert.equal(vm.vehicle.acOn, false);
assert.equal(vm.vehicle.temperatureLabel, "24°C");
assert.equal(vm.interaction.canConfirm, true);
assert.equal(vm.serviceOrders.items[0].itemKinds, 8);
assert.equal(vm.serviceOrders.items[0].itemCount, 9);
assert.equal(vm.serviceOrders.items[0].items[0].name, "牛奶");
assert.equal(vm.serviceOrders.items[0].items[0].quantity, 2);
assert.ok(vm.serviceOrders.items[0].itemSummary.includes("鸡蛋×1"));
assert.equal(vm.serviceOrders.totalAmount, 186);

// Structured action/order fields are the HMI contract. A stale natural-language
// summary must not replace a message draft or the structured purchase items.
const fieldSourceVm = model.buildVehicleHmiViewModel({
  ...fixture,
  revision: 41,
  actions: [
    {
      ...fixture.actions[0],
      action_id: "message-structured-source",
      target: "真实联系人",
      summary: "错误摘要：这个文本不能作为消息正文显示",
      message_draft: { body: "只来自 message_draft.body 的正文", channel: "demo", is_simulated: true }
    },
    {
      ...fixture.actions[2],
      action_id: "order-structured-source",
      summary: "错误摘要：这个文本不能作为采购清单显示",
      details_ref: "preview-structured-source"
    }
  ],
  service_orders: [{
    ...fixture.service_orders[0],
    preview_id: "preview-structured-source",
    items: [
      { sku: "structured-milk", name: "结构化牛奶", quantity: 7, unit_price: 11, subtotal: 77, substitution: null },
      { sku: "structured-eggs", name: "结构化鸡蛋", quantity: 4, unit_price: 6, subtotal: 24, substitution: null }
    ],
    total: 101,
    delivery_window: "21:10-21:30"
  }]
}, { now });
assert.equal(fieldSourceVm.actions.items[0].messageBody, "只来自 message_draft.body 的正文");
assert.doesNotMatch(fieldSourceVm.actions.items[0].messageBody, /错误摘要/);
assert.deepEqual(
  fieldSourceVm.serviceOrders.items[0].items.map((item) => [item.name, item.quantity]),
  [["结构化牛奶", 7], ["结构化鸡蛋", 4]]
);
assert.equal(fieldSourceVm.serviceOrders.items[0].itemSummary, "结构化牛奶×7、结构化鸡蛋×4");

// The shell must receive every action verbatim: varying targets and unknown types
// are rendered dynamically rather than being reduced to the demo's three actions.
for (const count of [0, 1, 2, 5]) {
  const actions = Array.from({ length: count }, (_, index) => ({
    action_id: `dynamic-${index}`,
    type: ["message", "service_order", "calendar_adjustment", "unknown_provider", "message"][index],
    target: ["王老师", "社区配送", "工作日程", "外部服务", "爷爷"][index],
    status: ["awaiting_confirmation", "completed", "failed", "blocked", "planned"][index],
    summary: `动态动作 ${index} 的完整详情`,
    details_ref: index === 1 ? fixture.service_orders[0].preview_id : null,
    requires_confirmation: index === 0
  }));
  const dynamicVm = model.buildVehicleHmiViewModel({ ...fixture, revision: 40 + count, actions }, { now });
  assert.equal(dynamicVm.actions.items.length, count);
  assert.deepEqual(dynamicVm.actions.items.map((action) => action.id), actions.map((action) => action.action_id));
  if (count === 5) {
    assert.equal(dynamicVm.actions.items[3].type, "unknown_provider");
    assert.equal(dynamicVm.actions.items[4].target, "爷爷");
    assert.equal(dynamicVm.actions.items[2].status, "failed");
  }
}

// Unknown action kinds remain first-class list items regardless of how many the
// Agent returns; the shell must not silently cap or discard them.
const unknownActions = Array.from({ length: 7 }, (_, index) => ({
  action_id: `unknown-action-${index + 1}`,
  type: `provider_extension_${index + 1}`,
  target: `未知目标 ${index + 1}`,
  status: "awaiting_confirmation",
  summary: `未知动作 ${index + 1} 的完整详情`,
  details_ref: null,
  requires_confirmation: true
}));
const unknownVm = model.buildVehicleHmiViewModel({ ...fixture, revision: 49, actions: unknownActions }, { now });
assert.equal(unknownVm.actions.counts.total, unknownActions.length);
assert.deepEqual(unknownVm.actions.items.map((action) => action.id), unknownActions.map((action) => action.action_id));
assert.deepEqual(unknownVm.actions.items.map((action) => action.type), unknownActions.map((action) => action.type));

const legacyMessageVm = model.buildVehicleHmiViewModel({
  ...fixture,
  revision: 18,
  actions: fixture.actions.map((action) => {
    const { message_draft, ...legacyAction } = action;
    return legacyAction;
  })
}, { now });
assert.ok(legacyMessageVm.actions.items[0].messageBody.startsWith("您好，我正在前往"));
assert.ok(!legacyMessageVm.actions.items[0].messageBody.startsWith("给王老师的消息草稿"));

const climateOutput = model.buildVehicleHmiViewModel({
  ...fixture,
  revision: 12,
  output: { ...fixture.output, conclusion: "空调已开启，设到 21°C，自动模式，中风量。" }
}, { now });
assert.equal(climateOutput.agentOutput.available, false);
assert.equal(climateOutput.agentOutput.climateOnly, true);

const emptyState = {
  ...fixture,
  revision: 8,
  stage: "off_vehicle_idle",
  scene: "off_vehicle",
  primary_surface: "mobile",
  tasks: [],
  eta: null,
  actions: [],
  confirmation: null,
  output: null,
  last_utterance: null,
  service_orders: [],
  navigation: null,
  vehicle_state: { ac_on: false, ac_target_temp: 24, ac_mode: "auto", fan_speed: "medium" }
};
const emptyVm = model.buildVehicleHmiViewModel(emptyState, { now });
assert.equal(emptyVm.tasks.total, 0);
assert.equal(emptyVm.navigation.hasDestination, false);
assert.equal(emptyVm.navigation.etaLabel, "--:--");
assert.equal(emptyVm.navigation.route, null);
assert.equal(emptyVm.vehicle.available, true);
assert.equal(emptyVm.vehicle.temperatureLabel, "24°C");
assert.equal(emptyVm.interaction.canConfirm, false);

const mixedState = {
  ...fixture,
  revision: 9,
  navigation: null,
  tasks: [
    { ...fixture.tasks[0], task_id: "completed", title: "已完成旧任务", status: "completed", location: "旧地点" },
    { ...fixture.tasks[1], task_id: "flex", title: "提交周报", status: "pending", location: null },
    { ...fixture.tasks[0], task_id: "active", title: "机场接人", status: "pending", location: "苏南硕放机场" }
  ],
  actions: [
    { ...fixture.actions[0], status: "completed" },
    { ...fixture.actions[1], status: "blocked" },
    { ...fixture.actions[2], status: "failed" }
  ]
};
const mixedVm = model.buildVehicleHmiViewModel(mixedState, { now });
assert.equal(mixedVm.tasks.total, 3);
assert.equal(mixedVm.tasks.navigation.title, "机场接人");
assert.equal(mixedVm.actions.counts.completed, 1);
assert.equal(mixedVm.actions.counts.blocked, 1);
assert.equal(mixedVm.actions.counts.failed, 1);

const locationFallbackVm = model.buildVehicleHmiViewModel({
  ...fixture,
  revision: 10,
  navigation: null,
  tasks: [
    { ...fixture.tasks[0], task_id: "report", title: "提交报告", task_type: "rigid", priority: "high", location: null },
    { ...fixture.tasks[1], task_id: "pickup", title: "机场接人", task_type: "flexible", priority: "medium", location: "苏南硕放机场" }
  ]
}, { now });
assert.equal(locationFallbackVm.tasks.primary.title, "提交报告");
assert.equal(locationFallbackVm.tasks.navigation.title, "机场接人");
assert.equal(locationFallbackVm.navigation.destination, "苏南硕放机场");
assert.equal(locationFallbackVm.navigation.route, null);

const legacyLocationFallbackVm = model.buildVehicleHmiViewModel({
  ...fixture,
  revision: 15,
  navigation: null,
  tasks: [
    { ...fixture.tasks[0], task_id: "legacy", title: "机场接人", location: "苏南硕放机场" }
  ]
}, { now });
assert.equal(legacyLocationFallbackVm.navigation.route, null);
assert.equal(legacyLocationFallbackVm.navigation.destination, "苏南硕放机场");

const invalidContractVm = model.buildVehicleHmiViewModel({
  ...fixture,
  revision: 16,
  navigation: { ...fixture.navigation, task_id: "missing-task", progress: null }
}, { now });
assert.equal(invalidContractVm.navigation.route, null);
assert.equal(invalidContractVm.navigation.destination, "阳光小学");

const nullProgressVm = model.buildVehicleHmiViewModel({
  ...fixture,
  revision: 17,
  navigation: { ...fixture.navigation, progress: null }
}, { now });
assert.equal(nullProgressVm.navigation.route.progress, null);

const failedServiceVm = model.buildVehicleHmiViewModel({
  ...fixture,
  revision: 11,
  service_orders: [{ ...fixture.service_orders[0], status: "failed", error_code: "PROVIDER_UNAVAILABLE" }]
}, { now });
assert.equal(failedServiceVm.serviceOrders.hasFailure, true);

const suppressed = model.buildVehicleHmiViewModel({
  ...fixture,
  revision: 10,
  output: { ...fixture.output, suppressed_surfaces: ["vehicle_hmi"] }
}, { now });
assert.equal(suppressed.agentOutput.available, false);

const expired = model.buildVehicleHmiViewModel({
  ...fixture,
  revision: 11,
  confirmation: { ...fixture.confirmation, expires_at: "2026-07-15T18:20:00+08:00" }
}, { now });
assert.equal(expired.interaction.canConfirm, false);
assert.equal(expired.interaction.disabledReason, "expired");

const wrongSurface = model.buildVehicleHmiViewModel({
  ...fixture,
  revision: 12,
  primary_surface: "mobile",
  confirmation: { ...fixture.confirmation, owner_surface: "mobile" }
}, { now });
assert.equal(wrongSurface.interaction.canConfirm, false);
assert.equal(wrongSurface.interaction.disabledReason, "wrong_surface");

const mobileOwnedOutput = model.buildVehicleHmiViewModel({
  ...fixture,
  revision: 13,
  output: { ...fixture.output, owner_surface: "mobile", suppressed_surfaces: [] }
}, { now });
assert.equal(mobileOwnedOutput.agentOutput.available, false);

const missingRequired = model.buildVehicleHmiViewModel({ ...fixture, revision: 14, tasks: undefined }, { now });
assert.equal(missingRequired.meta.isCompatible, false);
assert.equal(missingRequired.meta.reason, "invalid_tasks");

assert.deepEqual(
  model.acceptWorldState({ sessionId: "s1", revision: 2, retiredSessionIds: [] }, { ...fixture, session_id: "s1", revision: 3 }),
  { accepted: true, resetRequired: false, reason: "new_revision" }
);
assert.equal(model.acceptWorldState({ sessionId: "s1", revision: 3, retiredSessionIds: [] }, { ...fixture, session_id: "s1", revision: 3 }).reason, "stale_revision");
assert.equal(model.acceptWorldState({ sessionId: "s1", revision: 9, retiredSessionIds: [] }, { ...fixture, session_id: "s2", revision: 1 }).resetRequired, true);
assert.equal(model.acceptWorldState({ sessionId: "s2", revision: 1, retiredSessionIds: ["s1"] }, { ...fixture, session_id: "s1", revision: 99 }).reason, "retired_session");

const incompatible = model.buildVehicleHmiViewModel({ ...fixture, schema_version: "9.9.9" }, { now });
assert.equal(incompatible.meta.isCompatible, false);
assert.equal(incompatible.interaction.canConfirm, false);

console.log("vehicle-hmi world-state-model tests passed");
