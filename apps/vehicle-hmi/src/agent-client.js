(function initAuriAgentClient(root, factory) {
  const api = factory(root?.AuriWorldStateModel);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AuriAgentClient = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createAgentClientModule(worldStateModel) {
  "use strict";

  const STORAGE_KEY = "auri-hmi-next-config";
  const SHARED_STORAGE_KEY = "auri-shared-agent-config-v1";
  const PRIMARY_AGENT_API = "https://auri-agent-api.onrender.com";
  const BACKUP_AGENT_API = "https://auri-langchain-agent-api.onrender.com";
  const GET_RETRY_DELAYS_MS = [0, 900, 2200];
  const DEFAULT_CONFIG = {
    apiBase: PRIMARY_AGENT_API,
    token: "",
    stream: true,
    pollIntervalMs: 3000,
    streamPollIntervalMs: 15000,
    requestTimeoutMs: 45000,
    mapProvider: "auto",
    amapKey: "",
    amapSecurityJsCode: "",
    amapServiceHost: "",
    amapStyle: "amap://styles/normal",
    amapLoadTimeoutMs: 12000,
    amapRouteTimeoutMs: 8000,
    amapMonthlyMapLimit: 200,
    amapMonthlyRouteLimit: 200
  };

  function safeStorageGet(storage, key) {
    try {
      const raw = storage?.getItem(key);
      return raw ? JSON.parse(raw) : {};
    } catch (_error) {
      return {};
    }
  }

  function safeStorageSet(storage, key, value) {
    try {
      storage?.setItem(key, JSON.stringify(value));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function normalizeUrl(value, fallback) {
    const raw = String(value || fallback || "").trim().replace(/\/$/, "");
    try {
      const url = new URL(raw);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
      return url.toString().replace(/\/$/, "");
    } catch (_error) {
      return String(fallback || DEFAULT_CONFIG.apiBase).replace(/\/$/, "");
    }
  }

  function clampInteger(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
  }

  function normalizeOptionalUrl(value) {
    const raw = String(value || "").trim().replace(/\/$/, "");
    if (!raw) return "";
    try {
      const url = new URL(raw);
      return ["http:", "https:"].includes(url.protocol) ? url.toString().replace(/\/$/, "") : "";
    } catch (_error) {
      return "";
    }
  }

  function normalizeStreamUrl(value, apiBase) {
    const fallback = `${apiBase}/v1/stream`;
    const candidate = normalizeUrl(value || fallback, fallback);
    try {
      return new URL(candidate).origin === new URL(apiBase).origin ? candidate : fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function normalizeConfig(raw = {}) {
    const apiBase = normalizeUrl(raw.apiBase, DEFAULT_CONFIG.apiBase);
    return {
      apiBase,
      streamUrl: normalizeStreamUrl(raw.streamUrl, apiBase),
      token: String(raw.token || "").trim(),
      stream: raw.stream !== false,
      pollIntervalMs: clampInteger(raw.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs, 2000, 30000),
      streamPollIntervalMs: clampInteger(raw.streamPollIntervalMs, DEFAULT_CONFIG.streamPollIntervalMs, 5000, 60000),
      requestTimeoutMs: clampInteger(raw.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 3000, 45000),
      mapProvider: ["auto", "amap", "offline"].includes(raw.mapProvider) ? raw.mapProvider : DEFAULT_CONFIG.mapProvider,
      amapKey: String(raw.amapKey || "").trim(),
      amapSecurityJsCode: String(raw.amapSecurityJsCode || "").trim(),
      amapServiceHost: normalizeOptionalUrl(raw.amapServiceHost),
      amapStyle: String(raw.amapStyle || DEFAULT_CONFIG.amapStyle),
      amapLoadTimeoutMs: clampInteger(raw.amapLoadTimeoutMs, DEFAULT_CONFIG.amapLoadTimeoutMs, 10, 15000),
      amapRouteTimeoutMs: clampInteger(raw.amapRouteTimeoutMs, DEFAULT_CONFIG.amapRouteTimeoutMs, 10, 12000),
      amapMonthlyMapLimit: clampInteger(raw.amapMonthlyMapLimit, DEFAULT_CONFIG.amapMonthlyMapLimit, 1, 10000),
      amapMonthlyRouteLimit: clampInteger(raw.amapMonthlyRouteLimit, DEFAULT_CONFIG.amapMonthlyRouteLimit, 1, 10000)
    };
  }

  function loadConfig(environment = {}) {
    const storage = environment.storage || (typeof localStorage !== "undefined" ? localStorage : null);
    const storedRaw = safeStorageGet(storage, STORAGE_KEY);
    const sharedRaw = safeStorageGet(storage, SHARED_STORAGE_KEY);
    const stored = storedRaw.apiBase === BACKUP_AGENT_API && Number(storedRaw.configVersion || 0) < 3
      ? { ...storedRaw, apiBase: PRIMARY_AGENT_API }
      : storedRaw;
    const shared = sharedRaw.apiBase === BACKUP_AGENT_API && Number(sharedRaw.configVersion || 0) < 2
      ? { ...sharedRaw, apiBase: PRIMARY_AGENT_API }
      : sharedRaw;
    const globalConfig = environment.globalConfig || (typeof window !== "undefined" ? window.AURI_HMI_CONFIG : {}) || {};
    const localConfig = environment.localConfig || (typeof window !== "undefined" ? window.AURI_HMI_LOCAL_CONFIG : {}) || {};
    const search = environment.search ?? (typeof location !== "undefined" ? location.search : "");
    const query = new URLSearchParams(search || "");
    const queryConfig = {};
    if (query.get("apiBase")) queryConfig.apiBase = query.get("apiBase");
    if (query.get("streamUrl")) queryConfig.streamUrl = query.get("streamUrl");
    const sharedConnection = shared.apiBase
      ? { apiBase: shared.apiBase, token: shared.token || "", streamUrl: `${String(shared.apiBase).replace(/\/$/, "")}/v1/stream` }
      : {};
    // Runtime config provides deploy-time defaults. Explicit browser settings
    // and the shared Console connection are user choices and must survive a
    // reload, even when env.js contains an empty placeholder token.
    const useLocalMapFallback = Boolean(localConfig.amapKey)
      && !stored.amapKey
      && !globalConfig.amapKey
      && stored.mapProvider !== "offline"
      && globalConfig.mapProvider !== "offline";
    const localMapFallback = useLocalMapFallback ? {
      mapProvider: localConfig.mapProvider || "amap",
      amapKey: localConfig.amapKey,
      amapSecurityJsCode: localConfig.amapSecurityJsCode || "",
      amapServiceHost: localConfig.amapServiceHost || "",
      amapStyle: localConfig.amapStyle || DEFAULT_CONFIG.amapStyle
    } : {};
    const merged = { ...DEFAULT_CONFIG, ...globalConfig, ...stored, ...localMapFallback, ...sharedConnection, ...queryConfig };
    const connectionOverride = queryConfig.apiBase;
    if (connectionOverride && !queryConfig.streamUrl) {
      merged.streamUrl = `${String(connectionOverride).replace(/\/$/, "")}/v1/stream`;
    }
    const inheritedApiBase = normalizeUrl(
      sharedConnection.apiBase || stored.apiBase || globalConfig.apiBase,
      DEFAULT_CONFIG.apiBase
    );
    const overrideApiBase = connectionOverride ? normalizeUrl(connectionOverride, DEFAULT_CONFIG.apiBase) : inheritedApiBase;
    if (connectionOverride && overrideApiBase !== inheritedApiBase) merged.token = "";
    return normalizeConfig(merged);
  }

  function saveConfig(config, storage = typeof localStorage !== "undefined" ? localStorage : null) {
    const normalized = normalizeConfig(config);
    safeStorageSet(storage, STORAGE_KEY, { ...normalized, configVersion: 3 });
    safeStorageSet(storage, SHARED_STORAGE_KEY, {
      configVersion: 2,
      apiBase: normalized.apiBase,
      token: normalized.token,
      updatedAt: Date.now()
    });
    return normalized;
  }

  function parseSseFrames(buffer) {
    const normalized = String(buffer || "").replace(/\r\n/g, "\n");
    const frames = normalized.split("\n\n");
    const remainder = frames.pop() || "";
    const events = frames.map((frame) => {
      const data = frame.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      const event = frame.split("\n").find((line) => line.startsWith("event:"));
      return data ? { event: event ? event.slice(6).trim() : "message", data } : null;
    }).filter(Boolean);
    return { events, remainder };
  }

  function createWorldStateStore(model = worldStateModel) {
    let snapshot = null;
    let meta = { sessionId: null, revision: -1, retiredSessionIds: [] };
    const listeners = new Set();

    function consume(incoming, context = {}) {
      const decision = model.acceptWorldState(meta, incoming);
      if (!decision.accepted) return decision;
      const previous = snapshot;
      if (decision.resetRequired && meta.sessionId && meta.sessionId !== incoming.session_id) {
        meta.retiredSessionIds = [...new Set([...meta.retiredSessionIds, meta.sessionId])].slice(-8);
      }
      snapshot = incoming;
      meta = {
        ...meta,
        sessionId: incoming.session_id,
        revision: incoming.revision
      };
      listeners.forEach((listener) => listener(snapshot, {
        ...decision,
        source: context.source || "unknown",
        previous
      }));
      return decision;
    }

    return {
      consume,
      getSnapshot: () => snapshot,
      getMeta: () => ({ ...meta, retiredSessionIds: [...meta.retiredSessionIds] }),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      reset() {
        snapshot = null;
        meta = { sessionId: null, revision: -1, retiredSessionIds: [] };
      }
    };
  }

  function createClient(options = {}) {
    const fetchImpl = options.fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    if (!fetchImpl) throw new Error("fetch is unavailable");
    let config = normalizeConfig(options.config || loadConfig());
    const store = options.store || createWorldStateStore();
    const onStatus = options.onStatus || (() => {});
    const onError = options.onError || (() => {});
    let running = false;
    let epoch = 0;
    let streamController = null;
    let requestControllers = new Set();
    let pollTimer = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let syncMode = "idle";

    function emit(type, detail = {}) {
      syncMode = type;
      onStatus({ type, ...detail });
    }

    function canSendToken(targetUrl) {
      try {
        return new URL(targetUrl, config.apiBase).origin === new URL(config.apiBase).origin;
      } catch (_error) {
        return false;
      }
    }

    function headers(withToken, extra = {}, targetUrl = config.apiBase) {
      return withToken && config.token && canSendToken(targetUrl)
        ? { ...extra, "X-Agent-Token": config.token }
        : { ...extra };
    }

    async function requestJsonOnce(path, requestOptions = {}) {
      const controller = new AbortController();
      requestControllers.add(controller);
      const timeout = setTimeout(() => controller.abort("timeout"), config.requestTimeoutMs);
      try {
        const response = await fetchImpl(`${config.apiBase}${path}`, {
          ...requestOptions,
          signal: controller.signal,
          headers: headers(requestOptions.withToken !== false, {
            Accept: "application/json",
            ...(requestOptions.headers || {})
          })
        });
        const contentType = response.headers?.get?.("content-type") || "";
        const text = await response.text();
        let body = null;
        if (text && contentType.includes("json")) {
          try { body = JSON.parse(text); } catch (_error) { body = null; }
        }
        if (!response.ok) {
          const error = new Error(body?.detail?.message || body?.detail?.code || response.statusText || `HTTP ${response.status}`);
          error.status = response.status;
          error.code = body?.detail?.code || `HTTP_${response.status}`;
          throw error;
        }
        if (text && body === null) {
          const error = new Error("Agent returned a non-JSON response");
          error.code = "INVALID_JSON";
          throw error;
        }
        return body;
      } catch (error) {
        if (controller.signal.aborted && error?.name === "AbortError") error.code = "TIMEOUT";
        throw error;
      } finally {
        clearTimeout(timeout);
        requestControllers.delete(controller);
      }
    }

    async function requestJson(path, requestOptions = {}) {
      const method = String(requestOptions.method || "GET").toUpperCase();
      const delays = method === "GET" ? GET_RETRY_DELAYS_MS : [0];
      let lastError = null;
      for (let attempt = 0; attempt < delays.length; attempt += 1) {
        if (delays[attempt]) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        try {
          return await requestJsonOnce(path, requestOptions);
        } catch (error) {
          lastError = error;
          const retryable = [502, 503, 504].includes(error?.status)
            || error?.code === "TIMEOUT"
            || (!error?.status && error?.code !== "INVALID_JSON");
          if (!retryable || attempt === delays.length - 1) throw error;
        }
      }
      throw lastError;
    }

    async function refresh(source = "state") {
      const currentEpoch = epoch;
      try {
        const state = await requestJson("/v1/state");
        if (!running || currentEpoch !== epoch) return null;
        const decision = store.consume(state, { source });
        if (decision.reason === "schema_incompatible") emit("schema_incompatible");
        return state;
      } catch (error) {
        if (error.status === 401) emit("auth_required");
        onError(error, { source });
        throw error;
      }
    }

    async function submitEvent(type, payload, options = {}) {
      const snapshot = store.getSnapshot();
      if (!snapshot?.session_id) {
        const error = new Error("World State session is not ready");
        error.code = "SESSION_NOT_READY";
        throw error;
      }
      const eventId = options.eventId || `hmi_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
      const envelope = {
        schema_version: "0.2.0",
        event_id: eventId,
        session_id: snapshot.session_id,
        type,
        source: options.source || "vehicle_hmi",
        timestamp: options.timestamp || new Date().toISOString(),
        payload: payload || {}
      };
      const response = await requestJson("/v1/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope)
      });
      if (response?.state) store.consume(response.state, { source: `event:${type}` });
      return { response, envelope };
    }

    async function preflight() {
      const currentEpoch = epoch;
      try {
        const health = await requestJson("/health", { withToken: false });
        // Health is public and may resolve after an authenticated state request
        // has already failed. Never let it mask a 401 or schema failure.
        if (running && currentEpoch === epoch && !["auth_required", "schema_incompatible"].includes(syncMode)) {
          onStatus({ type: "healthy", health });
        }
        return health;
      } catch (error) {
        onError(error, { source: "health" });
        return null;
      }
    }

    function schedulePolling(delay) {
      clearTimeout(pollTimer);
      if (!running) return;
      pollTimer = setTimeout(async () => {
        try {
          await refresh("poll");
          if (syncMode !== "streaming" && config.stream && !streamController) startStream();
        } catch (_error) {
          if (syncMode !== "auth_required") emit("polling_fallback");
        } finally {
          schedulePolling(syncMode === "streaming" ? config.streamPollIntervalMs : config.pollIntervalMs);
        }
      }, delay);
    }

    function scheduleReconnect() {
      clearTimeout(reconnectTimer);
      if (!running || !config.stream || syncMode === "auth_required") return;
      const base = Math.min(15000, 1000 * (2 ** reconnectAttempt));
      const delay = Math.round(base * (0.9 + Math.random() * 0.2));
      reconnectAttempt = Math.min(reconnectAttempt + 1, 4);
      reconnectTimer = setTimeout(startStream, delay);
    }

    async function startStream() {
      if (!running || !config.stream || streamController) return;
      const currentEpoch = epoch;
      const controller = new AbortController();
      streamController = controller;
      emit("connecting");
      try {
        const response = await fetchImpl(config.streamUrl, {
          signal: controller.signal,
          headers: headers(true, { Accept: "text/event-stream" }, config.streamUrl),
          cache: "no-store"
        });
        if (!response.ok) {
          const error = new Error(response.statusText || `HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        if (!response.body?.getReader) throw new Error("Streaming response is unavailable");
        reconnectAttempt = 0;
        emit("streaming");
        await refresh("stream_reconcile").catch(() => null);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (running && currentEpoch === epoch) {
          const { value, done } = await reader.read();
          if (done) throw new Error("State stream closed");
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSseFrames(buffer);
          buffer = parsed.remainder;
          parsed.events.forEach((event) => {
            try {
              store.consume(JSON.parse(event.data), { source: "stream" });
            } catch (error) {
              onError(error, { source: "stream_parse" });
            }
          });
        }
      } catch (error) {
        if (running && currentEpoch === epoch && !controller.signal.aborted) {
          if (error.status === 401) emit("auth_required");
          else emit("polling_fallback");
          onError(error, { source: "stream" });
        }
      } finally {
        if (streamController === controller) streamController = null;
        if (running && currentEpoch === epoch) scheduleReconnect();
      }
    }

    async function start() {
      if (running) return;
      running = true;
      epoch += 1;
      emit("preflighting");
      preflight();
      try {
        await refresh("initial");
        if (config.stream) startStream();
        else emit("polling_fallback");
      } catch (_error) {
        if (syncMode !== "auth_required") emit("polling_fallback");
      }
      schedulePolling(syncMode === "streaming" ? config.streamPollIntervalMs : config.pollIntervalMs);
    }

    function stop() {
      running = false;
      epoch += 1;
      clearTimeout(pollTimer);
      clearTimeout(reconnectTimer);
      streamController?.abort("stopped");
      streamController = null;
      requestControllers.forEach((controller) => controller.abort("stopped"));
      requestControllers = new Set();
      emit("stopped");
    }

    function reconfigure(nextConfig) {
      const wasRunning = running;
      stop();
      config = normalizeConfig(nextConfig);
      store.reset();
      if (wasRunning) start();
      return config;
    }

    return {
      start,
      stop,
      refresh,
      submitEvent,
      requestJson,
      reconfigure,
      getConfig: () => ({ ...config, token: config.token }),
      getSnapshot: store.getSnapshot,
      getSyncMode: () => syncMode,
      injectSnapshot: (state, source = "fixture") => store.consume(state, { source }),
      subscribe: store.subscribe
    };
  }

  return {
    DEFAULT_CONFIG,
    SHARED_STORAGE_KEY,
    STORAGE_KEY,
    createClient,
    createWorldStateStore,
    loadConfig,
    normalizeConfig,
    parseSseFrames,
    saveConfig
  };
});
