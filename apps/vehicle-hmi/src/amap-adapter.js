(function initAuriAmapAdapter(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AuriAmapAdapter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createAmapModule(root) {
  "use strict";

  const USAGE_KEY = "auri-hmi-next-amap-usage";
  const DEFAULT_LIMITS = { mapLoads: 200, routePlans: 200, poiSearches: 60 };
  const MAX_FAILURE_FALLBACK_MS = 1800;
  const DEFAULT_SCRIPT_LOAD_TIMEOUT_MS = 12000;
  const MAX_SCRIPT_LOAD_TIMEOUT_MS = 15000;
  const DEFAULT_ROUTE_TIMEOUT_MS = 8000;
  const MAX_ROUTE_TIMEOUT_MS = 12000;
  let loaderPromise = null;
  let loaderWebglHintApplied = false;

  function boundedTimeoutMs(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return MAX_FAILURE_FALLBACK_MS;
    return Math.min(MAX_FAILURE_FALLBACK_MS, Math.max(10, Math.round(parsed)));
  }

  function boundedScriptLoadTimeoutMs(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SCRIPT_LOAD_TIMEOUT_MS;
    return Math.min(MAX_SCRIPT_LOAD_TIMEOUT_MS, Math.max(10, Math.round(parsed)));
  }

  function boundedRouteTimeoutMs(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ROUTE_TIMEOUT_MS;
    return Math.min(MAX_ROUTE_TIMEOUT_MS, Math.max(10, Math.round(parsed)));
  }

  function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  function runtimeSupportsWebgl(documentRef = root?.document) {
    try {
      const canvas = documentRef?.createElement?.("canvas");
      if (!canvas?.getContext) return false;
      return Boolean(
        canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false })
        || canvas.getContext("webgl", { failIfMajorPerformanceCaveat: false })
        || canvas.getContext("experimental-webgl", { failIfMajorPerformanceCaveat: false })
      );
    } catch (_error) {
      return false;
    }
  }

  function pointValue(point) {
    if (!point) return null;
    if (Array.isArray(point)) return [Number(point[0]), Number(point[1])];
    if (typeof point.getLng === "function") return [point.getLng(), point.getLat()];
    if ("lng" in point && "lat" in point) return [Number(point.lng), Number(point.lat)];
    return null;
  }

  function pixelValue(pixel) {
    if (!pixel) return null;
    if (Array.isArray(pixel)) return [Number(pixel[0]), Number(pixel[1])];
    if (typeof pixel.getX === "function") return [Number(pixel.getX()), Number(pixel.getY())];
    if ("x" in pixel && "y" in pixel) return [Number(pixel.x), Number(pixel.y)];
    return null;
  }

  function flattenDrivingPath(route) {
    const path = [];
    (route?.steps || []).forEach((step) => {
      (step.path || []).forEach((point) => {
        const pair = pointValue(point);
        if (!pair || pair.some((value) => !Number.isFinite(value))) return;
        const previous = path[path.length - 1];
        if (!previous || previous[0] !== pair[0] || previous[1] !== pair[1]) path.push(pair);
      });
    });
    return path;
  }

  function bearing(from, to) {
    if (!from || !to) return 0;
    const latitude = ((from[1] + to[1]) / 2) * Math.PI / 180;
    const east = (to[0] - from[0]) * Math.cos(latitude);
    const north = to[1] - from[1];
    return Math.atan2(east, north) * 180 / Math.PI;
  }

  function screenHeading(heading, mapRotation = 0) {
    return ((Number(heading || 0) + Number(mapRotation || 0)) % 360 + 360) % 360;
  }

  function followCameraSpec(meta, attention = false) {
    const nextDistanceMeters = Number(meta?.nextDistanceMeters || 0);
    // Keep enough map context for AMap's native road, community and POI labels.
    // The route marker still animates independently; the map camera changes
    // only when its actual center/heading bucket changes.
    const routeZoom = nextDistanceMeters <= 180 ? 16.2 : nextDistanceMeters <= 600 ? 16.0 : 15.8;
    const lookAheadMeters = nextDistanceMeters <= 180 ? 118 : nextDistanceMeters <= 600 ? 178 : 245;
    return {
      lookAheadMeters: attention ? Math.min(lookAheadMeters, 154) : lookAheadMeters,
      zoom: attention ? Math.min(routeZoom, 15.95) : routeZoom,
      pitch: attention ? 24 : 28,
      anchorY: 0.72,
      rotationThreshold: 4
    };
  }

  function waitForMapReady(map, timeoutMs = 720) {
    if (!map || typeof map.once !== "function") return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        root.clearTimeout?.(timer);
        resolve();
      };
      const timer = root.setTimeout?.(finish, timeoutMs);
      map.once("complete", () => root.requestAnimationFrame ? root.requestAnimationFrame(finish) : finish());
    });
  }

  function waitForMapLabels(map, timeoutMs = 3200) {
    if (!map || typeof map.on !== "function") return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (loaded) => {
        if (settled) return;
        settled = true;
        root.clearTimeout?.(timer);
        map.off?.("complete", onMapComplete);
        resolve(loaded);
      };
      const onMapComplete = () => finish(true);
      const timer = root.setTimeout?.(() => finish(false), timeoutMs);
      map.on("complete", onMapComplete);
    });
  }

  function hasRenderedMapSurface(container) {
    return Boolean(container?.querySelector?.(".amap-maps, .amap-layer, canvas"));
  }

  function trafficColor(status) {
    const normalized = String(status || "").trim();
    if (/严重拥堵|极度拥堵/.test(normalized)) return "#8f2032";
    if (/拥堵/.test(normalized)) return "#d1495b";
    if (/缓行|慢行/.test(normalized)) return "#e6a700";
    if (/畅通/.test(normalized)) return "#2e9d6f";
    return "#2f6bff";
  }

  function flattenTrafficSegments(route) {
    const segments = [];
    (route?.steps || []).forEach((step) => {
      (step?.tmcs || []).forEach((tmc) => {
        const path = [];
        (tmc?.path || []).forEach((point) => {
          const pair = pointValue(point);
          if (pair && pair.every(Number.isFinite)) appendUnique(path, pair);
        });
        if (path.length > 1) segments.push({
          path,
          status: String(tmc?.status || "").trim(),
          color: trafficColor(tmc?.status)
        });
      });
    });
    return segments;
  }

  function routeRoadLabels(route, limit = 8) {
    const seen = new Set();
    const labels = [];
    for (const step of route?.steps || []) {
      const name = String(step?.road || "").trim();
      const path = (step?.path || []).map(pointValue).filter((point) => point?.every(Number.isFinite));
      if (!name || /^(无名道路|当前道路)$/.test(name) || seen.has(name) || !path.length) continue;
      seen.add(name);
      labels.push({ name, position: path[Math.floor((path.length - 1) * 0.5)] });
      if (labels.length >= limit) break;
    }
    return labels;
  }

  function distanceMeters(from, to) {
    const radius = 6371008.8;
    const lat1 = from[1] * Math.PI / 180;
    const lat2 = to[1] * Math.PI / 180;
    const deltaLat = (to[1] - from[1]) * Math.PI / 180;
    const deltaLng = (to[0] - from[0]) * Math.PI / 180;
    const sinLat = Math.sin(deltaLat / 2);
    const sinLng = Math.sin(deltaLng / 2);
    const value = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
    return radius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  }

  function buildRouteGeometry(path) {
    const normalizedPath = Array.isArray(path) ? path.filter((point) => Array.isArray(point) && point.length >= 2) : [];
    const cumulative = [0];
    for (let index = 1; index < normalizedPath.length; index += 1) {
      cumulative.push(cumulative[index - 1] + distanceMeters(normalizedPath[index - 1], normalizedPath[index]));
    }
    return { path: normalizedPath, cumulative, totalDistance: cumulative.at(-1) || 0 };
  }

  function mercatorY(latitude) {
    const bounded = Math.max(-85.05112878, Math.min(85.05112878, Number(latitude) || 0));
    const radians = bounded * Math.PI / 180;
    return (1 - Math.log(Math.tan(radians) + (1 / Math.cos(radians))) / Math.PI) / 2;
  }

  function latitudeFromMercatorY(value) {
    return Math.atan(Math.sinh(Math.PI * (1 - 2 * value))) * 180 / Math.PI;
  }

  function routeOverviewCamera(path, width = 1000, height = 700) {
    const points = (Array.isArray(path) ? path : [])
      .map(pointValue)
      .filter((point) => point?.every(Number.isFinite));
    if (!points.length) return { center: [120.791879, 31.33468], zoom: 13 };

    const normalizedWidth = Math.max(320, Number(width) || 1000);
    const normalizedHeight = Math.max(260, Number(height) || 700);
    const longitudes = points.map((point) => point[0]);
    const mercatorValues = points.map((point) => mercatorY(point[1]));
    const minLng = Math.min(...longitudes);
    const maxLng = Math.max(...longitudes);
    const minY = Math.min(...mercatorValues);
    const maxY = Math.max(...mercatorValues);
    const centerY = (minY + maxY) / 2;
    const center = [(minLng + maxLng) / 2, latitudeFromMercatorY(centerY)];
    const longitudeSpan = Math.max(1 / 360000, (maxLng - minLng) / 360);
    const mercatorSpan = Math.max(1 / 360000, maxY - minY);
    const usableWidth = Math.max(220, normalizedWidth - 260);
    const usableHeight = Math.max(200, normalizedHeight - 230);
    const longitudeZoom = Math.log2(usableWidth / (256 * longitudeSpan));
    const latitudeZoom = Math.log2(usableHeight / (256 * mercatorSpan));
    const zoom = Math.max(10, Math.min(16, Math.min(longitudeZoom, latitudeZoom) - 0.12));
    return { center, zoom };
  }

  function appendUnique(path, point) {
    const previous = path.at(-1);
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) path.push(point);
  }

  function locationAtProgress(geometry, progress) {
    if (!geometry?.path?.length) return { point: null, passed: [], remaining: [], heading: 0, beforeIndex: -1, afterIndex: -1 };
    if (geometry.path.length === 1) {
      return { point: geometry.path[0], passed: [geometry.path[0]], remaining: [geometry.path[0]], heading: 0, beforeIndex: 0, afterIndex: 0 };
    }
    const normalized = clamp(progress);
    const targetDistance = geometry.totalDistance * normalized;
    let afterIndex = geometry.cumulative.findIndex((distance) => distance >= targetDistance);
    if (afterIndex < 0) afterIndex = geometry.path.length - 1;
    const beforeIndex = Math.max(0, afterIndex - 1);
    const from = geometry.path[beforeIndex];
    const to = geometry.path[afterIndex] || from;
    const segmentStart = geometry.cumulative[beforeIndex] || 0;
    const segmentLength = Math.max(0, (geometry.cumulative[afterIndex] || segmentStart) - segmentStart);
    const ratio = segmentLength ? (targetDistance - segmentStart) / segmentLength : 0;
    const point = [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio];
    const passed = geometry.path.slice(0, beforeIndex + 1);
    appendUnique(passed, point);
    const remaining = [point];
    geometry.path.slice(afterIndex).forEach((item) => appendUnique(remaining, item));
    return { point, passed, remaining, heading: bearing(from, to), beforeIndex, afterIndex };
  }

  function pathBetweenProgress(geometry, startProgress, endProgress) {
    const start = locationAtProgress(geometry, startProgress);
    const end = locationAtProgress(geometry, endProgress);
    if (!start.point || !end.point) return [];
    const path = [start.point];
    for (let index = start.afterIndex; index <= end.beforeIndex; index += 1) appendUnique(path, geometry.path[index]);
    appendUnique(path, end.point);
    return path;
  }

  function buildTimedMotionPath(path, durationMs, minimumSegmentMs = 16) {
    const source = Array.isArray(path) ? path.filter(Boolean) : [];
    if (!source.length) return [];
    if (source.length === 1) return [{ position: source[0], duration: 0 }];
    const totalDuration = Math.max(1, Math.round(Number(durationMs) || 1));
    const maxSegments = Math.max(1, Math.floor(totalDuration / Math.max(1, minimumSegmentMs)));
    const targetSegments = Math.min(source.length - 1, maxSegments);
    const sampled = [source[0]];
    for (let index = 1; index < targetSegments; index += 1) {
      const sourceIndex = Math.round(index * (source.length - 1) / targetSegments);
      const point = source[sourceIndex];
      if (point !== sampled.at(-1)) sampled.push(point);
    }
    if (source.at(-1) !== sampled.at(-1)) sampled.push(source.at(-1));
    const segmentCount = Math.max(1, sampled.length - 1);
    const baseDuration = Math.floor(totalDuration / segmentCount);
    const remainder = totalDuration - baseDuration * segmentCount;
    return sampled.map((position, index) => ({
      position,
      duration: index === 0 ? 0 : baseDuration + (index <= remainder ? 1 : 0)
    }));
  }

  function routeMeta(route, progress = 0) {
    const steps = (route?.steps || []).filter((step) => step?.instruction);
    const totalDistance = Number(route?.distance || 0) || steps.reduce((sum, step) => sum + Number(step.distance || 0), 0);
    const targetDistance = clamp(progress) * totalDistance;
    let covered = 0;
    let stepIndex = 0;
    for (let index = 0; index < steps.length; index += 1) {
      stepIndex = index;
      const distance = Number(steps[index].distance || 0);
      if (targetDistance <= covered + distance || index === steps.length - 1) break;
      covered += distance;
    }
    const step = steps[stepIndex];
    const remaining = Math.max(0, Number(step?.distance || 0) - Math.max(0, targetDistance - covered));
    const instruction = String(step?.instruction || "").replace(/行驶\s*\d+(?:\.\d+)?\s*(?:米|千米|公里)/g, "").trim();
    const maneuver = /掉头/.test(instruction) ? "uturn" : /左/.test(instruction) ? "left" : /右|出口|匝道/.test(instruction) ? "right" : /到达|目的地/.test(instruction) ? "arrive" : "straight";
    const roadName = String(step?.road || "").trim()
      || instruction.match(/(?:进入|沿|驶入)([^，。]+?)(?:后|行驶|靠|左转|右转|$)/)?.[1]
      || "";
    const totalDurationSeconds = Number(route?.time || 0);
    const trafficStatus = String(step?.tmcs?.find?.((item) => item?.status)?.status || "").trim() || "路况正常";
    return {
      instruction,
      maneuver,
      roadName,
      trafficStatus,
      nextDistanceMeters: remaining,
      nextDistance: remaining >= 1000
        ? { value: (remaining / 1000).toFixed(1), unit: "公里" }
        : { value: String(Math.max(50, Math.round(remaining / 10) * 10)), unit: "米" },
      totalDistanceMeters: totalDistance,
      totalDurationSeconds,
      remainingDurationSeconds: Math.max(0, Math.round(totalDurationSeconds * (1 - clamp(progress)))),
      remainingDistanceMeters: Math.max(0, totalDistance - targetDistance),
      stepIndex,
      stepCount: steps.length
    };
  }

  function currentMonth(now = new Date()) {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  function readUsage(storage = root?.localStorage) {
    const empty = { month: currentMonth(), mapLoads: 0, routePlans: 0, poiSearches: 0 };
    try {
      const stored = JSON.parse(storage?.getItem(USAGE_KEY) || "null");
      if (!stored || stored.month !== empty.month) return empty;
      return {
        month: empty.month,
        mapLoads: Math.max(0, Number(stored.mapLoads || 0)),
        routePlans: Math.max(0, Number(stored.routePlans || 0)),
        poiSearches: Math.max(0, Number(stored.poiSearches || 0))
      };
    } catch (_error) {
      return empty;
    }
  }

  function writeUsage(usage, storage = root?.localStorage) {
    try { storage?.setItem(USAGE_KEY, JSON.stringify(usage)); } catch (_error) { /* optional storage */ }
  }

  function usageLimits(config) {
    return {
      mapLoads: Math.max(1, Number(config.amapMonthlyMapLimit || DEFAULT_LIMITS.mapLoads)),
      routePlans: Math.max(1, Number(config.amapMonthlyRouteLimit || DEFAULT_LIMITS.routePlans)),
      poiSearches: Math.max(1, Number(config.amapMonthlyPoiLimit || DEFAULT_LIMITS.poiSearches))
    };
  }

  function recordUsage(type) {
    const usage = readUsage();
    usage[type] += 1;
    writeUsage(usage);
    return usage;
  }

  function loadAmap(config) {
    if (root.AMap) return Promise.resolve(root.AMap);
    if (loaderPromise) return loaderPromise;
    loaderPromise = new Promise((resolve, reject) => {
      const navigatorRef = root.navigator;
      const originalNavigatorDescriptors = {};
      const linuxWebglHint = config.amapPrefer3d !== false
        && runtimeSupportsWebgl()
        && /Linux/i.test(String(navigatorRef?.userAgent || ""));
      if (linuxWebglHint && navigatorRef) {
        try {
          ["userAgent", "platform"].forEach((key) => {
            originalNavigatorDescriptors[key] = Object.getOwnPropertyDescriptor(navigatorRef, key) || null;
          });
          const desktopUserAgent = String(navigatorRef.userAgent || "")
            .replace(/\([^)]*Linux[^)]*\)/i, "(Windows NT 10.0; Win64; x64)")
            .replace("HeadlessChrome", "Chrome");
          Object.defineProperty(navigatorRef, "userAgent", { configurable: true, get: () => desktopUserAgent });
          Object.defineProperty(navigatorRef, "platform", { configurable: true, get: () => "Win32" });
          loaderWebglHintApplied = true;
        } catch (_error) {
          loaderWebglHintApplied = false;
        }
      }
      const restoreNavigator = () => {
        if (!loaderWebglHintApplied || !navigatorRef) return;
        ["userAgent", "platform"].forEach((key) => {
          const descriptor = originalNavigatorDescriptors[key];
          try {
            if (descriptor) Object.defineProperty(navigatorRef, key, descriptor);
            else delete navigatorRef[key];
          } catch (_error) { /* optional compatibility hint cleanup */ }
        });
      };
      root._AMapSecurityConfig = config.amapServiceHost
        ? { serviceHost: String(config.amapServiceHost).replace(/\/$/, "") }
        : { securityJsCode: String(config.amapSecurityJsCode || "").trim() };
      const script = root.document.createElement("script");
      script.async = true;
      script.dataset.auriAmap = "true";
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.amapKey)}&plugin=AMap.Driving,AMap.MoveAnimation,AMap.PlaceSearch`;
      const timeoutMs = boundedScriptLoadTimeoutMs(config.amapLoadTimeoutMs);
      let settled = false;
      let timer = null;
      const finish = (callback, value, removeScript = false) => {
        if (settled) return;
        settled = true;
        if (timer !== null) root.clearTimeout(timer);
        restoreNavigator();
        script.onload = null;
        script.onerror = null;
        if (removeScript) script.remove?.();
        callback(value);
      };
      script.onload = () => root.AMap
        ? finish(resolve, root.AMap)
        : finish(reject, new Error("高德地图对象不可用"), true);
      script.onerror = () => finish(reject, new Error("高德地图加载失败"), true);
      timer = root.setTimeout(
        () => finish(reject, new Error(`高德地图加载超时（${timeoutMs}ms）`), true),
        timeoutMs
      );
      root.document.head.appendChild(script);
    }).catch((error) => {
      loaderPromise = null;
      throw error;
    });
    return loaderPromise;
  }

  function markerContent(className, label) {
    const element = root.document.createElement("div");
    element.className = className;
    const mark = root.document.createElement("i");
    const text = root.document.createElement("span");
    text.textContent = label;
    element.append(mark, text);
    return element;
  }

  class AuriAmapAdapter {
    constructor({ container, mapWrap, onStatus, onRouteMeta }) {
      this.container = container;
      this.mapWrap = mapWrap;
      this.onStatus = onStatus || (() => {});
      this.onRouteMeta = onRouteMeta || (() => {});
      this.status = "offline";
      this.map = null;
      this.config = null;
      this.routeKey = null;
      this.routePath = [];
      this.routeGeometry = null;
      this.drivingRoute = null;
      this.trafficVisible = true;
      this.overlays = {};
      this.lastSnapshot = null;
      this.lastProgress = null;
      this.lastStage = null;
      this.lastCameraHeading = null;
      this.lastCameraRotation = null;
      this.lastEffectiveRotation = null;
      this.lastCameraPitch = null;
      this.lastCameraZoom = null;
      this.lastAnimatedPoint = null;
      this.markerProgress = null;
      this.motionTargetProgress = null;
      this.pendingMotionProgress = null;
      this.motionActive = false;
      this.motionOverlapCount = 0;
      this.motionCompletedCount = 0;
      this.motionSequence = 0;
      this.motionFallbackTimer = null;
      this.lastMotionPlannedDurationMs = 0;
      this.lastRouteMetaKey = null;
      this.lastMetaProgress = null;
      this.cameraMode = "overview";
      this.native3d = null;
      this.pendingRouteKey = null;
      this.pendingRoutePromise = null;
      this.failedRouteKey = null;
      this.failedRouteReason = null;
      this.fixedVehicle = null;
      this.congestionDiagnostics = [];
      this.anchorDiagnostics = null;
      this.renderCompleteCount = 0;
      this.labelsReady = false;
      this.labelsReadyModes = new Set();
      this.pendingLabelMode = null;
      this.labelReadyTimer = null;
      this.poiRouteKey = null;
      this.poiSearchStatus = "idle";
    }

    async init(config) {
      this.config = config;
      if (config.mapProvider === "offline" || !config.amapKey) {
        this.fallback(config.mapProvider === "amap" ? "缺少高德地图配置" : "离线导航");
        return { mode: "offline" };
      }
      const usage = readUsage();
      const limits = usageLimits(config);
      if (usage.mapLoads >= limits.mapLoads) {
        this.fallback("已切换离线导航", "地图调用保护已启用");
        return { mode: "offline", reason: "usage_guard" };
      }
      this.onStatus({ mode: "loading", message: "正在连接高德地图", usage });
      try {
        const AMap = await loadAmap(config);
        const webglCapability = AMap.Browser?.isWebGL;
        const amapReportedWebgl = typeof webglCapability === "function"
          ? Boolean(webglCapability.call(AMap.Browser))
          : webglCapability === true;
        const runtimeWebgl = runtimeSupportsWebgl();
        this.container.hidden = false;
        recordUsage("mapLoads");
        this.mapWrap.dataset.webglReported = amapReportedWebgl ? "true" : "false";
        this.mapWrap.dataset.webglRuntime = runtimeWebgl ? "true" : "false";
        this.mapWrap.dataset.webglPromoted = loaderWebglHintApplied ? "true" : "false";
        const mapStyle = config.amapStyle || "amap://styles/normal";
        this.map = new AMap.Map(this.container, {
          center: config.amapStart || [120.791879, 31.334680],
          zoom: 16.8,
          viewMode: "3D",
          pitch: 52,
          rotation: 0,
          mapStyle,
          features: ["bg", "road", "building", "point"],
          labelRejectMask: true,
          isHotspot: true,
          showBuildingBlock: true,
          buildingAnimation: true,
          skyColor: "#e9eef5",
          showLabel: true,
          resizeEnable: true,
          rotateEnable: true,
          pitchEnable: true,
          jogEnable: false,
          animateEnable: false,
          dragEnable: true,
          zoomEnable: true,
          keyboardEnable: false,
          doubleClickZoom: true
        });
        this.map.on?.("complete", () => {
          this.renderCompleteCount += 1;
          if (this.pendingLabelMode) this.completeLabelMode(this.pendingLabelMode);
          else this.labelsReady = true;
        });
        const labelPaintPromise = waitForMapLabels(this.map);
        await waitForMapReady(this.map);
        // Keep road and POI labels visible beneath route overlays. Some AMap
        // runtimes restore their default feature set after the first render,
        // so enforce the navigation label contract once the map is ready.
        this.map.setFeatures?.(["bg", "road", "building", "point"]);
        this.map.setLabelRejectMask?.(true);
        this.map.setStatus?.({ showLabel: true });
        this.map.resize?.();
        const labelPaintedFromEvent = await labelPaintPromise;
        // AMap may complete synchronously on a warm tile cache before event
        // listeners can be attached. A real rendered map surface is the
        // fallback checkpoint; test doubles without a surface do not qualify.
        if (!labelPaintedFromEvent && hasRenderedMapSurface(this.container)) {
          this.renderCompleteCount = Math.max(1, this.renderCompleteCount);
          this.labelsReady = true;
        }
        this.map.setPitch?.(42, true, 0);
        this.map.setRotation?.(1, true, 0);
        await new Promise((resolve) => root.setTimeout?.(resolve, 80) ?? resolve());
        const effectivePitch = Number(this.map.getPitch?.() || 0);
        const effectiveRotation = Number(this.map.getRotation?.() || 0);
        this.native3d = amapReportedWebgl && effectivePitch >= 1;
        this.map.setRotation?.(0, true, 0);
        if (!this.native3d) this.map.setPitch?.(0, true, 0);
        this.lastEffectiveRotation = effectiveRotation;
        this.mapWrap.dataset.amap3d = this.native3d ? "native" : "overview-only";
        this.mapWrap.dataset.webglEffective = this.native3d ? "true" : "false";
        this.overlays.trafficLayer = new AMap.TileLayer.Traffic({ autoRefresh: true, interval: 180, opacity: 0.2, zIndex: 8 });
        this.map.add(this.overlays.trafficLayer);
        this.status = "map_ready";
        this.onStatus({ mode: "map_ready", message: "高德地图已连接", usage: readUsage() });
        return { mode: "map_ready" };
      } catch (error) {
        const reason = error?.message || String(error);
        this.fallback("已切换离线导航", reason);
        return { mode: "offline", reason };
      }
    }

    clearRoute() {
      const routeOverlays = Object.entries(this.overlays)
        .filter(([key]) => key !== "trafficLayer")
        .map(([, value]) => value)
        .flat()
        .filter(Boolean);
      if (routeOverlays.length) this.map?.remove?.(routeOverlays);
      const trafficLayer = this.overlays.trafficLayer;
      this.overlays = trafficLayer ? { trafficLayer } : {};
      this.routePath = [];
      this.routeGeometry = null;
      this.drivingRoute = null;
      this.lastProgress = null;
      this.lastAnimatedPoint = null;
      this.markerProgress = null;
      this.motionTargetProgress = null;
      this.pendingMotionProgress = null;
      this.motionActive = false;
      if (this.motionFallbackTimer !== null) root.clearTimeout?.(this.motionFallbackTimer);
      this.motionFallbackTimer = null;
      this.motionOverlapCount = 0;
      this.motionCompletedCount = 0;
      this.lastMotionPlannedDurationMs = 0;
      this.congestionDiagnostics = [];
      this.anchorDiagnostics = null;
      this.lastRouteMetaKey = null;
      this.lastMetaProgress = null;
      this.poiRouteKey = null;
      this.poiSearchStatus = "idle";
    }

    async setRoute(routeConfig, routeKey) {
      if (!this.map || !routeConfig?.start || !routeConfig?.end) return { mode: this.status, planned: false };
      if (this.routeKey === routeKey && this.routePath.length) return { mode: "online", planned: false };
      if (this.pendingRouteKey === routeKey && this.pendingRoutePromise) return this.pendingRoutePromise;
      if (this.failedRouteKey === routeKey) {
        return { mode: "offline", planned: false, reason: this.failedRouteReason || "route_failed" };
      }
      const usage = readUsage();
      if (usage.routePlans >= usageLimits(this.config).routePlans) {
        this.fallback("已切换离线导航", "路线调用保护已启用");
        return { mode: "offline", reason: "usage_guard" };
      }
      this.onStatus({ mode: "loading", message: "正在规划路线", usage });
      const AMap = root.AMap;
      this.pendingRouteKey = routeKey;
      this.pendingRoutePromise = (async () => {
        try {
          const route = await new Promise((resolve, reject) => {
            const timeoutMs = boundedRouteTimeoutMs(this.config?.amapRouteTimeoutMs);
            const driving = new AMap.Driving({ policy: AMap.DrivingPolicy?.LEAST_TIME ?? 0, extensions: "all", hideMarkers: true, showTraffic: true });
            let settled = false;
            let timer = null;
            const finish = (callback, value) => {
              if (settled) return;
              settled = true;
              if (timer !== null) root.clearTimeout(timer);
              callback(value);
            };
            timer = root.setTimeout(
              () => finish(reject, new Error(`高德路线规划超时（${timeoutMs}ms）`)),
              timeoutMs
            );
            recordUsage("routePlans");
            driving.search(routeConfig.start, routeConfig.end, (status, result) => {
              const candidate = result?.routes?.[0];
              const path = flattenDrivingPath(candidate);
              if (status !== "complete" || path.length < 2) finish(reject, new Error(result?.info || "高德路线规划失败"));
              else finish(resolve, { route: candidate, path });
            });
          });
          this.clearRoute();
          this.routeKey = routeKey;
          this.drivingRoute = route.route;
          this.routePath = route.path;
          this.routeGeometry = buildRouteGeometry(route.path);
          this.failedRouteKey = null;
          this.failedRouteReason = null;
          this.drawRoute(AMap, routeConfig);
          this.status = "online";
          this.container.hidden = false;
          this.mapWrap.classList.add("is-amap-online");
          this.map.resize?.();
          const meta = routeMeta(this.drivingRoute, 0);
          this.lastRouteMetaKey = `${meta.stepIndex}:${meta.nextDistance.value}:${meta.nextDistance.unit}`;
          this.onRouteMeta(meta);
          this.onStatus({ mode: "online", message: "高德导航", usage: readUsage() });
          if (this.lastSnapshot) this.update(this.lastSnapshot);
          return { mode: "online", planned: true };
        } catch (error) {
          this.failedRouteKey = routeKey;
          this.failedRouteReason = error?.message || String(error);
          this.fallback("已切换离线导航", this.failedRouteReason);
          return { mode: "offline", reason: error?.message || String(error) };
        } finally {
          if (this.pendingRouteKey === routeKey) {
            this.pendingRouteKey = null;
            this.pendingRoutePromise = null;
          }
        }
      })();
      return this.pendingRoutePromise;
    }

    drawRoute(AMap, routeConfig) {
      const common = { path: this.routePath, lineJoin: "round", lineCap: "round", borderWeight: 0, showDir: false };
      this.overlays.routeShadow = new AMap.Polyline({ ...common, strokeColor: "#ffffff", strokeOpacity: 0.96, strokeWeight: 22, zIndex: 45 });
      this.overlays.routeBase = new AMap.Polyline({ ...common, strokeColor: "#0b1b33", strokeOpacity: 0.2, strokeWeight: 16, zIndex: 46 });
      this.overlays.routeRemaining = new AMap.Polyline({ ...common, strokeColor: "#2f6bff", strokeOpacity: 1, strokeWeight: 11, zIndex: 48 });
      this.overlays.routePassed = new AMap.Polyline({ ...common, path: this.routePath.slice(0, 2), strokeColor: "#aab4be", strokeOpacity: 0, strokeWeight: 11, zIndex: 49 });
      this.overlays.routeTrafficSegments = flattenTrafficSegments(this.drivingRoute).map((segment) => new AMap.Polyline({
        ...common,
        path: segment.path,
        strokeColor: segment.color,
        strokeOpacity: 0.92,
        strokeWeight: 15,
        zIndex: 50
      }));
      this.overlays.routeCongestionBands = [
        ["#e6a700", 51],
        ["#d1495b", 52],
        ["#8f2032", 53]
      ].map(([strokeColor, zIndex]) => new AMap.Polyline({
        ...common,
        path: this.routePath.slice(0, 2),
        strokeColor,
        strokeOpacity: 0,
        strokeWeight: 15,
        zIndex
      }));

      const vehicle = root.document.createElement("div");
      vehicle.className = "auri-amap-vehicle";
      vehicle.innerHTML = '<span class="auri-amap-vehicle-ring"></span><i></i><b>AURI</b>';
      this.overlays.vehicleContent = vehicle;
      this.overlays.vehicleMarker = new AMap.Marker({ position: this.routePath[0], content: vehicle, anchor: "center", zIndex: 130 });
      this.overlays.vehicleMarker.on?.("moving", (event) => {
        const point = pointValue(event?.pos)
          || pointValue(event?.target?.getPosition?.())
          || pointValue(this.overlays.vehicleMarker?.getPosition?.());
        if (!point) return;
        const previous = this.lastAnimatedPoint;
        if (previous && (previous[0] !== point[0] || previous[1] !== point[1])) {
          this.setVehicleHeading(bearing(previous, point));
        }
        this.lastAnimatedPoint = point;
        if (!this.lastSnapshot?.stopped) this.mapWrap.dataset.vehicleMotion = "moving";
      });
      this.overlays.vehicleMarker.on?.("moveend", () => {
        this.completeMarkerMotion(false);
      });
      if (!this.fixedVehicle && this.mapWrap?.appendChild) {
        this.fixedVehicle = root.document.createElement("div");
        this.fixedVehicle.className = "auri-amap-fixed-vehicle";
        this.fixedVehicle.setAttribute("aria-hidden", "true");
        this.fixedVehicle.innerHTML = '<span></span><i></i><b>AURI</b>';
        this.mapWrap.appendChild(this.fixedVehicle);
      }
      this.overlays.originMarker = new AMap.Marker({ position: this.routePath[0], content: markerContent("auri-amap-origin", routeConfig.originName || "博世苏州"), anchor: "bottom-left", zIndex: 109 });
      this.overlays.destinationMarker = new AMap.Marker({ position: this.routePath.at(-1), content: markerContent("auri-amap-destination", routeConfig.destinationName || "目的地"), anchor: "bottom-center", zIndex: 110 });
      this.overlays.routeLabels = routeRoadLabels(this.drivingRoute).map(({ name, position }) => {
        const label = root.document.createElement("span");
        label.className = "auri-amap-route-label";
        label.textContent = name;
        const marker = new AMap.Marker({ position, content: label, anchor: "bottom-center", zIndex: 76 });
        marker.__auriRoadName = name;
        return marker;
      });
      this.overlays.currentRoadContent = root.document.createElement("span");
      this.overlays.currentRoadContent.className = "auri-amap-route-label is-current";
      this.overlays.currentRoadMarker = new AMap.Marker({
        position: this.routePath[0],
        content: this.overlays.currentRoadContent,
        anchor: "bottom-left",
        zIndex: 86
      });
      const incident = markerContent("auri-amap-incident", "前方拥堵");
      this.overlays.incidentContent = incident.querySelector("span");
      this.overlays.incidentMarker = new AMap.Marker({ position: this.routePath[Math.floor(this.routePath.length * 0.7)], content: incident, anchor: "top-center", zIndex: 120 });
      this.overlays.incidentMarker.hide();
      this.overlays.routeChevrons = [0, 1, 2].map((index) => {
        const chevron = root.document.createElement("div");
        chevron.className = `auri-amap-chevron is-${index + 1}`;
        chevron.setAttribute?.("aria-hidden", "true");
        const marker = new AMap.Marker({ position: this.routePath[0], content: chevron, anchor: "center", zIndex: 82 - index });
        marker.hide();
        return marker;
      });
      this.map.add([
        this.overlays.routeShadow,
        this.overlays.routeBase,
        this.overlays.routeRemaining,
        this.overlays.routePassed,
        ...this.overlays.routeTrafficSegments,
        ...this.overlays.routeCongestionBands,
        this.overlays.vehicleMarker,
        this.overlays.originMarker,
        this.overlays.destinationMarker,
        ...this.overlays.routeLabels,
        this.overlays.currentRoadMarker,
        this.overlays.incidentMarker,
        ...this.overlays.routeChevrons
      ]);
      this.applyOverviewCamera();
    }

    async loadNearbyPois(center, routeKey) {
      const AMap = root.AMap;
      if (!AMap?.PlaceSearch || !Array.isArray(center) || center.length < 2) return;
      if (this.poiRouteKey === routeKey) return;
      const usage = readUsage();
      if (usage.poiSearches >= usageLimits(this.config).poiSearches) {
        this.poiRouteKey = routeKey;
        this.poiSearchStatus = "usage_guard";
        return;
      }
      this.poiRouteKey = routeKey;
      this.poiSearchStatus = "loading";
      recordUsage("poiSearches");
      try {
        const pois = await new Promise((resolve, reject) => {
          const placeSearch = new AMap.PlaceSearch({
            city: "苏州",
            citylimit: true,
            type: "公司企业|科教文化服务|商务住宅|餐饮服务",
            pageSize: 10,
            pageIndex: 1,
            extensions: "base"
          });
          const timer = root.setTimeout?.(() => reject(new Error("高德周边地点加载超时")), 1600);
          placeSearch.searchNearBy("", center, 650, (status, result) => {
            if (timer !== null) root.clearTimeout?.(timer);
            if (status !== "complete") reject(new Error(result?.info || "高德周边地点加载失败"));
            else resolve(result?.poiList?.pois || []);
          });
        });
        if (this.routeKey !== routeKey) return;
        const seen = new Set();
        this.overlays.poiMarkers = pois.flatMap((poi, index) => {
          const name = String(poi?.name || "").trim();
          const position = pointValue(poi?.location);
          if (!name || seen.has(name) || !position?.every(Number.isFinite) || seen.size >= 10) return [];
          seen.add(name);
          const label = root.document.createElement("span");
          label.className = "auri-amap-poi-label";
          label.textContent = name;
          label.dataset.rank = String(1000 - index);
          const marker = new AMap.Marker({
            position,
            content: label,
            anchor: "bottom-center",
            zIndex: 96 - index
          });
          marker.__auriPosition = position;
          marker.__auriPoiName = name;
          marker.__auriRank = 1000 - index;
          return [marker];
        });
        if (this.overlays.poiMarkers.length) {
          this.map.add(this.overlays.poiMarkers);
          this.setPoiMarkersVisible(true);
        }
        this.poiSearchStatus = this.overlays.poiMarkers.length ? "ready" : "empty";
      } catch (_error) {
        if (this.routeKey === routeKey) this.poiSearchStatus = "failed";
      }
    }

    completeMarkerMotion(stopMarker) {
      if (!this.motionActive) return;
      if (this.motionFallbackTimer !== null) root.clearTimeout?.(this.motionFallbackTimer);
      this.motionFallbackTimer = null;
      this.motionActive = false;
      this.markerProgress = this.motionTargetProgress ?? this.markerProgress;
      this.motionCompletedCount += 1;
      if (stopMarker) this.overlays.vehicleMarker?.stopMove?.();
      this.mapWrap.dataset.vehicleMotion = this.lastSnapshot?.stopped ? "stopped" : "settled";
      const pendingProgress = this.pendingMotionProgress;
      this.pendingMotionProgress = null;
      if (
        Number.isFinite(pendingProgress)
        && pendingProgress > (this.markerProgress ?? -1)
        && this.lastSnapshot?.showVehicle
        && !this.lastSnapshot?.overview
        && !this.lastSnapshot?.stopped
      ) {
        this.startMarkerMotion(this.lastSnapshot, pendingProgress);
      }
    }

    startMarkerMotion(snapshot, progress) {
      if (this.motionActive || !this.routeGeometry || typeof this.overlays.vehicleMarker?.moveAlong !== "function") return;
      const startProgress = this.markerProgress ?? this.lastProgress ?? progress;
      const location = locationAtProgress(this.routeGeometry, progress);
      const motionPath = pathBetweenProgress(this.routeGeometry, startProgress, progress);
      const currentPosition = pointValue(this.overlays.vehicleMarker.getPosition?.());
      if (currentPosition && motionPath.length) motionPath[0] = currentPosition;
      this.lastAnimatedPoint = motionPath[0] || currentPosition;
      this.setVehicleHeading(motionPath.length > 1 ? bearing(motionPath[0], motionPath[1]) : location.heading);
      const totalDuration = Math.max(120, Number(snapshot.motionDurationMs || 640));
      const timedPath = buildTimedMotionPath(motionPath, totalDuration);
      this.lastMotionPlannedDurationMs = timedPath.reduce((sum, item) => sum + item.duration, 0);
      this.motionTargetProgress = progress;
      this.motionActive = true;
      const motionSequence = ++this.motionSequence;
      this.motionFallbackTimer = root.setTimeout?.(() => {
        if (!this.motionActive || motionSequence !== this.motionSequence) return;
        this.completeMarkerMotion(true);
      }, totalDuration + 80) ?? null;
      this.overlays.vehicleMarker.moveAlong(timedPath, { autoRotation: false });
      this.lastMotionMethod = "moveAlong";
    }

    applyOverviewCamera() {
      if (!this.map || !this.overlays.routeShadow) return;
      if (this.motionActive) {
        this.motionActive = false;
        if (this.motionFallbackTimer !== null) root.clearTimeout?.(this.motionFallbackTimer);
        this.motionFallbackTimer = null;
        this.overlays.vehicleMarker?.stopMove?.();
      }
      this.pendingMotionProgress = null;
      this.cameraMode = "overview";
      this.setPoiMarkersVisible(true);
      this.markLabelsPending("overview");
      this.mapWrap.dataset.cameraMode = "overview";
      this.map.setPitch?.(0, true, 0);
      this.map.setRotation?.(0, true, 0);
      this.map.setFitView?.(
        [this.overlays.routeShadow, this.overlays.originMarker, this.overlays.destinationMarker].filter(Boolean),
        true,
        [112, 88, 104, 88],
        16
      );
      this.lastCameraRotation = 0;
      this.lastEffectiveRotation = Number(this.map.getRotation?.() || 0);
      this.lastCameraPitch = 0;
      this.anchorDiagnostics = null;
    }

    alignFollowAnchor(location, anchorY, attempts = 1) {
      if (!location?.point || typeof this.map?.lngLatToContainer !== "function" || typeof this.map?.panBy !== "function") return;
      const before = pixelValue(this.map.lngLatToContainer(location.point));
      if (!before?.every(Number.isFinite)) return;
      const width = Math.max(1, Number(this.container?.clientWidth || this.mapWrap?.clientWidth || 1));
      const height = Math.max(1, Number(this.container?.clientHeight || this.mapWrap?.clientHeight || 1));
      const target = [width * 0.5, height * clamp(anchorY, 0.55, 0.82)];
      let projected = before;
      const pan = [0, 0];
      const gain = [1, 1];
      // Perspective projection means one pan pixel is not always one screen
      // pixel. Re-read the route point and close the error instead of relying
      // on a hard-coded screen offset.
      for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
        const residual = [target[0] - projected[0], target[1] - projected[1]];
        if (Math.hypot(residual[0], residual[1]) < 1) break;
        const requested = residual.map((value, axis) => value / Math.max(0.2, Math.min(4, Math.abs(gain[axis]))));
        this.map.panBy(requested[0], requested[1], 0);
        pan[0] += requested[0];
        pan[1] += requested[1];
        const next = pixelValue(this.map.lngLatToContainer(location.point));
        if (!next?.every(Number.isFinite)) break;
        requested.forEach((value, axis) => {
          if (Math.abs(value) >= 0.5) gain[axis] = (next[axis] - projected[axis]) / value || gain[axis];
        });
        projected = next;
      }
      this.anchorDiagnostics = {
        target,
        projected,
        pan,
        point: [...location.point],
        errorPx: Math.hypot(projected[0] - target[0], projected[1] - target[1])
      };
    }

    applyFollowCamera(snapshot, location, force = false) {
      if (!this.map || !location) return;
      const heading = Number(location.heading || 0);
      const rawDelta = this.lastCameraHeading === null ? 360 : Math.abs(heading - this.lastCameraHeading) % 360;
      const delta = Math.min(rawDelta, 360 - rawDelta);
      const attention = ["takeover_L2", "takeover_L3", "planning", "waiting_confirmation"].includes(snapshot.stage);
      const meta = routeMeta(this.drivingRoute, snapshot.progress);
      const cameraSpec = followCameraSpec(meta, attention);
      const progressOffset = this.routeGeometry.totalDistance > 0
        ? cameraSpec.lookAheadMeters / this.routeGeometry.totalDistance
        : 0;
      const lookAhead = locationAtProgress(this.routeGeometry, Math.min(1, Number(snapshot.progress || 0) + progressOffset));
      const targetRotation = ((360 - heading) % 360 + 360) % 360;
      const targetPitch = cameraSpec.pitch;
      const zoomChanged = this.lastCameraZoom === null || Math.abs(cameraSpec.zoom - this.lastCameraZoom) >= 0.05;
      const pitchChanged = this.lastCameraPitch === null || Math.abs(targetPitch - this.lastCameraPitch) >= 1;
      const rotationChanged = this.lastCameraRotation === null
        || Math.abs(((targetRotation - this.lastCameraRotation + 180) % 360) - 180) >= cameraSpec.rotationThreshold;
      this.cameraMode = "follow";
      this.setPoiMarkersVisible(true);
      this.markLabelsPending("follow");
      this.mapWrap.dataset.cameraMode = "follow";
      if (force || zoomChanged || typeof this.map.setCenter !== "function") {
        this.map.setZoomAndCenter(cameraSpec.zoom, lookAhead.point, true, 0);
      } else {
        this.map.setCenter(lookAhead.point, true, 0);
      }
      if (force || pitchChanged) {
        if (this.native3d) this.map.setPitch?.(targetPitch, true, 0);
        else this.map.setPitch?.(0, true, 0);
      }
      if (force || rotationChanged) this.map.setRotation?.(targetRotation, true, 0);
      if (force || delta >= cameraSpec.rotationThreshold || this.lastCameraHeading === null) {
        this.lastCameraHeading = heading;
      }
      this.lastCameraRotation = targetRotation;
      this.lastCameraPitch = this.native3d ? targetPitch : 0;
      this.lastCameraZoom = cameraSpec.zoom;
      this.lastEffectiveRotation = Number(this.map.getRotation?.() || 0);
      this.mapWrap.dataset.lockAnchorY = String(cameraSpec.anchorY);
      this.alignFollowAnchor(location, cameraSpec.anchorY, 2);
    }

    setVehicleHeading(heading) {
      const cameraRotation = Number(this.map?.getRotation?.() || 0);
      const markerAngle = screenHeading(heading, cameraRotation);
      this.overlays.vehicleContent?.style?.setProperty("--auri-vehicle-heading", `${markerAngle}deg`);
    }

    markLabelsPending(mode) {
      if (!mode || this.labelsReadyModes.has(mode) || this.pendingLabelMode === mode) return;
      this.pendingLabelMode = mode;
      this.labelsReady = false;
      this.mapWrap.dataset.labelsReady = "false";
      if (this.labelReadyTimer !== null) root.clearTimeout?.(this.labelReadyTimer);
      // AMap's map-level `complete` event is guaranteed for the initial load,
      // but not for every 3D camera update. Keep the previous map out of view
      // for a short settle window so the user never sees an unpainted vector
      // frame while the follow camera rebuilds labels and buildings.
      const settleMs = mode === "overview" ? 900 : 3200;
      this.labelReadyTimer = root.setTimeout?.(() => this.completeLabelMode(mode), settleMs) ?? null;
    }

    completeLabelMode(mode) {
      if (!mode || this.pendingLabelMode !== mode) return;
      if (this.labelReadyTimer !== null) root.clearTimeout?.(this.labelReadyTimer);
      this.labelReadyTimer = null;
      this.labelsReadyModes.add(mode);
      this.pendingLabelMode = null;
      this.labelsReady = true;
      this.mapWrap.dataset.labelsReady = "true";
    }

    updateChevrons(snapshot) {
      if (!this.overlays.routeChevrons || !this.routeGeometry) return;
      const visible = snapshot.showVehicle && !snapshot.overview;
      this.overlays.routeChevrons.forEach((marker, index) => {
        if (!visible) return marker.hide();
        const location = locationAtProgress(this.routeGeometry, Math.min(0.99, snapshot.progress + 0.008 + index * 0.008));
        marker.setPosition(location.point);
        marker.setAngle?.(screenHeading(location.heading, this.map?.getRotation?.() || 0));
        marker.show();
      });
    }

    update(snapshot) {
      this.lastSnapshot = snapshot;
      if (this.status !== "online" || !this.routeGeometry) return;
      const progress = clamp(snapshot.progress);
      const location = locationAtProgress(this.routeGeometry, progress);
      if (this.poiRouteKey !== this.routeKey && this.poiSearchStatus !== "loading") {
        void this.loadNearbyPois(location.point, this.routeKey);
      }
      const fallback = location.remaining.length > 1 ? location.remaining.slice(0, 2) : location.passed.slice(-2);
      this.overlays.routePassed.setOptions({ strokeOpacity: location.passed.length > 1 ? 1 : 0 });
      this.overlays.routePassed.setPath(location.passed.length > 1 ? location.passed : fallback);
      this.overlays.routeRemaining.setOptions({ strokeOpacity: location.remaining.length > 1 ? 1 : 0 });
      this.overlays.routeRemaining.setPath(location.remaining.length > 1 ? location.remaining : fallback);

      const riskActive = ["L2", "L3"].includes(snapshot.riskLevel);
      const completed = ["action_completed", "cooldown", "parked_review"].includes(snapshot.stage);
      // Keep all three traffic severities inside the short follow-camera
      // horizon: slow, congested, then severe congestion farther ahead.
      const congestionRanges = [[0.002, 0.014], [0.014, 0.03], [0.03, 0.052]];
      const congestionColors = ["#e6a700", "#d1495b", "#8f2032"];
      this.congestionDiagnostics = [];
      this.overlays.routeCongestionBands.forEach((band, index) => {
        const [startOffset, endOffset] = congestionRanges[index];
        const path = pathBetweenProgress(this.routeGeometry, Math.min(1, progress + startOffset), Math.min(1, progress + endOffset));
        const visible = riskActive && this.trafficVisible;
        band.setOptions({ strokeOpacity: visible ? 1 : 0 });
        band.setPath(riskActive && path.length > 1 ? path : fallback);
        this.congestionDiagnostics.push({ color: congestionColors[index], visible, pointCount: path.length });
      });
      this.overlays.routeTrafficSegments.forEach((segment) => segment.setOptions({ strokeOpacity: this.trafficVisible ? 0.92 : 0 }));
      if (riskActive) {
        this.overlays.incidentContent.textContent = snapshot.stopped
          ? `严重拥堵 · 已停车等待`
          : snapshot.lateMinutes ? `拥堵 · 晚到 ${snapshot.lateMinutes} 分钟` : "前方拥堵";
        this.overlays.incidentMarker.setPosition(locationAtProgress(this.routeGeometry, Math.min(1, progress + 0.04)).point);
        this.overlays.incidentMarker.show();
        this.overlays.trafficLayer.setOpacity(this.trafficVisible ? 0.5 : 0);
      } else {
        this.overlays.incidentMarker.hide();
        this.overlays.trafficLayer.setOpacity(this.trafficVisible ? (snapshot.driving ? 0.3 : 0.16) : 0);
      }

      const stageChanged = snapshot.stage !== this.lastStage;
      const progressChanged = this.lastProgress === null || Math.abs(progress - this.lastProgress) >= 0.00005;
      const overviewMode = snapshot.overview || !this.native3d;
      if (overviewMode) {
        if (stageChanged || this.cameraMode !== "overview") this.applyOverviewCamera();
      } else if (stageChanged || progressChanged || this.cameraMode !== "follow") {
        this.applyFollowCamera(snapshot, location, stageChanged || this.cameraMode !== "follow");
      }

      if (snapshot.showVehicle) {
        if (overviewMode) this.overlays.vehicleMarker.show();
        else this.overlays.vehicleMarker.hide();
        this.mapWrap.dataset.vehicleVisible = "true";
        this.mapWrap.dataset.vehicleMotion = snapshot.stopped ? "stopped" : this.motionActive ? "moving" : "settled";
        if (overviewMode) {
          if (this.motionActive) this.overlays.vehicleMarker.stopMove?.();
          this.motionActive = false;
          if (this.motionFallbackTimer !== null) root.clearTimeout?.(this.motionFallbackTimer);
          this.motionFallbackTimer = null;
          this.pendingMotionProgress = null;
          this.setVehicleHeading(location.heading);
          this.overlays.vehicleMarker.setPosition(location.point);
          this.lastAnimatedPoint = location.point;
          this.markerProgress = progress;
          this.lastMotionMethod = "position";
          this.mapWrap.dataset.vehicleMotion = snapshot.stopped ? "stopped" : "settled";
        } else if (snapshot.stopped) {
          if (this.motionActive) {
            this.motionActive = false;
            if (this.motionFallbackTimer !== null) root.clearTimeout?.(this.motionFallbackTimer);
            this.motionFallbackTimer = null;
            this.overlays.vehicleMarker.stopMove?.();
          }
          this.pendingMotionProgress = null;
          this.setVehicleHeading(location.heading);
          this.overlays.vehicleMarker.setPosition(location.point);
          this.lastAnimatedPoint = location.point;
          this.markerProgress = progress;
          this.lastMotionMethod = "position";
          this.mapWrap.dataset.vehicleMotion = "stopped";
        } else if (this.lastProgress !== null && progressChanged && progress > this.lastProgress && typeof this.overlays.vehicleMarker.moveAlong === "function") {
          if (this.motionActive) this.pendingMotionProgress = Math.max(this.pendingMotionProgress ?? 0, progress);
          else this.startMarkerMotion(snapshot, progress);
        } else if (this.lastProgress !== null && progressChanged && typeof this.overlays.vehicleMarker.moveTo === "function") {
          if (this.motionActive) this.overlays.vehicleMarker.stopMove?.();
          this.motionActive = false;
          this.setVehicleHeading(location.heading);
          this.overlays.vehicleMarker.moveTo(location.point, { duration: Math.min(240, Number(snapshot.motionDurationMs || 640)), autoRotation: false });
          this.lastAnimatedPoint = location.point;
          this.markerProgress = progress;
          this.lastMotionMethod = "moveTo";
        } else if (this.lastProgress === null) {
          this.setVehicleHeading(location.heading);
          this.overlays.vehicleMarker.setPosition(location.point);
          this.lastAnimatedPoint = location.point;
          this.markerProgress = progress;
        } else if (!progressChanged) this.setVehicleHeading(location.heading);
      } else {
        this.overlays.vehicleMarker.hide();
        this.mapWrap.dataset.vehicleVisible = "false";
        this.mapWrap.dataset.vehicleMotion = "hidden";
      }
      if (overviewMode) this.overlays.originMarker.show();
      else this.overlays.originMarker.hide();

      this.updateChevrons({ ...snapshot, overview: overviewMode });
      const meta = routeMeta(this.drivingRoute, progress);
      this.overlays.routeLabels.forEach((marker) => {
        if (marker.__auriRoadName === meta.roadName) marker.hide();
        else marker.show();
      });
      if (meta.roadName) {
        this.overlays.currentRoadContent.textContent = meta.roadName;
        this.overlays.currentRoadMarker.setPosition(locationAtProgress(this.routeGeometry, Math.min(1, progress + 0.012)).point);
        this.overlays.currentRoadMarker.show();
      } else {
        this.overlays.currentRoadMarker.hide();
      }
      const key = `${meta.stepIndex}:${meta.nextDistance.value}:${meta.nextDistance.unit}`;
      if (meta.instruction && (key !== this.lastRouteMetaKey || Math.abs(progress - (this.lastMetaProgress ?? -1)) >= 0.002)) {
        this.lastRouteMetaKey = key;
        this.lastMetaProgress = progress;
        this.onRouteMeta(meta);
      }
      this.lastProgress = progress;
      this.lastStage = snapshot.stage;
    }

    control(action) {
      if (this.status !== "online" || !this.map) return false;
      if (action === "zoom-in") this.map.zoomIn();
      else if (action === "zoom-out") this.map.zoomOut();
      else if (action === "overview") this.applyOverviewCamera();
      else if (action === "traffic") {
        this.trafficVisible = !this.trafficVisible;
        if (this.lastSnapshot) this.update(this.lastSnapshot);
      }
      else if (action === "follow" && this.native3d && this.lastSnapshot && this.routeGeometry) {
        this.applyFollowCamera(this.lastSnapshot, locationAtProgress(this.routeGeometry, this.lastSnapshot.progress), true);
      } else return false;
      return true;
    }

    clearNavigation(message = "等待手机同步路线") {
      this.clearRoute();
      this.routeKey = null;
      this.lastSnapshot = null;
      this.lastStage = null;
      this.fallback(message);
    }

    fallback(message, detail = null) {
      this.status = "offline";
      if (this.motionFallbackTimer !== null) root.clearTimeout?.(this.motionFallbackTimer);
      this.motionFallbackTimer = null;
      this.overlays.vehicleMarker?.stopMove?.();
      this.motionActive = false;
      this.pendingMotionProgress = null;
      this.mapWrap.dataset.vehicleVisible = "false";
      this.mapWrap.dataset.vehicleMotion = "hidden";
      this.container.hidden = true;
      this.mapWrap.classList.remove("is-amap-online");
      this.onStatus({ mode: "offline", message, detail, usage: readUsage() });
    }

    getStatus() { return this.status; }
    setPoiMarkersVisible(visible) {
      (this.overlays.poiMarkers || []).forEach((marker) => {
        marker.__auriVisible = Boolean(visible);
        if (visible) marker.show?.();
        else marker.hide?.();
      });
    }
    countVisiblePoiLabels() {
      const width = Number(this.mapWrap?.clientWidth || 0);
      const height = Number(this.mapWrap?.clientHeight || 0);
      if (!width || !height || typeof this.map?.lngLatToContainer !== "function") return 0;
      return (this.overlays.poiMarkers || []).filter((marker) => {
        if (marker.__auriVisible === false) return false;
        const position = pointValue(marker.getPosition?.()) || marker.__auriPosition;
        if (!position?.every(Number.isFinite)) return false;
        const pixel = this.map.lngLatToContainer(position);
        const x = Number(pixel?.x ?? pixel?.getX?.());
        const y = Number(pixel?.y ?? pixel?.getY?.());
        return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= width && y >= 0 && y <= height;
      }).length;
    }
    getLabelDiagnostics() {
      const status = this.map?.getStatus?.() || {};
      const features = this.map?.getFeatures?.() || this.map?.options?.features || [];
      return {
        showLabel: status.showLabel ?? this.map?.options?.showLabel ?? null,
        labelRejectMask: this.map?.labelRejectMask ?? this.map?.options?.labelRejectMask ?? null,
        features: Array.from(features),
        routeLabelCount: this.overlays.routeLabels?.length || 0,
        renderCompleteCount: this.renderCompleteCount,
        labelsReady: this.labelsReady,
        labelsReadyModes: Array.from(this.labelsReadyModes),
        poiLabelCount: this.overlays.poiMarkers?.length || 0,
        poiVisibleCount: this.countVisiblePoiLabels(),
        poiSearchStatus: this.poiSearchStatus
      };
    }
    getUsage() { return readUsage(); }
    getCameraMode() { return this.cameraMode; }
    isTrafficVisible() { return this.trafficVisible; }
    getCameraHeading() { return this.lastCameraHeading; }
    getCameraPitch() { return this.native3d === false ? this.lastCameraPitch : this.map?.getPitch?.() ?? null; }
    getCameraRotation() { return this.map?.getRotation?.() ?? null; }
    getRequestedCameraRotation() { return this.lastCameraRotation; }
    get3dMode() { return this.native3d === false ? "overview-only" : "native"; }
    getMotionMethod() { return this.lastMotionMethod || "position"; }
    getCongestionDiagnostics() { return this.congestionDiagnostics.map((item) => ({ ...item })); }
    getAnchorDiagnostics() { return this.anchorDiagnostics ? { ...this.anchorDiagnostics } : null; }
    getMotionDiagnostics() {
      return {
        active: this.motionActive,
        overlapCount: this.motionOverlapCount,
        completedCount: this.motionCompletedCount,
        plannedDurationMs: this.lastMotionPlannedDurationMs,
        markerProgress: this.markerProgress,
        targetProgress: this.motionTargetProgress,
        pendingProgress: this.pendingMotionProgress
      };
    }
  }

  return {
    MAX_FAILURE_FALLBACK_MS,
    DEFAULT_SCRIPT_LOAD_TIMEOUT_MS,
    MAX_SCRIPT_LOAD_TIMEOUT_MS,
    DEFAULT_ROUTE_TIMEOUT_MS,
    MAX_ROUTE_TIMEOUT_MS,
    USAGE_KEY,
    bearing,
    boundedTimeoutMs,
    boundedScriptLoadTimeoutMs,
    boundedRouteTimeoutMs,
    buildTimedMotionPath,
    buildRouteGeometry,
    create(options) { return new AuriAmapAdapter(options); },
    flattenDrivingPath,
    flattenTrafficSegments,
    followCameraSpec,
    locationAtProgress,
    pathBetweenProgress,
    routeOverviewCamera,
    routeMeta,
    routeRoadLabels,
    waitForMapLabels,
    runtimeSupportsWebgl,
    screenHeading,
    trafficColor
  };
});
