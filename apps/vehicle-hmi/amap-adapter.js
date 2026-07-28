(function () {
  "use strict";

  const DEFAULT_ROUTE = {
    start: [121.5758, 31.2169],
    end: [121.6098, 31.2356],
    destinationName: "阳光小学"
  };
  const AMAP_USAGE_KEY = "auri-amap-usage";
  const DEFAULT_MONTHLY_LIMITS = {
    mapLoads: 200,
    routePlans: 200
  };

  let loaderPromise = null;

  function cleanServiceHost(value) {
    return String(value || "").trim().replace(/\/$/, "");
  }

  function loadAmap(config) {
    if (window.AMap) return Promise.resolve(window.AMap);
    if (loaderPromise) return loaderPromise;

    loaderPromise = new Promise((resolve, reject) => {
      const serviceHost = cleanServiceHost(config.amapServiceHost);
      window._AMapSecurityConfig = serviceHost
        ? { serviceHost }
        : { securityJsCode: String(config.amapSecurityJsCode || "").trim() };

      const script = document.createElement("script");
      script.async = true;
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.amapKey)}&plugin=AMap.Driving,AMap.MoveAnimation`;
      script.dataset.auriAmap = "true";
      script.onload = () => {
        if (window.AMap) resolve(window.AMap);
        else reject(new Error("高德 JS API 已加载，但 AMap 对象不可用"));
      };
      script.onerror = () => reject(new Error("高德 JS API 加载失败"));
      document.head.appendChild(script);
    });

    return loaderPromise;
  }

  function pointValue(point) {
    if (!point) return null;
    if (Array.isArray(point)) return [Number(point[0]), Number(point[1])];
    if (typeof point.getLng === "function") return [point.getLng(), point.getLat()];
    if ("lng" in point && "lat" in point) return [Number(point.lng), Number(point.lat)];
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
    const cumulative = [0];
    for (let index = 1; index < path.length; index += 1) {
      cumulative.push(cumulative[index - 1] + distanceMeters(path[index - 1], path[index]));
    }
    return {
      path,
      cumulative,
      totalDistance: cumulative[cumulative.length - 1] || 0
    };
  }

  function appendUnique(path, point) {
    const previous = path[path.length - 1];
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) path.push(point);
  }

  function locationAtProgress(geometry, progress) {
    const normalized = Math.max(0, Math.min(1, Number(progress || 0)));
    const targetDistance = geometry.totalDistance * normalized;
    let afterIndex = geometry.cumulative.findIndex((distance) => distance >= targetDistance);
    if (afterIndex < 0) afterIndex = geometry.path.length - 1;
    const beforeIndex = Math.max(0, afterIndex - 1);
    const from = geometry.path[beforeIndex];
    const to = geometry.path[afterIndex] || from;
    const segmentStart = geometry.cumulative[beforeIndex] || 0;
    const segmentLength = Math.max(0, (geometry.cumulative[afterIndex] || segmentStart) - segmentStart);
    const ratio = segmentLength > 0 ? (targetDistance - segmentStart) / segmentLength : 0;
    const point = [
      from[0] + (to[0] - from[0]) * ratio,
      from[1] + (to[1] - from[1]) * ratio
    ];
    const passed = geometry.path.slice(0, beforeIndex + 1);
    appendUnique(passed, point);
    const remaining = [point];
    geometry.path.slice(afterIndex).forEach((pathPoint) => appendUnique(remaining, pathPoint));
    return {
      point,
      passed,
      remaining,
      heading: bearing(from, to),
      beforeIndex,
      afterIndex
    };
  }

  function pathBetweenProgress(geometry, startProgress, endProgress) {
    const start = locationAtProgress(geometry, startProgress);
    const end = locationAtProgress(geometry, endProgress);
    const path = [start.point];
    for (let index = start.afterIndex; index <= end.beforeIndex; index += 1) {
      appendUnique(path, geometry.path[index]);
    }
    appendUnique(path, end.point);
    return path;
  }

  function currentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  function readUsage() {
    const empty = { month: currentMonth(), mapLoads: 0, routePlans: 0 };
    try {
      const stored = JSON.parse(window.localStorage?.getItem(AMAP_USAGE_KEY) || "null");
      if (!stored || stored.month !== empty.month) return empty;
      return {
        month: empty.month,
        mapLoads: Math.max(0, Number(stored.mapLoads || 0)),
        routePlans: Math.max(0, Number(stored.routePlans || 0))
      };
    } catch {
      return empty;
    }
  }

  function writeUsage(usage) {
    try {
      window.localStorage?.setItem(AMAP_USAGE_KEY, JSON.stringify(usage));
    } catch {
      // Storage can be unavailable in private browser contexts; map usage still works.
    }
  }

  function usageLimits(config) {
    return {
      mapLoads: Math.max(1, Number(config.amapMonthlyMapLimit || DEFAULT_MONTHLY_LIMITS.mapLoads)),
      routePlans: Math.max(1, Number(config.amapMonthlyRouteLimit || DEFAULT_MONTHLY_LIMITS.routePlans))
    };
  }

  function recordUsage(type) {
    const usage = readUsage();
    usage[type] += 1;
    writeUsage(usage);
    return usage;
  }

  function routeMeta(route, progress = 0) {
    const steps = (route?.steps || []).filter((step) => step?.instruction);
    const totalDistance = Number(route?.distance || 0)
      || steps.reduce((sum, step) => sum + Number(step.distance || 0), 0);
    const targetDistance = Math.max(0, Math.min(1, progress)) * totalDistance;
    let coveredDistance = 0;
    let stepIndex = 0;
    for (let index = 0; index < steps.length; index += 1) {
      stepIndex = index;
      const distance = Number(steps[index].distance || 0);
      if (targetDistance <= coveredDistance + distance || index === steps.length - 1) break;
      coveredDistance += distance;
    }
    const step = steps[stepIndex];
    const stepDistance = Number(step?.distance || 0);
    const remainingDistance = Math.max(0, stepDistance - Math.max(0, targetDistance - coveredDistance));
    return {
      instruction: String(step?.instruction || "").replace(/行驶\s*\d+(?:\.\d+)?\s*(?:米|千米|公里)/g, "").trim(),
      nextDistance: remainingDistance >= 1000
        ? { value: (remainingDistance / 1000).toFixed(1), unit: "公里" }
        : { value: String(Math.max(50, Math.round(remainingDistance / 10) * 10)), unit: "米" },
      totalDistanceMeters: totalDistance,
      totalDurationSeconds: Number(route?.time || 0),
      stepIndex
    };
  }

  class AuriAmapAdapter {
    constructor({ container, mapWrap, onStatus, onRouteMeta }) {
      this.container = container;
      this.mapWrap = mapWrap;
      this.onStatus = onStatus || (() => {});
      this.onRouteMeta = onRouteMeta || (() => {});
      this.status = "offline";
      this.map = null;
      this.routePath = [];
      this.routeGeometry = null;
      this.lastSnapshot = null;
      this.lastProgress = null;
      this.lastStage = null;
      this.lastRouteMetaKey = null;
      this.drivingRoute = null;
      this.overlays = {};
    }

    async init(config) {
      const provider = config.mapProvider || "auto";
      if (provider === "offline" || !config.amapKey) {
        const message = provider === "amap" ? "未填写高德 Web JS API Key" : "离线演示地图";
        this.fallback(message);
        return { mode: "offline", reason: message };
      }
      const usage = readUsage();
      const limits = usageLimits(config);
      if (usage.mapLoads >= limits.mapLoads || usage.routePlans >= limits.routePlans) {
        const message = `本浏览器 ${usage.month} 高德 Demo 调用保护已触发`;
        this.fallback(message);
        return { mode: "offline", reason: message };
      }

      this.onStatus({ mode: "loading", message: "正在加载高德在线地图", usage });
      try {
        const AMap = await loadAmap(config);
        const routeConfig = config.amapRoute || DEFAULT_ROUTE;
        this.container.hidden = false;
        recordUsage("mapLoads");
        this.createMap(AMap, config, routeConfig);
        await this.planRoute(AMap, routeConfig, config);
        this.status = "online";
        this.mapWrap.classList.add("is-amap-online");
        this.onStatus({ mode: "online", message: "高德在线地图已连接", usage: readUsage() });
        if (this.lastSnapshot) this.update(this.lastSnapshot);
        return { mode: "online" };
      } catch (error) {
        this.fallback(error?.message || "高德在线地图不可用");
        return { mode: "offline", reason: error?.message || String(error) };
      }
    }

    createMap(AMap, config, routeConfig) {
      this.map = new AMap.Map(this.container, {
        center: routeConfig.start,
        zoom: 15,
        viewMode: "3D",
        pitch: 30,
        mapStyle: config.amapStyle || "amap://styles/whitesmoke",
        features: ["bg", "road", "building"],
        showLabel: true,
        resizeEnable: true,
        rotateEnable: false,
        pitchEnable: false,
        dragEnable: true,
        zoomEnable: true
      });
      this.overlays.trafficLayer = new AMap.TileLayer.Traffic({
        autoRefresh: true,
        interval: 180,
        opacity: 0.28,
        zIndex: 8
      });
      this.map.add(this.overlays.trafficLayer);
    }

    planRoute(AMap, routeConfig, config) {
      return new Promise((resolve, reject) => {
        const usage = readUsage();
        if (usage.routePlans >= usageLimits(config).routePlans) {
          reject(new Error(`本浏览器 ${usage.month} 驾车路线调用保护已触发`));
          return;
        }
        const driving = new AMap.Driving({
          policy: AMap.DrivingPolicy?.LEAST_TIME ?? 0,
          extensions: "all",
          hideMarkers: true,
          showTraffic: true
        });
        recordUsage("routePlans");
        driving.search(routeConfig.start, routeConfig.end, (status, result) => {
          const route = result?.routes?.[0];
          const path = flattenDrivingPath(route);
          if (status !== "complete" || path.length < 2) {
            reject(new Error(result?.info || "高德驾车路线规划失败"));
            return;
          }
          this.drivingRoute = route;
          this.routePath = path;
          this.routeGeometry = buildRouteGeometry(path);
          this.drawRoute(AMap, routeConfig);
          const meta = routeMeta(route);
          this.lastRouteMetaKey = `${meta.stepIndex}:${meta.nextDistance.value}:${meta.nextDistance.unit}`;
          this.onRouteMeta(meta);
          resolve(route);
        });
      });
    }

    drawRoute(AMap, routeConfig) {
      const common = {
        path: this.routePath,
        lineJoin: "round",
        lineCap: "round",
        borderWeight: 0,
        showDir: false
      };
      this.overlays.routeShadow = new AMap.Polyline({
        ...common,
        strokeColor: "#ffffff",
        strokeOpacity: 0.95,
        strokeWeight: 18,
        zIndex: 45
      });
      this.overlays.routeBase = new AMap.Polyline({
        ...common,
        strokeColor: "#aab8c3",
        strokeOpacity: 0.9,
        strokeWeight: 11,
        zIndex: 46
      });
      this.overlays.routeRemaining = new AMap.Polyline({
        ...common,
        showDir: true,
        dirColor: "#ffffff",
        strokeColor: "#2f6bff",
        strokeOpacity: 1,
        strokeWeight: 11,
        zIndex: 48
      });
      this.overlays.routePassed = new AMap.Polyline({
        ...common,
        path: [],
        strokeColor: "#8799a6",
        strokeOpacity: 1,
        strokeWeight: 11,
        zIndex: 49
      });
      this.overlays.routeIncident = new AMap.Polyline({
        ...common,
        path: [],
        strokeColor: "#e6a700",
        strokeOpacity: 1,
        strokeWeight: 12,
        zIndex: 51
      });

      const vehicle = document.createElement("div");
      vehicle.className = "amap-vehicle-marker";
      vehicle.innerHTML = "<i></i>";
      this.overlays.vehicleMarker = new AMap.Marker({
        position: this.routePath[0],
        content: vehicle,
        anchor: "center",
        zIndex: 130
      });

      const destination = document.createElement("div");
      destination.className = "amap-destination-marker";
      destination.innerHTML = `<i></i><span>${routeConfig.destinationName || "目的地"}</span>`;
      this.overlays.destinationMarker = new AMap.Marker({
        position: this.routePath[this.routePath.length - 1],
        content: destination,
        anchor: "bottom-center",
        zIndex: 110
      });

      const incident = document.createElement("div");
      incident.className = "amap-incident-marker";
      incident.textContent = "前方拥堵";
      this.overlays.incidentContent = incident;
      this.overlays.incidentMarker = new AMap.Marker({
        position: this.routePath[Math.floor(this.routePath.length * 0.72)],
        content: incident,
        anchor: "top-center",
        zIndex: 120
      });
      this.overlays.incidentMarker.hide();

      this.map.add([
        this.overlays.routeShadow,
        this.overlays.routeBase,
        this.overlays.routeRemaining,
        this.overlays.routePassed,
        this.overlays.routeIncident,
        this.overlays.vehicleMarker,
        this.overlays.destinationMarker,
        this.overlays.incidentMarker
      ]);
      this.map.setFitView(
        [this.overlays.routeShadow, this.overlays.destinationMarker],
        false,
        [90, 120, 150, 90],
        16
      );
    }

    update(snapshot) {
      this.lastSnapshot = snapshot;
      if (this.status !== "online" || !this.routePath.length) return;

      const progress = Math.max(0, Math.min(1, Number(snapshot.progress || 0)));
      const meta = routeMeta(this.drivingRoute, progress);
      const routeMetaKey = `${meta.stepIndex}:${meta.nextDistance.value}:${meta.nextDistance.unit}`;
      if (meta.instruction && routeMetaKey !== this.lastRouteMetaKey) {
        this.lastRouteMetaKey = routeMetaKey;
        this.onRouteMeta(meta);
      }
      const location = locationAtProgress(this.routeGeometry, progress);
      this.overlays.routePassed.setPath(location.passed.length > 1 ? location.passed : []);
      this.overlays.routeRemaining.setPath(location.remaining.length > 1 ? location.remaining : []);

      const riskActive = snapshot.riskLevel === "L2"
        || snapshot.riskLevel === "L3"
        || ["alert", "takeover"].includes(snapshot.mapStage);
      const completed = ["action_completed", "cooldown", "parked_review"].includes(snapshot.stage);
      const incidentEndProgress = Math.min(1, progress + 0.18);
      const incidentEnd = locationAtProgress(this.routeGeometry, incidentEndProgress);
      const incidentPath = pathBetweenProgress(this.routeGeometry, progress, incidentEndProgress);
      this.overlays.routeIncident.setOptions({
        strokeColor: completed ? "#2e9d6f" : "#e6a700",
        strokeOpacity: riskActive || completed ? 1 : 0
      });
      this.overlays.routeIncident.setPath(riskActive || completed ? incidentPath : []);

      if (riskActive) {
        this.overlays.incidentContent.textContent = `拥堵 · 晚到 ${snapshot.lateMinutes || 18} 分钟`;
        const incidentLabel = locationAtProgress(
          this.routeGeometry,
          Math.min(1, progress + (incidentEndProgress - progress) * 0.52)
        );
        this.overlays.incidentMarker.setPosition(incidentLabel.point);
        this.overlays.incidentMarker.show();
        this.overlays.trafficLayer.setOpacity(0.48);
      } else {
        this.overlays.incidentMarker.hide();
        this.overlays.trafficLayer.setOpacity(snapshot.driving ? 0.28 : 0.16);
      }

      if (snapshot.showVehicle) {
        this.overlays.vehicleMarker.show();
        const target = location.point;
        this.overlays.vehicleMarker.setAngle(location.heading);
        if (this.lastProgress !== null && typeof this.overlays.vehicleMarker.moveTo === "function") {
          this.overlays.vehicleMarker.moveTo(target, { duration: 850, autoRotation: false });
        } else {
          this.overlays.vehicleMarker.setPosition(target);
        }
      } else {
        this.overlays.vehicleMarker.hide();
      }

      if (snapshot.mapStage !== this.lastStage || Math.abs(progress - (this.lastProgress ?? progress)) > 0.08) {
        if (["overview", "preview"].includes(snapshot.mapStage)) {
          this.map.setFitView(
            [this.overlays.routeShadow, this.overlays.destinationMarker],
            false,
            [90, 120, 150, 90],
            16
          );
        } else {
          const zoom = ["alert", "takeover"].includes(snapshot.mapStage) ? 15.8 : 15.5;
          const center = locationAtProgress(this.routeGeometry, Math.min(1, progress + 0.055)).point;
          this.map.setZoomAndCenter(zoom, center, false, 650);
        }
      }

      this.lastProgress = progress;
      this.lastStage = snapshot.mapStage;
    }

    control(action) {
      if (this.status !== "online" || !this.map) return false;
      if (action === "zoom-in") this.map.zoomIn();
      else if (action === "zoom-out") this.map.zoomOut();
      else if (action === "reset") {
        this.map.setFitView(
          [this.overlays.routeShadow, this.overlays.destinationMarker],
          false,
          [90, 120, 150, 90],
          16
        );
      } else return false;
      return true;
    }

    fallback(message) {
      this.status = "offline";
      this.container.hidden = true;
      this.mapWrap.classList.remove("is-amap-online");
      this.onStatus({ mode: "offline", message, usage: readUsage() });
    }

    getStatus() {
      return this.status;
    }

    getUsage() {
      return readUsage();
    }
  }

  window.AuriAmapAdapter = {
    create(options) {
      return new AuriAmapAdapter(options);
    }
  };
})();
