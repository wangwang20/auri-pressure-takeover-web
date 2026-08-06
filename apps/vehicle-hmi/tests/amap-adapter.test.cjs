const assert = require("node:assert/strict");

const calls = [];
const storageValues = new Map();
let routePlanCount = 0;
let poiSearchCount = 0;
let deferPoiSearch = false;
const pendingPoiSearches = [];
let drivingResultMode = "complete";
let deferMoveEnd = false;

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.hidden = false;
    this.innerHTML = "";
    this.textContent = "";
    this.clientWidth = 1000;
    this.clientHeight = 700;
    this.style = {
      values: new Map(),
      setProperty: (name, value) => {
        this.style.values.set(name, value);
        calls.push(["style", name, value]);
      },
      getPropertyValue: (name) => this.style.values.get(name) || ""
    };
  }

  append(...children) {
    this.children.push(...children);
  }

  querySelector(selector) {
    if (selector === "span") return this.children.find((child) => child.tagName === "SPAN") || null;
    return null;
  }
}

class FakeMap {
  constructor(_container, options) {
    this.options = options;
    this.features = [...options.features];
    this.status = { showLabel: options.showLabel };
    this.labelRejectMask = options.labelRejectMask;
    this.added = [];
    this.removed = [];
    this.rotation = Number(options.rotation || 0);
    this.pitch = Number(options.pitch || 0);
    this.pixelOffset = [0, 0];
  }

  add(value) {
    this.added.push(value);
    calls.push(["add", value]);
  }

  remove(value) {
    this.removed.push(...value);
  }

  setFitView(overlays, immediately, avoid, maxZoom) {
    calls.push(["fit", overlays, immediately, avoid, maxZoom]);
  }

  setZoomAndCenter(zoom, center) {
    this.pixelOffset = [0, 0];
    calls.push(["zoom-center", zoom, center]);
  }

  setCenter(center) {
    this.pixelOffset = [0, 0];
    calls.push(["center", center]);
  }

  lngLatToContainer() {
    const [dx, dy] = this.pixelOffset;
    return { x: 500 + dx, y: 350 + dy };
  }

  panBy(dx, dy) {
    this.pixelOffset[0] += dx;
    this.pixelOffset[1] += dy;
    calls.push(["pan", dx, dy]);
  }

  setPitch(pitch) {
    this.pitch = pitch;
    calls.push(["pitch", pitch]);
  }

  getPitch() {
    return this.pitch;
  }

  setRotation(rotation) {
    this.rotation = rotation;
    calls.push(["rotation", rotation]);
  }

  getRotation() {
    return this.rotation;
  }

  zoomIn() {
    calls.push(["zoom-in"]);
  }

  zoomOut() {
    calls.push(["zoom-out"]);
  }

  resize() {
    calls.push(["resize"]);
  }

  setFeatures(features) {
    this.features = [...features];
    calls.push(["features", ...features]);
  }

  getFeatures() {
    return [...this.features];
  }

  setLabelRejectMask(value) {
    this.labelRejectMask = value;
    calls.push(["label-reject-mask", value]);
  }

  setStatus(status) {
    Object.assign(this.status, status);
    calls.push(["status", status]);
  }

  getStatus() {
    return { ...this.status };
  }
}

class FakeTrafficLayer {
  constructor(options) {
    this.options = options;
  }

  setOpacity(value) {
    this.opacity = value;
    calls.push(["traffic-opacity", value]);
  }
}

class FakePolyline {
  constructor(options) {
    this.options = { ...options };
    this.path = options.path;
  }

  setPath(path) {
    this.path = path;
    calls.push(["polyline-path", path.length]);
  }

  setOptions(options) {
    Object.assign(this.options, options);
  }
}

class FakeMarker {
  constructor(options) {
    this.options = options;
    this.position = options.position;
    this.visible = true;
    this.listeners = new Map();
  }

  on(event, handler) {
    this.listeners.set(event, handler);
  }

  setPosition(position) {
    this.position = position;
  }

  getPosition() {
    return this.position;
  }

  moveTo(position) {
    this.position = position;
    calls.push(["move-to", position]);
  }

  moveAlong(path) {
    path.forEach((item) => {
      this.position = item?.position || item;
      this.listeners.get("moving")?.({ target: this, pos: this.position });
    });
    if (!deferMoveEnd) this.listeners.get("moveend")?.({ target: this });
    calls.push(["move-along", path.length, path.reduce((sum, item) => sum + Number(item?.duration || 0), 0)]);
  }

  stopMove() {
    calls.push(["stop-move"]);
  }

  setAngle(angle) {
    this.angle = angle;
  }

  show() {
    this.visible = true;
  }

  hide() {
    this.visible = false;
  }
}

const successfulRoute = {
  distance: 4000,
  time: 900,
  steps: [{
    instruction: "左转进入星龙街",
    road: "星龙街",
    distance: 1000,
    path: [
      [120.791879, 31.33468],
      [120.786, 31.331]
    ]
  }, {
    instruction: "沿现代大道行驶 1000 米后右转",
    road: "现代大道",
    distance: 1000,
    tmcs: [{ status: "缓行", path: [[120.786, 31.331], [120.775, 31.325]] }],
    path: [
      [120.786, 31.331],
      [120.775, 31.325]
    ]
  }, {
    instruction: "沿星湖街行驶2公里到达目的地",
    road: "星湖街",
    distance: 2000,
    path: [
      [120.775, 31.325],
      [120.7359, 31.3048]
    ]
  }]
};

class FakeDriving {
  search(_start, _end, callback) {
    routePlanCount += 1;
    if (drivingResultMode === "hang") return;
    if (drivingResultMode === "failure") {
      callback("error", { info: "route unavailable" });
      return;
    }
    callback("complete", { routes: [successfulRoute] });
  }
}

class FakePlaceSearch {
  searchNearBy(_keywords, _center, _radius, callback) {
    poiSearchCount += 1;
    const result = {
      poiList: {
        pois: [
          { name: "博世苏州", location: [120.7918, 31.3346] },
          { name: "现代大厦", location: [120.789, 31.333] },
          { name: "星龙街产业园", location: [120.787, 31.331] }
        ]
      }
    };
    if (deferPoiSearch) pendingPoiSearches.push(() => callback("complete", result));
    else callback("complete", result);
  }
}

global.document = {
  createElement(tagName) {
    return new FakeElement(tagName);
  },
  head: {
    appendChild() {}
  }
};

global.localStorage = {
  getItem(key) {
    return storageValues.has(key) ? storageValues.get(key) : null;
  },
  setItem(key, value) {
    storageValues.set(key, value);
  },
  clear() {
    storageValues.clear();
  }
};

const fakeAMap = {
  Map: FakeMap,
  TileLayer: { Traffic: FakeTrafficLayer },
  Driving: FakeDriving,
  PlaceSearch: FakePlaceSearch,
  DrivingPolicy: { LEAST_TIME: 0 },
  Polyline: FakePolyline,
  Marker: FakeMarker,
  Browser: { isWebGL: () => true }
};
global.AMap = fakeAMap;

const amap = require("../src/amap-adapter.js");

assert.deepEqual(amap.followCameraSpec({ nextDistanceMeters: 1200 }, false), {
  lookAheadMeters: 245,
  zoom: 15.8,
  pitch: 28,
  anchorY: 0.72,
  rotationThreshold: 4
});
assert.equal(amap.followCameraSpec({ nextDistanceMeters: 500 }, false).zoom, 16.0);
assert.equal(amap.followCameraSpec({ nextDistanceMeters: 120 }, false).zoom, 16.2);
assert.deepEqual(amap.followCameraSpec({ nextDistanceMeters: 200 }, true), {
  lookAheadMeters: 154,
  zoom: 15.95,
  pitch: 24,
  anchorY: 0.72,
  rotationThreshold: 4
});

function createAdapter(options = {}) {
  const container = new FakeElement();
  container.hidden = true;
  const mapWrap = new FakeElement();
  mapWrap.classList = new FakeClassList();
  const statuses = [];
  const routeMetas = [];
  const adapter = amap.create({
    container,
    mapWrap,
    onStatus(status) {
      statuses.push(status);
    },
    onRouteMeta(meta) {
      routeMetas.push(meta);
    },
    ...options
  });
  return { adapter, container, mapWrap, statuses, routeMetas };
}

function resetRuntime() {
  calls.length = 0;
  routePlanCount = 0;
  poiSearchCount = 0;
  deferPoiSearch = false;
  pendingPoiSearches.length = 0;
  drivingResultMode = "complete";
  deferMoveEnd = false;
  global.localStorage.clear();
}

function assertClose(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);
}

function currentLocalMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

async function settleWithin(promise, timeoutMs = 200) {
  const startedAt = Date.now();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const outcome = await Promise.race([
    promise.then((value) => ({ timedOut: false, value })),
    timeout
  ]);
  clearTimeout(timer);
  return { ...outcome, elapsedMs: Date.now() - startedAt };
}

async function main() {
  assert.equal(amap.MAX_FAILURE_FALLBACK_MS, 1800);
  assert.equal(amap.boundedTimeoutMs(), 1800);
  assert.equal(amap.boundedTimeoutMs(10000), 1800, "external config cannot exceed the 2-second fallback budget");
  assert.equal(amap.boundedTimeoutMs(20), 20);
  assert.equal(amap.DEFAULT_SCRIPT_LOAD_TIMEOUT_MS, 12000);
  assert.equal(amap.MAX_SCRIPT_LOAD_TIMEOUT_MS, 15000);
  assert.equal(amap.boundedScriptLoadTimeoutMs(), 12000);
  assert.equal(amap.boundedScriptLoadTimeoutMs(30000), 15000);
  assert.equal(amap.boundedScriptLoadTimeoutMs(100), 100);
  assert.equal(amap.DEFAULT_ROUTE_TIMEOUT_MS, 8000);
  assert.equal(amap.MAX_ROUTE_TIMEOUT_MS, 12000);
  assert.equal(amap.boundedRouteTimeoutMs(), 8000);
  assert.equal(amap.boundedRouteTimeoutMs(30000), 12000);
  assert.equal(amap.boundedRouteTimeoutMs(20), 20);
  assertClose(amap.bearing([120, 31], [120, 31.01]), 0);
  assertClose(amap.bearing([120, 31], [120.01, 31]), 90);
  assertClose(amap.screenHeading(-90, 90), 0);
  assertClose(amap.screenHeading(90, 0), 90);
  assert.equal(amap.trafficColor("畅通"), "#2e9d6f");
  assert.equal(amap.trafficColor("缓行"), "#e6a700");
  assert.equal(amap.trafficColor("拥堵"), "#d1495b");
  assert.equal(amap.trafficColor("严重拥堵"), "#8f2032");
  assert.deepEqual(amap.flattenTrafficSegments(successfulRoute), [{
    path: [[120.786, 31.331], [120.775, 31.325]],
    status: "缓行",
    color: "#e6a700"
  }]);

  const flattened = amap.flattenDrivingPath({
    steps: [
      { path: [[0, 0], [0.001, 0], [0.001, 0]] },
      { path: [{ lng: 0.001, lat: 0 }, { lng: 0.004, lat: 0 }, ["bad", 1]] }
    ]
  });
  assert.deepEqual(flattened, [[0, 0], [0.001, 0], [0.004, 0]]);

  const geometry = amap.buildRouteGeometry(flattened);
  assert.equal(geometry.cumulative.length, 3);
  assert.ok(geometry.totalDistance > 440 && geometry.totalDistance < 450);
  const halfway = amap.locationAtProgress(geometry, 0.5);
  assertClose(halfway.point[0], 0.002, 0.00002);
  assertClose(halfway.point[1], 0);
  assert.deepEqual(halfway.passed.at(-1), halfway.point);
  assert.deepEqual(halfway.remaining[0], halfway.point);
  assert.ok(halfway.point[0] > flattened[1][0], "progress must be interpolated by distance, not point index");

  const overviewCamera = amap.routeOverviewCamera(successfulRoute.steps.flatMap((step) => step.path), 753, 674);
  assert.ok(overviewCamera.center[0] > 120.7359 && overviewCamera.center[0] < 120.791879);
  assert.ok(overviewCamera.center[1] > 31.3048 && overviewCamera.center[1] < 31.33468);
  assert.ok(overviewCamera.zoom > 13 && overviewCamera.zoom < 15, `overview zoom should fit the whole route, got ${overviewCamera.zoom}`);

  const middleSegment = amap.pathBetweenProgress(geometry, 0.25, 0.75);
  assertClose(middleSegment[0][0], 0.001, 0.00002);
  assertClose(middleSegment.at(-1)[0], 0.003, 0.00002);

  const veryLongMotionPath = Array.from({ length: 702 }, (_, index) => [120 + index / 100000, 31]);
  const boundedMotionPath = amap.buildTimedMotionPath(veryLongMotionPath, 520);
  assert.ok(boundedMotionPath.length <= 34, `long paths must be sampled, got ${boundedMotionPath.length} points`);
  assert.deepEqual(boundedMotionPath[0], { position: veryLongMotionPath[0], duration: 0 });
  assert.deepEqual(boundedMotionPath.at(-1).position, veryLongMotionPath.at(-1));
  assert.equal(
    boundedMotionPath.reduce((sum, item) => sum + item.duration, 0),
    520,
    "arbitrary path lengths must preserve the exact animation budget"
  );
  assert.ok(boundedMotionPath.slice(1).every((item) => item.duration >= 16));

  const firstMeta = amap.routeMeta(successfulRoute, 0);
  assert.equal(firstMeta.instruction, "左转进入星龙街");
  assert.equal(firstMeta.maneuver, "left");
  assert.equal(firstMeta.roadName, "星龙街");
  assert.deepEqual(firstMeta.nextDistance, { value: "1.0", unit: "公里" });
  assert.equal(firstMeta.remainingDistanceMeters, 4000);
  assert.equal(firstMeta.remainingDurationSeconds, 900);

  const secondMeta = amap.routeMeta(successfulRoute, 0.3);
  assert.equal(secondMeta.stepIndex, 1);
  assert.equal(secondMeta.instruction, "沿现代大道后右转");
  assert.equal(secondMeta.maneuver, "right");
  assert.equal(secondMeta.roadName, "现代大道");
  assert.deepEqual(secondMeta.nextDistance, { value: "800", unit: "米" });
  assert.equal(secondMeta.remainingDistanceMeters, 2800);
  assert.equal(secondMeta.remainingDurationSeconds, 630);

  resetRuntime();
  const online = createAdapter();
  const initialized = await online.adapter.init({
    mapProvider: "amap",
    amapKey: "test-key",
    amapStyle: "amap://styles/normal",
    amapMonthlyMapLimit: 10,
    amapMonthlyRouteLimit: 10
  });
  assert.equal(initialized.mode, "map_ready");
  assert.equal(online.container.hidden, false);
  assert.equal(online.adapter.getStatus(), "map_ready");
  assert.equal(online.adapter.get3dMode(), "native", "function-form WebGL capability must be detected");
  assert.deepEqual(online.adapter.getLabelDiagnostics(), {
    showLabel: true,
    labelRejectMask: true,
    features: ["bg", "road", "building", "point"],
    routeLabelCount: 0,
    renderCompleteCount: 0,
    labelsReady: false,
    labelsReadyModes: [],
    poiLabelCount: 0,
    poiVisibleCount: 0,
    poiSearchStatus: "idle"
  });

  const routeConfig = {
    start: [120.791879, 31.33468],
    end: [120.7359, 31.3048],
    originName: "博世苏州",
    destinationName: "阳光小学"
  };
  const firstPlan = await online.adapter.setRoute(routeConfig, "session-a:task-school");
  const duplicatePlan = await online.adapter.setRoute(routeConfig, "session-a:task-school");
  assert.deepEqual(firstPlan, { mode: "online", planned: true });
  assert.deepEqual(duplicatePlan, { mode: "online", planned: false });
  assert.equal(routePlanCount, 1, "same route key must not trigger another AMap.Driving search");
  assert.equal(online.adapter.getStatus(), "online");
  assert.equal(online.adapter.getLabelDiagnostics().routeLabelCount, 3);
  assert.deepEqual(amap.routeRoadLabels(successfulRoute).map((item) => item.name), ["星龙街", "现代大道", "星湖街"]);
  assert.equal(online.mapWrap.classList.contains("is-amap-online"), true);
  const overviewCameraCall = calls.filter(([name]) => name === "fit").at(-1);
  assert.equal(overviewCameraCall[0], "fit");
  assert.equal(overviewCameraCall[1].length, 3);
  assert.equal(overviewCameraCall[2], true);
  assert.deepEqual(overviewCameraCall[3], [112, 88, 104, 88]);
  assert.equal(overviewCameraCall[4], 16);
  assert.equal(online.routeMetas[0].roadName, "星龙街");
  assert.deepEqual(online.adapter.getUsage(), {
    month: currentLocalMonth(),
    mapLoads: 1,
    routePlans: 1,
    poiSearches: 0
  });
  await online.adapter.loadNearbyPois([120.791879, 31.33468], "session-a:task-school");
  await online.adapter.loadNearbyPois([120.792, 31.335], "session-a:task-school");
  assert.equal(poiSearchCount, 1, "one route must trigger at most one nearby POI search");
  assert.equal(online.adapter.getLabelDiagnostics().poiSearchStatus, "ready");
  assert.equal(online.adapter.getLabelDiagnostics().poiLabelCount, 3);
  assert.equal(online.adapter.getLabelDiagnostics().poiVisibleCount, 3, "overview may supplement native labels with route-context POIs");
  assert.deepEqual(online.adapter.overlays.poiMarkers.map((marker) => marker.__auriRank), [1000, 999, 998]);
  assert.ok(online.adapter.overlays.poiMarkers.every((marker) => marker.options.content.className === "auri-amap-poi-label"));
  assert.deepEqual(online.adapter.overlays.poiMarkers.map((marker) => marker.options.content.textContent), ["博世苏州", "现代大厦", "星龙街产业园"]);
  assert.equal(online.adapter.getUsage().poiSearches, 1);

  const unnamedRoute = { distance: 100, time: 60, steps: [{ instruction: "直行", road: "", distance: 100, path: [[0, 0], [0.001, 0]] }] };
  assert.equal(amap.routeMeta(unnamedRoute, 0).roadName, "", "missing AMap road names must stay hidden instead of using a fake label");

  const headingWritesBeforeMotion = calls.filter(([name, property]) => name === "style" && property === "--auri-vehicle-heading").length;
  online.adapter.update({
    stage: "waiting_confirmation",
    progress: 0.5,
    showVehicle: true,
    overview: false,
    driving: true,
    riskLevel: "L2",
    lateMinutes: 18
  });
  assert.equal(online.adapter.getCameraMode(), "follow");
  assert.equal(online.adapter.getLabelDiagnostics().poiVisibleCount, 3, "follow mode should retain real AMap PlaceSearch context labels");
  assert.ok(online.adapter.overlays.poiMarkers.every((marker) => marker.visible === true));
  assert.ok(online.adapter.getCameraRotation() > 0);
  assert.equal(online.adapter.getCameraPitch(), 24);
  assert.ok(online.adapter.getAnchorDiagnostics().errorPx < 0.01, online.adapter.getAnchorDiagnostics());
  assert.deepEqual(online.adapter.getAnchorDiagnostics().target, [500, 504]);
  assert.equal(
    online.adapter.overlays.vehicleContent.style.getPropertyValue("--auri-vehicle-heading"),
    "0deg",
    "follow camera must keep the navigation arrow pointing forward while the AURI wordmark stays horizontal"
  );
  assert.equal(online.adapter.overlays.incidentMarker.visible, true);
  assert.equal(online.adapter.overlays.incidentContent.textContent, "拥堵 · 晚到 18 分钟");
  assert.deepEqual(
    online.adapter.overlays.routeCongestionBands.map((band) => band.options.strokeColor),
    ["#e6a700", "#d1495b", "#8f2032"],
    "congestion must progress from amber to red and deep red"
  );
  assert.equal(online.adapter.control("overview"), true);
  assert.equal(online.adapter.getLabelDiagnostics().poiVisibleCount, 3);
  assert.ok(online.adapter.overlays.poiMarkers.every((marker) => marker.visible === true));
  assert.equal(online.adapter.control("follow"), true);
  assert.equal(online.adapter.getLabelDiagnostics().poiVisibleCount, 3);
  const zoomWritesBeforeSteadyUpdate = calls.filter(([name]) => name === "zoom-center").length;
  const pitchWritesBeforeSteadyUpdate = calls.filter(([name]) => name === "pitch").length;
  online.adapter.update({
    stage: "waiting_confirmation",
    progress: 0.56,
    showVehicle: true,
    overview: false,
    driving: true,
    riskLevel: "L2",
    lateMinutes: 18,
    motionDurationMs: 640
  });
  assert.ok(calls.filter(([name]) => name === "zoom-center").length <= zoomWritesBeforeSteadyUpdate + 1, "follow updates may change zoom only when the distance bucket changes");
  assert.equal(calls.filter(([name]) => name === "pitch").length, pitchWritesBeforeSteadyUpdate, "steady follow updates must preserve pitch");
  assert.equal(calls.some(([name]) => name === "move-along"), true, "vehicle must use AMap moveAlong for curved route animation");
  const moveAlongCall = calls.find(([name]) => name === "move-along");
  assert.ok(moveAlongCall[2] <= 640, `timed path must stay within its 640ms motion budget, got ${moveAlongCall[2]}ms`);
  assert.ok(
    calls.filter(([name, property]) => name === "style" && property === "--auri-vehicle-heading").length > headingWritesBeforeMotion,
    "AMap moving events must keep the arrow heading synchronized with the actual marker position"
  );
  assert.equal(online.adapter.getMotionMethod(), "moveAlong");
  assert.deepEqual(online.adapter.getMotionDiagnostics(), {
    active: false,
    overlapCount: 0,
    completedCount: 1,
    plannedDurationMs: moveAlongCall[2],
    markerProgress: 0.56,
    targetProgress: 0.56,
    pendingProgress: null
  });
  assert.equal(online.adapter.overlays.routeCongestionBands.every((band) => band.options.strokeOpacity === 1), true);
  online.adapter.update({
    stage: "waiting_confirmation",
    progress: 0.5,
    showVehicle: true,
    overview: false,
    driving: true,
    stopped: true,
    riskLevel: "L2",
    lateMinutes: 18
  });
  assert.equal(online.adapter.overlays.incidentContent.textContent, "严重拥堵 · 已停车等待");
  assert.equal(online.adapter.control("traffic"), true);
  assert.equal(online.adapter.isTrafficVisible(), false);
  assert.equal(online.adapter.overlays.routeCongestionBands.every((band) => band.options.strokeOpacity === 0), true);
  assert.equal(online.adapter.control("traffic"), true);
  assert.equal(online.adapter.isTrafficVisible(), true);
  assert.deepEqual(
    online.adapter.overlays.vehicleMarker.position,
    online.adapter.overlays.routePassed.path.at(-1),
    "vehicle position and passed-route endpoint must remain aligned"
  );
  online.adapter.clearNavigation();
  assert.equal(online.adapter.getStatus(), "offline");

  resetRuntime();
  fakeAMap.Browser.isWebGL = false;
  const reportedFallback = createAdapter();
  await reportedFallback.adapter.init({ mapProvider: "amap", amapKey: "test-key", amapMonthlyMapLimit: 10, amapMonthlyRouteLimit: 10 });
  assert.equal(reportedFallback.adapter.get3dMode(), "overview-only", "false WebGL capability must degrade to a truthful route overview");
  assert.equal(reportedFallback.mapWrap.dataset.webglReported, "false");
  assert.equal(reportedFallback.mapWrap.dataset.webglRuntime, "false");
  assert.equal(reportedFallback.mapWrap.dataset.webglEffective, "false");
  assert.equal(reportedFallback.adapter.map.options.mapStyle, "amap://styles/normal");
  assert.deepEqual(reportedFallback.adapter.map.options.features, ["bg", "road", "building", "point"]);
  assert.equal(reportedFallback.adapter.map.options.showLabel, true);
  await reportedFallback.adapter.setRoute(routeConfig, "reported-fallback-route");
  reportedFallback.adapter.update({
    stage: "vehicle_observation",
    progress: 0.32,
    showVehicle: true,
    overview: false,
    driving: true,
    stopped: false,
    motionDurationMs: 440,
    riskLevel: "L0",
    lateMinutes: 0
  });
  assert.equal(reportedFallback.adapter.getCameraMode(), "overview");
  assert.equal(reportedFallback.adapter.getCameraPitch(), 0);
  assert.equal(reportedFallback.adapter.getCameraRotation(), 0);
  assert.equal(reportedFallback.mapWrap.dataset.vehicleVisible, "true");
  assert.equal(reportedFallback.mapWrap.dataset.amap3d, "overview-only");
  assert.equal(reportedFallback.adapter.overlays.vehicleMarker.visible, true, "2D degradation keeps the geographic vehicle marker in route overview");
  assert.equal(reportedFallback.adapter.control("follow"), false, "2D degradation must not present a fake locked-car mode");

  const originalCreateElement = global.document.createElement;
  global.document.createElement = (tagName) => {
    if (tagName === "canvas") return { getContext: (type) => type === "webgl2" ? {} : null };
    return originalCreateElement(tagName);
  };
  resetRuntime();
  const runtimeWebgl = createAdapter();
  await runtimeWebgl.adapter.init({ mapProvider: "amap", amapKey: "test-key", amapMonthlyMapLimit: 10, amapMonthlyRouteLimit: 10 });
  assert.equal(runtimeWebgl.adapter.get3dMode(), "overview-only", "AMap must report WebGL and return an effective pitch before 3D follow is enabled");
  assert.equal(runtimeWebgl.mapWrap.dataset.webglReported, "false");
  assert.equal(runtimeWebgl.mapWrap.dataset.webglRuntime, "true");
  assert.equal(runtimeWebgl.mapWrap.dataset.webglEffective, "false");
  global.document.createElement = originalCreateElement;
  fakeAMap.Browser.isWebGL = () => true;

  resetRuntime();
  deferMoveEnd = true;
  const coalesced = createAdapter();
  await coalesced.adapter.init({ mapProvider: "amap", amapKey: "test-key", amapMonthlyMapLimit: 10, amapMonthlyRouteLimit: 10 });
  await coalesced.adapter.setRoute(routeConfig, "coalesced-route");
  const movingSnapshot = {
    stage: "vehicle_observation",
    showVehicle: true,
    overview: false,
    driving: true,
    stopped: false,
    motionDurationMs: 440,
    riskLevel: "L0",
    lateMinutes: 0
  };
  coalesced.adapter.update({ ...movingSnapshot, progress: 0.2 });
  coalesced.adapter.update({ ...movingSnapshot, progress: 0.21 });
  const moveCallsAfterFirst = calls.filter(([name]) => name === "move-along").length;
  coalesced.adapter.update({ ...movingSnapshot, progress: 0.22 });
  assert.equal(calls.filter(([name]) => name === "move-along").length, moveCallsAfterFirst, "an active marker animation must coalesce later progress updates");
  assert.equal(coalesced.adapter.getMotionDiagnostics().overlapCount, 0);
  coalesced.adapter.overlays.vehicleMarker.listeners.get("moveend")?.({ target: coalesced.adapter.overlays.vehicleMarker });
  assert.equal(calls.filter(([name]) => name === "move-along").length, moveCallsAfterFirst + 1, "moveend must continue directly to the latest coalesced target");
  assert.equal(coalesced.adapter.getMotionDiagnostics().targetProgress, 0.22);
  coalesced.adapter.update({ ...movingSnapshot, progress: 0.23 });
  assert.equal(calls.filter(([name]) => name === "move-along").length, moveCallsAfterFirst + 1, "the final frame must remain queued while the coalesced segment is active");
  coalesced.adapter.overlays.vehicleMarker.listeners.get("moveend")?.({ target: coalesced.adapter.overlays.vehicleMarker });
  assert.equal(calls.filter(([name]) => name === "move-along").length, moveCallsAfterFirst + 2, "the final queued frame must start without another state update");
  coalesced.adapter.overlays.vehicleMarker.listeners.get("moveend")?.({ target: coalesced.adapter.overlays.vehicleMarker });
  assert.equal(coalesced.adapter.getMotionDiagnostics().markerProgress, 0.23);
  assert.equal(coalesced.adapter.getMotionDiagnostics().active, false);

  resetRuntime();
  deferMoveEnd = true;
  const watchdog = createAdapter();
  await watchdog.adapter.init({ mapProvider: "amap", amapKey: "test-key", amapMonthlyMapLimit: 10, amapMonthlyRouteLimit: 10 });
  await watchdog.adapter.setRoute(routeConfig, "watchdog-route");
  watchdog.adapter.update({ ...movingSnapshot, motionDurationMs: 120, progress: 0.1 });
  watchdog.adapter.update({ ...movingSnapshot, motionDurationMs: 120, progress: 0.15 });
  watchdog.adapter.update({ ...movingSnapshot, motionDurationMs: 120, progress: 0.18 });
  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.equal(watchdog.adapter.getMotionDiagnostics().completedCount, 1, "watchdog must finish a segment when moveend is missing");
  assert.equal(watchdog.adapter.getMotionDiagnostics().targetProgress, 0.18, "watchdog completion must continue to the queued final target");
  watchdog.adapter.overlays.vehicleMarker.listeners.get("moveend")?.({ target: watchdog.adapter.overlays.vehicleMarker });
  assert.equal(watchdog.adapter.getMotionDiagnostics().markerProgress, 0.18);
  deferMoveEnd = false;

  assert.equal(online.adapter.routePath.length, 0);
  assert.equal(online.mapWrap.classList.contains("is-amap-online"), false);
  assert.equal(online.container.hidden, true);
  const resumedPlan = await online.adapter.setRoute(routeConfig, "session-b:task-school");
  assert.deepEqual(resumedPlan, { mode: "online", planned: true });
  assert.equal(online.container.hidden, false, "a route created after the empty-task state must reveal the real map again");
  assert.equal(calls.some(([name]) => name === "resize"), true);

  resetRuntime();
  const mapGuard = createAdapter();
  storageValues.set(amap.USAGE_KEY, JSON.stringify({
    month: currentLocalMonth(),
    mapLoads: 1,
    routePlans: 0
  }));
  const mapGuardResult = await mapGuard.adapter.init({
    mapProvider: "amap",
    amapKey: "test-key",
    amapMonthlyMapLimit: 1,
    amapMonthlyRouteLimit: 10
  });
  assert.deepEqual(mapGuardResult, { mode: "offline", reason: "usage_guard" });
  assert.equal(mapGuard.container.hidden, true);
  assert.equal(mapGuard.statuses.at(-1).message, "已切换离线导航");
  assert.match(mapGuard.statuses.at(-1).detail, /地图调用保护/);

  resetRuntime();
  const routeGuard = createAdapter();
  await routeGuard.adapter.init({
    mapProvider: "amap",
    amapKey: "test-key",
    amapMonthlyMapLimit: 10,
    amapMonthlyRouteLimit: 1
  });
  storageValues.set(amap.USAGE_KEY, JSON.stringify({
    month: currentLocalMonth(),
    mapLoads: 1,
    routePlans: 1
  }));
  const routeGuardResult = await routeGuard.adapter.setRoute(routeConfig, "guarded-route");
  assert.deepEqual(routeGuardResult, { mode: "offline", reason: "usage_guard" });
  assert.equal(routePlanCount, 0);
  assert.equal(routeGuard.adapter.getStatus(), "offline");

  resetRuntime();
  const poiGuard = createAdapter();
  await poiGuard.adapter.init({
    mapProvider: "amap",
    amapKey: "test-key",
    amapMonthlyMapLimit: 10,
    amapMonthlyRouteLimit: 10,
    amapMonthlyPoiLimit: 60
  });
  await poiGuard.adapter.setRoute(routeConfig, "poi-guarded-route");
  storageValues.set(amap.USAGE_KEY, JSON.stringify({
    month: currentLocalMonth(),
    mapLoads: 1,
    routePlans: 1,
    poiSearches: 60
  }));
  await poiGuard.adapter.loadNearbyPois([120.791879, 31.33468], "poi-guarded-route");
  await poiGuard.adapter.loadNearbyPois([120.792, 31.335], "poi-guarded-route");
  assert.equal(poiSearchCount, 0, "POI quota guard must prevent external calls and memoize the guarded route");
  assert.equal(poiGuard.adapter.getLabelDiagnostics().poiSearchStatus, "usage_guard");

  resetRuntime();
  deferPoiSearch = true;
  const poiRouteSwitch = createAdapter();
  await poiRouteSwitch.adapter.init({
    mapProvider: "amap",
    amapKey: "test-key",
    amapMonthlyMapLimit: 10,
    amapMonthlyRouteLimit: 10,
    amapMonthlyPoiLimit: 60
  });
  await poiRouteSwitch.adapter.setRoute(routeConfig, "poi-route-a");
  const oldPoiRequest = poiRouteSwitch.adapter.loadNearbyPois([120.791879, 31.33468], "poi-route-a");
  await poiRouteSwitch.adapter.setRoute(routeConfig, "poi-route-b");
  poiRouteSwitch.adapter.update({
    stage: "vehicle_observation",
    progress: 0.2,
    showVehicle: true,
    overview: false,
    driving: true,
    riskLevel: "L0",
    lateMinutes: 0
  });
  assert.equal(pendingPoiSearches.length, 2);
  pendingPoiSearches[0]();
  await oldPoiRequest;
  assert.equal(poiRouteSwitch.adapter.getLabelDiagnostics().poiSearchStatus, "loading", "stale POI completion must not overwrite the new route state");
  pendingPoiSearches[1]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(poiRouteSwitch.adapter.getLabelDiagnostics().poiSearchStatus, "ready");
  assert.equal(poiRouteSwitch.adapter.getLabelDiagnostics().poiLabelCount, 3);
  assert.equal(poiSearchCount, 2, "each distinct route may issue one POI search during a rapid switch");
  deferPoiSearch = false;
  poiRouteSwitch.adapter.clearRoute();
  assert.equal(poiRouteSwitch.adapter.getLabelDiagnostics().poiSearchStatus, "idle");
  await poiRouteSwitch.adapter.setRoute(routeConfig, "poi-route-b");
  poiRouteSwitch.adapter.update({
    stage: "vehicle_observation",
    progress: 0.25,
    showVehicle: true,
    overview: false,
    driving: true,
    riskLevel: "L0",
    lateMinutes: 0
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(poiSearchCount, 3, "clearing and restoring the same route key must reload nearby POIs once");
  assert.equal(poiRouteSwitch.adapter.getLabelDiagnostics().poiSearchStatus, "ready");

  resetRuntime();
  drivingResultMode = "failure";
  const failedRoute = createAdapter();
  await failedRoute.adapter.init({
    mapProvider: "amap",
    amapKey: "test-key",
    amapMonthlyMapLimit: 10,
    amapMonthlyRouteLimit: 10
  });
  const failedRouteResult = await failedRoute.adapter.setRoute(routeConfig, "failed-route");
  assert.equal(failedRouteResult.mode, "offline");
  assert.match(failedRouteResult.reason, /route unavailable/);
  assert.equal(failedRoute.statuses.at(-1).message, "已切换离线导航");
  assert.match(failedRoute.statuses.at(-1).detail, /route unavailable/);
  assert.equal(failedRoute.container.hidden, true);
  assert.equal(failedRoute.mapWrap.classList.contains("is-amap-online"), false);

  resetRuntime();
  const offline = createAdapter();
  const offlineResult = await offline.adapter.init({ mapProvider: "auto", amapKey: "" });
  assert.deepEqual(offlineResult, { mode: "offline" });
  assert.equal(offline.container.hidden, true);
  assert.equal(offline.adapter.getStatus(), "offline");

  const timeoutFailures = [];

  resetRuntime();
  drivingResultMode = "hang";
  const hangingRoute = createAdapter();
  await hangingRoute.adapter.init({
    mapProvider: "amap",
    amapKey: "test-key",
    amapMonthlyMapLimit: 10,
    amapMonthlyRouteLimit: 10,
    amapRouteTimeoutMs: 20
  });
  const hangingRouteOutcome = await settleWithin(
    hangingRoute.adapter.setRoute(routeConfig, "hanging-route"),
    200
  );
  try {
    assert.equal(hangingRouteOutcome.timedOut, false, "hanging Driving.search must fall back within 200ms");
    assert.ok(hangingRouteOutcome.elapsedMs < 200, `route timeout fallback took ${hangingRouteOutcome.elapsedMs}ms`);
    assert.equal(hangingRouteOutcome.value.mode, "offline");
    assert.match(hangingRouteOutcome.value.reason, /超时/);
    assert.equal(hangingRoute.container.hidden, true);
    assert.equal(hangingRoute.mapWrap.classList.contains("is-amap-online"), false);
    const plansAfterFailure = routePlanCount;
    const duplicateFailure = await hangingRoute.adapter.setRoute(routeConfig, "hanging-route");
    assert.equal(duplicateFailure.mode, "offline");
    assert.equal(duplicateFailure.planned, false);
    assert.equal(routePlanCount, plansAfterFailure, "same failed route must not consume another route plan");
  } catch (error) {
    timeoutFailures.push(error);
  }

  resetRuntime();
  const loadingTimeout = createAdapter();
  delete global.AMap;
  try {
    const loadingOutcome = await settleWithin(loadingTimeout.adapter.init({
      mapProvider: "amap",
      amapKey: "test-key",
      amapMonthlyMapLimit: 10,
      amapMonthlyRouteLimit: 10,
      amapLoadTimeoutMs: 20
    }), 200);
    assert.equal(loadingOutcome.timedOut, false, "AMap script loading must fall back within 200ms");
    assert.ok(loadingOutcome.elapsedMs < 200, `AMap load timeout fallback took ${loadingOutcome.elapsedMs}ms`);
    assert.equal(loadingOutcome.value.mode, "offline");
    assert.match(loadingOutcome.value.reason, /超时/);
    assert.equal(loadingTimeout.container.hidden, true);
  } catch (error) {
    timeoutFailures.push(error);
  } finally {
    global.AMap = fakeAMap;
  }

  if (timeoutFailures.length) throw new AggregateError(timeoutFailures, "AMap timeout fallback tests failed");

  console.log("vehicle-hmi amap-adapter tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
