const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../auri-shell.js"), "utf8");
const sandbox = { window: {}, console: { error() {} } };
vm.runInNewContext(source, sandbox, { filename: "auri-shell.js" });
const briefing = sandbox.window.AuriHmiSpeechBriefing;

assert.ok(briefing, "speech briefing helpers should be exported before HMI bootstrap");
assert.equal(briefing.selectChineseVoice([{ lang: "en-US", name: "English" }]), null);
assert.equal(briefing.selectChineseVoice([{ lang: "en-US", name: "Mandarin Chinese" }]).name, "Mandarin Chinese");
assert.equal(briefing.selectChineseVoice([{ lang: "zh-CN", name: "System Voice" }]).lang, "zh-CN");

function state(overrides = {}) {
  return {
    session_id: "speech-demo",
    revision: 8,
    stage: "service_prepared",
    primary_surface: "vehicle_hmi",
    output: { conclusion: "预计晚到 12 分钟，处理方案已经整理完成。" },
    risk: { late_minutes: 12 },
    actions: [],
    confirmation: {
      confirmation_id: "confirm-8",
      status: "pending",
      owner_surface: "vehicle_hmi",
      action_ids: []
    },
    service_orders: [],
    ...overrides
  };
}

const noActions = briefing.build(state());
assert.match(noActions, /当前预计晚到12分钟/);
assert.match(noActions, /请说确认，或在车机确认/);
assert.doesNotMatch(noActions, /王老师|孩子妈妈|超市|接孩子/);

const oneAction = briefing.build(state({
  actions: [{ action_id: "message-1", type: "message", target: "陈老师", status: "awaiting_confirmation", summary: "消息草稿已生成" }]
}));
assert.match(oneAction, /1条消息已准备/);
assert.doesNotMatch(oneAction, /生活服务/);

const threeActionsState = state({
  revision: 9,
  stage: "waiting_confirmation",
  actions: [
    { action_id: "message-1", type: "message", target: "陈老师", status: "awaiting_confirmation", summary: "通知到校时间" },
    { action_id: "message-2", type: "message", target: "家人甲", status: "awaiting_confirmation", summary: "同步行程变化" },
    { action_id: "service-1", type: "service_order", target: "社区配送", status: "awaiting_confirmation", summary: "配送预览" }
  ],
  service_orders: [{
    preview_id: "order-1",
    status: "awaiting_confirmation",
    total: 238,
    delivery_window: "19:10-19:40",
    items: [{ sku: "a", quantity: 2 }, { sku: "b", quantity: 3 }]
  }]
});
const threeActions = briefing.build(threeActionsState);
assert.match(threeActions, /2条消息和1项配送方案已准备/);
assert.match(threeActions, /请说确认，或在车机确认/);
assert.equal(briefing.build(state({ stage: "planning" })), "");
assert.equal(briefing.build(state({ primary_surface: "mobile" })), "");
assert.equal(briefing.build(state({ confirmation: { ...state().confirmation, owner_surface: "mobile" } })), "");
assert.equal(briefing.build(state({ confirmation: { ...state().confirmation, status: "expired" } })), "");

const mixedAvailability = briefing.build(state({
  actions: [
    { action_id: "message-ok", type: "message", target: "联系人甲", status: "awaiting_confirmation" },
    { action_id: "service-blocked", type: "service_order", target: "配送", status: "blocked" }
  ]
}));
assert.match(mixedAvailability, /1条消息已准备/);
assert.doesNotMatch(mixedAvailability, /配送方案已准备/);

const changedPlan = {
  ...threeActionsState,
  actions: threeActionsState.actions.map((action) => action.action_id === "message-2" ? { ...action, target: "监护人乙" } : action),
  service_orders: [{ ...threeActionsState.service_orders[0], total: 312, delivery_window: "20:00-20:30" }]
};
assert.match(briefing.build(changedPlan), /2条消息和1项配送方案已准备/);
assert.equal(briefing.keyFor(threeActionsState), briefing.keyFor({ ...threeActionsState }));
assert.equal(
  briefing.keyFor(threeActionsState),
  briefing.keyFor({ ...threeActionsState, revision: 10 }),
  "unrelated World State revisions must not replay an unchanged plan"
);
assert.notEqual(briefing.keyFor(threeActionsState), briefing.keyFor(changedPlan));

const completion = briefing.buildCompletion({
  ...changedPlan,
  stage: "action_completed",
  risk: { late_minutes: 9 },
  output: { conclusion: "预计晚到 9 分钟，方案已执行并同步。" },
  actions: changedPlan.actions.map((action) => ({ ...action, status: "completed" })),
  service_orders: [{ ...changedPlan.service_orders[0], status: "submitted" }]
});
assert.match(completion, /当前预计晚到9分钟/);
assert.match(completion, /2条消息和1项配送方案已完成/);
assert.doesNotMatch(completion, /王老师|孩子妈妈|超市|接孩子/);
assert.equal(briefing.buildCompletion({ ...changedPlan, stage: "action_completed", primary_surface: "mobile" }), "");

const rejected = briefing.buildCompletion({
  ...changedPlan,
  stage: "action_completed",
  confirmation: { ...changedPlan.confirmation, status: "rejected" },
  actions: changedPlan.actions.map((action) => ({ ...action, status: "blocked" })),
  service_orders: changedPlan.service_orders.map((order) => ({ ...order, status: "failed" }))
});
assert.equal(rejected, "AURI 已取消本次处理方案。消息和服务均未执行。请继续安全驾驶。");
assert.doesNotMatch(rejected, /已完成|配送方案已完成/);

const failedCompletion = briefing.buildCompletion({
  ...changedPlan,
  stage: "action_completed",
  actions: changedPlan.actions.map((action) => ({ ...action, status: "failed" })),
  service_orders: changedPlan.service_orders.map((order) => ({ ...order, status: "failed" }))
});
assert.match(failedCompletion, /本次没有执行任何动作/);
assert.doesNotMatch(failedCompletion, /消息已完成|配送方案已完成/);

const multipleServices = briefing.build(state({
  actions: [
    { action_id: "service-1", type: "service_order", status: "awaiting_confirmation" },
    { action_id: "service-2", type: "service_order", status: "awaiting_confirmation" }
  ]
}));
assert.match(multipleServices, /2项配送方案已准备/);

const completionState = {
  ...changedPlan,
  stage: "action_completed",
  actions: changedPlan.actions.map((action) => ({ ...action, status: "completed" })),
  service_orders: [{ ...changedPlan.service_orders[0], status: "submitted" }]
};
assert.equal(
  briefing.completionKeyFor(completionState),
  briefing.completionKeyFor({ ...completionState, revision: 99, output: { message_id: "changed-only-message-id" } }),
  "completion speech must not replay for revision or message-id-only changes"
);
assert.notEqual(
  briefing.completionKeyFor(completionState),
  briefing.completionKeyFor({
    ...completionState,
    actions: completionState.actions.map((action, index) => index ? action : { ...action, status: "failed" })
  })
);

const helperSource = source.slice(source.indexOf("const speechBriefing"), source.indexOf("// Exposed as pure helpers"));
assert.doesNotMatch(helperSource, /王老师|孩子妈妈|超市|接孩子/);

console.log("speech-briefing.test.cjs passed");
