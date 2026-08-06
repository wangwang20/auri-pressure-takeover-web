const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const model = require("../src/world-state-model.js");
const agent = require("../src/agent-client.js");

async function main() {
  const normalized = agent.normalizeConfig({
    apiBase: "http://127.0.0.1:8000/",
    pollIntervalMs: 1,
    requestTimeoutMs: 999999,
    mapProvider: "amap",
    amapKey: "  web-key  ",
    amapSecurityJsCode: "  security-code  ",
    amapServiceHost: "https://example.com/_AMapService/",
    amapStyle: "amap://styles/whitesmoke",
    amapLoadTimeoutMs: 99999,
    amapRouteTimeoutMs: 1,
    amapMonthlyMapLimit: 0,
    amapMonthlyRouteLimit: 99999
  });
  assert.equal(normalized.apiBase, "http://127.0.0.1:8000");
  assert.equal(normalized.streamUrl, "http://127.0.0.1:8000/v1/stream");
  assert.equal(normalized.pollIntervalMs, 2000);
  assert.equal(normalized.requestTimeoutMs, 45000);
  assert.equal(normalized.mapProvider, "amap");
  assert.equal(normalized.amapKey, "web-key");
  assert.equal(normalized.amapSecurityJsCode, "security-code");
  assert.equal(normalized.amapServiceHost, "https://example.com/_AMapService");
  assert.equal(normalized.amapStyle, "amap://styles/whitesmoke");
  assert.equal(normalized.amapLoadTimeoutMs, 15000);
  assert.equal(normalized.amapRouteTimeoutMs, 10);
  assert.equal(normalized.amapMonthlyMapLimit, 1);
  assert.equal(normalized.amapMonthlyRouteLimit, 10000);

  const invalidMapConfig = agent.normalizeConfig({
    mapProvider: "unknown",
    amapServiceHost: "javascript:alert(1)",
    amapMonthlyMapLimit: "invalid",
    amapMonthlyRouteLimit: null
  });
  assert.equal(invalidMapConfig.mapProvider, "auto");
  assert.equal(invalidMapConfig.amapServiceHost, "");
  assert.equal(invalidMapConfig.amapLoadTimeoutMs, 12000);
  assert.equal(invalidMapConfig.amapRouteTimeoutMs, 8000);
  assert.equal(invalidMapConfig.amapMonthlyMapLimit, 200);
  assert.equal(invalidMapConfig.amapMonthlyRouteLimit, 1);

  const parsed = agent.parseSseFrames(
    "event: state.updated\r\ndata: {\"revision\":1,\r\ndata: \"ok\":true}\r\n\r\nevent: ping\ndata: keep"
  );
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].event, "state.updated");
  assert.equal(parsed.events[0].data, '{"revision":1,\n"ok":true}');
  assert.equal(parsed.remainder, "event: ping\ndata: keep");

  const fixture = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "../../../contracts/examples/world-state.json"),
    "utf8"
  ));
  const baseState = {
    ...fixture,
    session_id: "session-a",
    revision: 1
  };
  const store = agent.createWorldStateStore(model);
  const changes = [];
  store.subscribe((state, metadata) => changes.push({ state, metadata }));
  assert.equal(store.consume(baseState, { source: "initial" }).accepted, true);
  assert.equal(store.consume({ ...baseState, revision: 1 }, { source: "duplicate" }).accepted, false);
  assert.equal(store.consume({ ...baseState, revision: 2 }, { source: "stream" }).accepted, true);
  assert.equal(store.consume({ ...baseState, session_id: "session-b", revision: 1 }, { source: "new_session" }).resetRequired, true);
  assert.equal(store.consume({ ...baseState, revision: 99 }, { source: "late_old_request" }).reason, "retired_session");
  assert.equal(changes.length, 3);
  assert.deepEqual(store.getMeta().retiredSessionIds, ["session-a"]);

  const storage = {
    values: { [agent.STORAGE_KEY]: "{not json" },
    getItem(key) { return this.values[key] || null; },
    setItem(key, value) { this.values[key] = value; }
  };
  const config = agent.loadConfig({
    storage,
    search: "",
    globalConfig: {
      apiBase: "https://example.com/api",
      mapProvider: "offline",
      amapKey: "global-key"
    }
  });
  assert.equal(config.apiBase, "https://example.com/api");
  assert.equal(config.mapProvider, "offline");
  assert.equal(config.amapKey, "global-key");
  agent.saveConfig({
    apiBase: "http://localhost:8000",
    token: "secret",
    mapProvider: "amap",
    amapKey: "saved-key"
  }, storage);
  const saved = JSON.parse(storage.values[agent.STORAGE_KEY]);
  assert.equal(saved.token, "secret");
  assert.equal(saved.mapProvider, "amap");
  assert.equal(saved.amapKey, "saved-key");
  const sharedSaved = JSON.parse(storage.values[agent.SHARED_STORAGE_KEY]);
  assert.equal(sharedSaved.apiBase, "http://localhost:8000");
  assert.equal(sharedSaved.token, "secret");
  assert.equal(saved.configVersion, 3);
  assert.equal(sharedSaved.configVersion, 2);

  const legacyBackupStorage = {
    values: {
      [agent.STORAGE_KEY]: JSON.stringify({
        apiBase: "https://auri-langchain-agent-api.onrender.com",
        token: "legacy-token",
        configVersion: 2
      }),
      [agent.SHARED_STORAGE_KEY]: JSON.stringify({
        apiBase: "https://auri-langchain-agent-api.onrender.com",
        token: "legacy-token",
        configVersion: 1
      })
    },
    getItem(key) { return this.values[key] || null; },
    setItem(key, value) { this.values[key] = value; }
  };
  const migratedBackup = agent.loadConfig({ storage: legacyBackupStorage, search: "", globalConfig: {} });
  assert.equal(migratedBackup.apiBase, "https://auri-agent-api.onrender.com");
  assert.equal(migratedBackup.token, "legacy-token");

  legacyBackupStorage.values[agent.STORAGE_KEY] = JSON.stringify({
    apiBase: "https://auri-langchain-agent-api.onrender.com",
    token: "explicit-backup",
    configVersion: 3
  });
  legacyBackupStorage.values[agent.SHARED_STORAGE_KEY] = JSON.stringify({
    apiBase: "https://auri-langchain-agent-api.onrender.com",
    token: "explicit-backup",
    configVersion: 2
  });
  const explicitBackup = agent.loadConfig({ storage: legacyBackupStorage, search: "", globalConfig: {} });
  assert.equal(explicitBackup.apiBase, "https://auri-langchain-agent-api.onrender.com");
  assert.equal(explicitBackup.token, "explicit-backup");

  storage.values[agent.STORAGE_KEY] = JSON.stringify({
    apiBase: "https://stale.example.test",
    token: "stale-token",
    mapProvider: "offline"
  });
  storage.values[agent.SHARED_STORAGE_KEY] = JSON.stringify({
    apiBase: "https://shared.example.test",
    token: "shared-token"
  });
  const sharedLoaded = agent.loadConfig({ storage, search: "", globalConfig: {} });
  assert.equal(sharedLoaded.apiBase, "https://shared.example.test");
  assert.equal(sharedLoaded.streamUrl, "https://shared.example.test/v1/stream");
  assert.equal(sharedLoaded.token, "shared-token");
  assert.equal(sharedLoaded.mapProvider, "offline");
  const savedChoiceWinsOverRuntimeDefaults = agent.loadConfig({
    storage,
    search: "",
    globalConfig: { apiBase: "https://override.example.test", token: "" }
  });
  assert.equal(savedChoiceWinsOverRuntimeDefaults.apiBase, "https://shared.example.test");
  assert.equal(savedChoiceWinsOverRuntimeDefaults.streamUrl, "https://shared.example.test/v1/stream");
  assert.equal(savedChoiceWinsOverRuntimeDefaults.token, "shared-token", "an empty env.js placeholder must not erase the saved token");

  const queryOverride = agent.loadConfig({
    storage,
    search: "?apiBase=https%3A%2F%2Foverride.example.test",
    globalConfig: { apiBase: "https://runtime-default.example.test", token: "runtime-token" }
  });
  assert.equal(queryOverride.apiBase, "https://override.example.test");
  assert.equal(queryOverride.streamUrl, "https://override.example.test/v1/stream");
  assert.equal(queryOverride.token, "", "a query connection override must not inherit a token for another API");

  const localMapFallback = agent.loadConfig({
    storage: { getItem: () => null, setItem: () => {} },
    search: "",
    globalConfig: { apiBase: "https://runtime-default.example.test", token: "" },
    localConfig: { mapProvider: "amap", amapKey: "local-map-key", amapSecurityJsCode: "local-security" }
  });
  assert.equal(localMapFallback.mapProvider, "amap");
  assert.equal(localMapFallback.amapKey, "local-map-key");
  assert.equal(localMapFallback.amapSecurityJsCode, "local-security");

  const explicitOfflineBeatsLocalMap = agent.loadConfig({
    storage: { getItem: () => null, setItem: () => {} },
    search: "",
    globalConfig: { mapProvider: "offline" },
    localConfig: { mapProvider: "amap", amapKey: "local-map-key", amapSecurityJsCode: "local-security" }
  });
  assert.equal(explicitOfflineBeatsLocalMap.mapProvider, "offline");
  assert.equal(explicitOfflineBeatsLocalMap.amapKey, "");

  const hostileStreamOverride = agent.loadConfig({
    storage,
    search: "?streamUrl=https%3A%2F%2Fevil.example.test%2Fcollect",
    globalConfig: {}
  });
  assert.equal(hostileStreamOverride.apiBase, "https://shared.example.test");
  assert.equal(hostileStreamOverride.streamUrl, "https://shared.example.test/v1/stream");
  assert.equal(hostileStreamOverride.token, "shared-token");

  const normalizedCrossOriginStream = agent.normalizeConfig({
    apiBase: "https://agent.example.test",
    streamUrl: "https://evil.example.test/collect",
    token: "team-token"
  });
  assert.equal(normalizedCrossOriginStream.streamUrl, "https://agent.example.test/v1/stream");

  const requests = [];
  const client = agent.createClient({
    config: {
      apiBase: "https://agent.example.test/",
      token: "team-token",
      requestTimeoutMs: 3000
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json; charset=utf-8" },
        text: async () => JSON.stringify({ enabled: true, provider: "amap" })
      };
    }
  });
  assert.equal(typeof client.requestJson, "function");
  const mapConfig = await client.requestJson("/v1/map-config");
  assert.deepEqual(mapConfig, { enabled: true, provider: "amap" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://agent.example.test/v1/map-config");
  assert.equal(requests[0].options.headers.Accept, "application/json");
  assert.equal(requests[0].options.headers["X-Agent-Token"], "team-token");

  await client.requestJson("/health", { withToken: false });
  assert.equal(requests[1].options.headers["X-Agent-Token"], undefined);

  client.injectSnapshot({ ...baseState, session_id: "vehicle-session", revision: 7 });
  const submitted = await client.submitEvent("vehicle.control", { ac_on: true, ac_target_temp: 23 }, {
    eventId: "hmi_control_fixed",
    timestamp: "2026-08-03T10:00:00+08:00"
  });
  const controlRequest = requests[2];
  const controlEnvelope = JSON.parse(controlRequest.options.body);
  assert.equal(controlRequest.url, "https://agent.example.test/v1/event");
  assert.equal(controlRequest.options.method, "POST");
  assert.equal(controlEnvelope.event_id, "hmi_control_fixed");
  assert.equal(controlEnvelope.session_id, "vehicle-session");
  assert.equal(controlEnvelope.type, "vehicle.control");
  assert.equal(controlEnvelope.source, "vehicle_hmi");
  assert.deepEqual(controlEnvelope.payload, { ac_on: true, ac_target_temp: 23 });
  assert.equal(submitted.envelope.event_id, "hmi_control_fixed");

  let retryCalls = 0;
  const retryClient = agent.createClient({
    config: { apiBase: "https://agent.example.test" },
    fetchImpl: async () => {
      retryCalls += 1;
      const available = retryCalls > 1;
      return {
        ok: available,
        status: available ? 200 : 503,
        statusText: available ? "OK" : "Service Unavailable",
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify(available ? { status: "ok" } : { detail: { code: "COLD_START" } })
      };
    }
  });
  assert.deepEqual(await retryClient.requestJson("/health"), { status: "ok" });
  assert.equal(retryCalls, 2, "GET must recover from one transient 503");

  const invalidJsonClient = agent.createClient({
    config: { apiBase: "https://agent.example.test" },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/html" },
      text: async () => "<html>not json</html>"
    })
  });
  await assert.rejects(
    invalidJsonClient.requestJson("/v1/map-config"),
    (error) => error.code === "INVALID_JSON"
  );

  const authStatuses = [];
  const authRaceClient = agent.createClient({
    config: { apiBase: "https://agent.example.test", token: "wrong", stream: false },
    onStatus: (status) => authStatuses.push(status.type),
    fetchImpl: async (url) => {
      if (url.endsWith("/health")) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({ status: "ok" })
        };
      }
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ detail: { code: "UNAUTHORIZED", message: "invalid token" } })
      };
    }
  });
  await authRaceClient.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(authRaceClient.getSyncMode(), "auth_required");
  assert.equal(authStatuses.at(-1), "auth_required", "public health must not overwrite an authenticated 401");
  authRaceClient.stop();

  let streamRequests = 0;
  let streamAborts = 0;
  const lifecycleClient = agent.createClient({
    config: {
      apiBase: "https://agent.example.test",
      stream: true,
      pollIntervalMs: 2000,
      streamPollIntervalMs: 5000
    },
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith("/v1/stream")) {
        streamRequests += 1;
        return {
          ok: true,
          status: 200,
          body: {
            getReader() {
              return {
                read() {
                  return new Promise((_resolve, reject) => {
                    options.signal.addEventListener("abort", () => {
                      streamAborts += 1;
                      const abort = new Error("aborted");
                      abort.name = "AbortError";
                      reject(abort);
                    }, { once: true });
                  });
                }
              };
            }
          }
        };
      }
      const payload = url.endsWith("/health")
        ? { status: "ok" }
        : { ...baseState, session_id: "lifecycle-session", revision: 1 };
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify(payload)
      };
    }
  });

  await lifecycleClient.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await lifecycleClient.start();
  assert.equal(streamRequests, 1, "idempotent start must not create a second SSE stream");
  assert.equal(lifecycleClient.getSyncMode(), "streaming");

  lifecycleClient.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(streamAborts, 1, "stop must abort the active SSE stream");
  assert.equal(lifecycleClient.getSyncMode(), "stopped");

  await lifecycleClient.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(streamRequests, 2, "restart must create exactly one replacement stream");
  lifecycleClient.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(streamAborts, 2);

  console.log("vehicle-hmi agent-client tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
