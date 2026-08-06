"""Exercise HMI network recovery and long-running browser resource stability.

The test owns a dedicated Agent process on 127.0.0.1:8795. It deliberately
resets and advances World State, so public deployments are rejected before any
network, browser, or subprocess work starts.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import median
from urllib import error, parse, request
from uuid import uuid4

from playwright.sync_api import BrowserContext, CDPSession, Page, sync_playwright


REPO_ROOT = Path(__file__).resolve().parents[3]
AGENT = os.getenv("AURI_AGENT_URL", "http://127.0.0.1:8795").rstrip("/")
HMI = os.getenv(
    "AURI_HMI_URL", "http://127.0.0.1:5174/apps/vehicle-hmi/"
)
TOKEN = os.getenv("AURI_AGENT_TOKEN", "")
AGENT_PYTHON = os.getenv(
    "AURI_AGENT_PYTHON", "/home/fly/miniconda3/envs/auri-agent-dev/bin/python"
)
CHROME = os.getenv(
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE",
    str(Path.home() / ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
)
REPORT_PATH = Path(
    os.getenv("AURI_SOAK_REPORT", "/tmp/auri-hmi-resilience-soak.json")
)
SOAK_SECONDS = float(os.getenv("AURI_SOAK_SECONDS", "1800"))
SAMPLE_SECONDS = float(os.getenv("AURI_SOAK_SAMPLE_SECONDS", "60"))
FPS_WINDOW_SECONDS = float(os.getenv("AURI_SOAK_FPS_WINDOW_SECONDS", "5"))
OFFLINE_SECONDS = 15.0
TZ = timezone(timedelta(hours=8))

THRESHOLDS = {
    "heap_growth_bytes": int(os.getenv("AURI_SOAK_MAX_HEAP_GROWTH_MB", "48"))
    * 1024
    * 1024,
    "heap_growth_ratio": float(os.getenv("AURI_SOAK_MAX_HEAP_GROWTH_RATIO", "0.50")),
    "dom_node_growth": int(os.getenv("AURI_SOAK_MAX_DOM_NODE_GROWTH", "300")),
    "document_growth": int(os.getenv("AURI_SOAK_MAX_DOCUMENT_GROWTH", "1")),
    "active_timeouts": int(os.getenv("AURI_SOAK_MAX_ACTIVE_TIMEOUTS", "12")),
    "active_intervals": int(os.getenv("AURI_SOAK_MAX_ACTIVE_INTERVALS", "6")),
    "active_rafs": int(os.getenv("AURI_SOAK_MAX_ACTIVE_RAFS", "3")),
    "duplicate_timer_instances": int(
        os.getenv("AURI_SOAK_MAX_DUPLICATE_TIMER_INSTANCES", "2")
    ),
    "median_fps": float(os.getenv("AURI_SOAK_MIN_MEDIAN_FPS", "20")),
    "minimum_fps": float(os.getenv("AURI_SOAK_MIN_FPS", "10")),
}

RESOURCE_PROBE_SCRIPT = r"""
(() => {
  if (window.__auriResourceProbe) return;
  const native = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window)
  };
  const active = {
    timeout: new Map(),
    interval: new Map(),
    raf: new Map()
  };
  const scheduled = { timeout: 0, interval: 0, raf: 0 };

  function handlerText(handler) {
    try {
      const raw = typeof handler === "function" ? Function.prototype.toString.call(handler) : String(handler);
      return raw.replace(/\s+/g, " ").slice(0, 180);
    } catch (_error) {
      return "<uninspectable>";
    }
  }

  function record(type, handler, delay) {
    return {
      signature: `${type}:${Math.round(Number(delay) || 0)}:${handlerText(handler)}`,
      delayMs: Math.round(Number(delay) || 0),
      createdAt: performance.now()
    };
  }

  window.setTimeout = function(handler, delay, ...args) {
    let id;
    const wrapped = function(...callbackArgs) {
      active.timeout.delete(id);
      if (typeof handler === "function") return handler.apply(this, callbackArgs);
      return (0, eval)(String(handler));
    };
    id = native.setTimeout(wrapped, delay, ...args);
    active.timeout.set(id, record("timeout", handler, delay));
    scheduled.timeout += 1;
    return id;
  };

  window.clearTimeout = function(id) {
    active.timeout.delete(id);
    return native.clearTimeout(id);
  };

  window.setInterval = function(handler, delay, ...args) {
    const id = native.setInterval(handler, delay, ...args);
    active.interval.set(id, record("interval", handler, delay));
    scheduled.interval += 1;
    return id;
  };

  window.clearInterval = function(id) {
    active.interval.delete(id);
    return native.clearInterval(id);
  };

  window.requestAnimationFrame = function(handler) {
    let id;
    const wrapped = function(timestamp) {
      active.raf.delete(id);
      return handler.call(this, timestamp);
    };
    id = native.requestAnimationFrame(wrapped);
    active.raf.set(id, record("raf", handler, 0));
    scheduled.raf += 1;
    return id;
  };

  window.cancelAnimationFrame = function(id) {
    active.raf.delete(id);
    return native.cancelAnimationFrame(id);
  };

  function describe(type) {
    const grouped = new Map();
    active[type].forEach((item) => {
      const current = grouped.get(item.signature) || {
        signature: item.signature,
        count: 0,
        oldestAgeMs: 0
      };
      current.count += 1;
      current.oldestAgeMs = Math.max(current.oldestAgeMs, performance.now() - item.createdAt);
      grouped.set(item.signature, current);
    });
    return [...grouped.values()]
      .filter((item) => item.count > 1)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((item) => ({ ...item, oldestAgeMs: Math.round(item.oldestAgeMs) }));
  }

  window.__auriResourceProbe = {
    snapshot() {
      return {
        active: {
          timeout: active.timeout.size,
          interval: active.interval.size,
          raf: active.raf.size
        },
        scheduled: { ...scheduled },
        duplicates: {
          timeout: describe("timeout"),
          interval: describe("interval"),
          raf: describe("raf")
        }
      };
    }
  };
})();
"""


def validate_configuration() -> tuple[str, int]:
    """Reject destructive or ambiguous targets before doing any work."""
    parsed = parse.urlparse(AGENT)
    hostname = (parsed.hostname or "").lower()
    if "onrender.com" in hostname:
        raise SystemExit(
            "Refusing public onrender Agent immediately; this test resets World State."
        )
    if parsed.scheme != "http" or hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("AURI_AGENT_URL must be a loopback HTTP URL.")
    port = parsed.port or 80
    if port != 8795:
        raise SystemExit("AURI_AGENT_URL must use the dedicated test port 8795.")
    if SOAK_SECONDS < 0 or SAMPLE_SECONDS <= 0 or FPS_WINDOW_SECONDS <= 0:
        raise SystemExit("Soak duration must be non-negative; sample and FPS windows must be positive.")
    return hostname, port


def port_is_open(host: str, port: int) -> bool:
    address = "127.0.0.1" if host in {"localhost", "::1"} else host
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex((address, port)) == 0


def api(path: str, method: str = "GET", payload: dict | None = None) -> dict:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if TOKEN:
        headers["X-Agent-Token"] = TOKEN
    req = request.Request(f"{AGENT}{path}", method=method, data=body, headers=headers)
    try:
        with request.urlopen(req, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8")
        raise AssertionError(f"{method} {path} failed: {exc.code} {detail}") from exc


def submit(event_type: str, payload: dict, source: str = "demo_console") -> dict:
    state = api("/v1/state")
    envelope = {
        "schema_version": "0.2.0",
        "event_id": f"resilience_{event_type}_{uuid4().hex[:12]}",
        "session_id": state["session_id"],
        "type": event_type,
        "source": source,
        "timestamp": datetime.now(TZ).isoformat(),
        "payload": payload,
    }
    return api("/v1/event", "POST", envelope)["state"]


def start_agent(log_file) -> subprocess.Popen:
    python = Path(AGENT_PYTHON)
    if not python.is_file():
        raise AssertionError(f"Agent Python does not exist: {python}")
    env = os.environ.copy()
    env.update(
        {
            "LLM_ENABLED": "false",
            "OPENAI_API_KEY": "",
            "AGENT_SHARED_TOKEN": "",
            "AMAP_JS_API_KEY": "",
            "AMAP_SECURITY_JS_CODE": "",
            "PORT": "8795",
        }
    )
    process = subprocess.Popen(
        [
            str(python),
            "-m",
            "uvicorn",
            "auri_agent.app:app",
            "--app-dir",
            "services/agent-api/src",
            "--host",
            "127.0.0.1",
            "--port",
            "8795",
        ],
        cwd=REPO_ROOT,
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    deadline = time.monotonic() + 30
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            break
        try:
            health = api("/health")
            if health.get("status") == "ok":
                return process
        except Exception as exc:  # Server is expected to reject connections while booting.
            last_error = exc
        time.sleep(0.2)
    log_file.flush()
    log_file.seek(0)
    tail = log_file.read().decode("utf-8", errors="replace")[-4000:]
    stop_process(process)
    raise AssertionError(f"Dedicated Agent failed to start: {last_error}\n{tail}")


def stop_process(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=8)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)


def set_offline(context: BrowserContext, offline: bool) -> None:
    # BrowserContext offline mode terminates existing fetch/SSE connections;
    # CDP Network.emulateNetworkConditions may leave an established stream alive.
    context.set_offline(offline)


def measure_fps(page: Page, duration_seconds: float) -> dict:
    return page.evaluate(
        """durationMs => new Promise((resolve) => {
          let frames = 0;
          let rafId = 0;
          let finished = false;
          const startedAt = performance.now();
          const finish = (endedAt, timedOut) => {
            if (finished) return;
            finished = true;
            if (rafId) cancelAnimationFrame(rafId);
            clearTimeout(timeoutId);
            const elapsedMs = Math.max(1, endedAt - startedAt);
            resolve({
              frames,
              elapsedMs: Math.round(elapsedMs),
              fps: Number((frames * 1000 / elapsedMs).toFixed(2)),
              timedOut
            });
          };
          const tick = (timestamp) => {
            frames += 1;
            if (timestamp - startedAt >= durationMs) finish(timestamp, false);
            else rafId = requestAnimationFrame(tick);
          };
          const timeoutId = setTimeout(() => finish(performance.now(), true), durationMs + 2000);
          rafId = requestAnimationFrame(tick);
        })""",
        round(duration_seconds * 1000),
    )


def sample_resources(
    page: Page, cdp: CDPSession, soak_started: float, sequence: int
) -> dict:
    gc_forced = True
    try:
        cdp.send("HeapProfiler.collectGarbage")
    except Exception:
        gc_forced = False
    page.wait_for_timeout(100)
    performance_metrics = cdp.send("Performance.getMetrics").get("metrics", [])
    metrics = {item["name"]: item["value"] for item in performance_metrics}
    dom = cdp.send("Memory.getDOMCounters")
    fps = measure_fps(page, FPS_WINDOW_SECONDS)
    probe = page.evaluate("window.__auriResourceProbe.snapshot()")
    state = page.evaluate("window.AURI_HMI_NEXT.getState()")
    return {
        "sequence": sequence,
        "elapsed_seconds": round(time.monotonic() - soak_started, 2),
        "sampled_at": datetime.now(TZ).isoformat(),
        "js_heap_used_bytes": round(metrics.get("JSHeapUsedSize", 0)),
        "dom_nodes": dom.get("nodes", 0),
        "documents": dom.get("documents", 0),
        "active_timers": probe["active"],
        "scheduled_totals": probe["scheduled"],
        "duplicate_timers": probe["duplicates"],
        "fps": fps,
        "world_state_revision": state["viewModel"]["meta"]["revision"],
        "sync_mode": state["syncMode"],
        "gc_forced": gc_forced,
    }


def series_summary(samples: list[dict], key: str) -> dict:
    values = [sample[key] for sample in samples]
    return {
        "first": values[0],
        "last": values[-1],
        "minimum": min(values),
        "maximum": max(values),
        "delta": values[-1] - values[0],
    }


def longest_growth_streak(values: list[float], noise: float = 0) -> int:
    longest = current = 0
    for previous, current_value in zip(values, values[1:]):
        if current_value > previous + noise:
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return longest


def duplicate_timer_findings(samples: list[dict]) -> list[dict]:
    occurrences: dict[tuple[str, str], dict] = {}
    for sample in samples:
        for timer_type, items in sample["duplicate_timers"].items():
            for item in items:
                key = (timer_type, item["signature"])
                finding = occurrences.setdefault(
                    key,
                    {
                        "type": timer_type,
                        "signature": item["signature"],
                        "samples": [],
                        "maximum_instances": 0,
                    },
                )
                finding["samples"].append(sample["sequence"])
                finding["maximum_instances"] = max(
                    finding["maximum_instances"], item["count"]
                )
    persistent = []
    for finding in occurrences.values():
        seen = finding["samples"]
        consecutive = any(right == left + 1 for left, right in zip(seen, seen[1:]))
        over_limit = (
            finding["maximum_instances"]
            > THRESHOLDS["duplicate_timer_instances"]
        )
        if consecutive or over_limit:
            persistent.append(finding)
    return persistent


def analyze(samples: list[dict]) -> tuple[dict, list[str]]:
    heap = series_summary(samples, "js_heap_used_bytes")
    nodes = series_summary(samples, "dom_nodes")
    documents = series_summary(samples, "documents")
    timeout_values = [item["active_timers"]["timeout"] for item in samples]
    interval_values = [item["active_timers"]["interval"] for item in samples]
    raf_values = [item["active_timers"]["raf"] for item in samples]
    fps_values = [item["fps"]["fps"] for item in samples]
    duplicate_findings = duplicate_timer_findings(samples)
    failures: list[str] = []

    heap_limit = max(
        THRESHOLDS["heap_growth_bytes"],
        round(heap["first"] * THRESHOLDS["heap_growth_ratio"]),
    )
    heap_streak = longest_growth_streak(
        [item["js_heap_used_bytes"] for item in samples], 256 * 1024
    )
    node_streak = longest_growth_streak(
        [item["dom_nodes"] for item in samples]
    )
    document_streak = longest_growth_streak(
        [item["documents"] for item in samples]
    )
    if heap["delta"] > heap_limit or (
        heap_streak >= 3 and heap["delta"] > heap_limit / 2
    ):
        failures.append(
            f"JS heap shows sustained growth: delta={heap['delta']} limit={heap_limit}"
        )
    if nodes["delta"] > THRESHOLDS["dom_node_growth"] or (
        node_streak >= 3 and nodes["delta"] > THRESHOLDS["dom_node_growth"] / 2
    ):
        failures.append(f"DOM nodes show sustained growth: delta={nodes['delta']}")
    if documents["delta"] > THRESHOLDS["document_growth"] or document_streak >= 3:
        failures.append(f"Documents show sustained growth: delta={documents['delta']}")
    if max(timeout_values) > THRESHOLDS["active_timeouts"]:
        failures.append(f"Too many active timeouts: max={max(timeout_values)}")
    if max(interval_values) > THRESHOLDS["active_intervals"]:
        failures.append(f"Too many active intervals: max={max(interval_values)}")
    if max(raf_values) > THRESHOLDS["active_rafs"]:
        failures.append(f"Too many active RAF callbacks: max={max(raf_values)}")
    if duplicate_findings:
        failures.append(
            f"Persistent or excessive duplicate timers detected: {len(duplicate_findings)}"
        )
    if median(fps_values) < THRESHOLDS["median_fps"]:
        failures.append(f"Median RAF FPS is too low: {median(fps_values):.2f}")
    low_fps_samples = [fps for fps in fps_values if fps < THRESHOLDS["minimum_fps"]]
    if len(low_fps_samples) > max(1, len(fps_values) // 5):
        failures.append(f"Too many low-FPS samples: {len(low_fps_samples)}")
    if any(item["fps"]["timedOut"] for item in samples):
        failures.append("One or more 5-second RAF probes timed out")
    if any(item["sync_mode"] != "streaming" for item in samples):
        failures.append("HMI left streaming mode during the stable soak window")

    analysis = {
        "heap": {**heap, "allowed_delta": heap_limit, "growth_streak": heap_streak},
        "dom_nodes": {**nodes, "growth_streak": node_streak},
        "documents": {**documents, "growth_streak": document_streak},
        "active_timers": {
            "timeout": {"minimum": min(timeout_values), "maximum": max(timeout_values)},
            "interval": {"minimum": min(interval_values), "maximum": max(interval_values)},
            "raf": {"minimum": min(raf_values), "maximum": max(raf_values)},
        },
        "fps": {
            "minimum": min(fps_values),
            "maximum": max(fps_values),
            "median": round(median(fps_values), 2),
        },
        "duplicate_timer_findings": duplicate_findings,
    }
    return analysis, failures


def run_test(report: dict, agent_host: str, agent_port: int) -> None:
    if port_is_open(agent_host, agent_port):
        raise AssertionError(
            "Dedicated port 8795 is already in use; stop that process so this test can own its Agent."
        )
    if not Path(CHROME).is_file():
        raise AssertionError(f"Chromium executable does not exist: {CHROME}")

    agent_process: subprocess.Popen | None = None
    browser = None
    context = None
    cdp = None
    network_offline = False
    context_closed = False
    browser_closed = False
    with tempfile.TemporaryFile() as agent_log:
        try:
            agent_process = start_agent(agent_log)
            initial = api(
                "/v1/session/reset", "POST", {"scenario_id": "hmi-resilience-soak"}
            )
            report["agent"] = {
                "pid": agent_process.pid,
                "session_id": initial["session_id"],
                "initial_revision": initial["revision"],
            }

            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    executable_path=CHROME,
                    headless=True,
                    args=[
                        "--disable-background-timer-throttling",
                        "--disable-renderer-backgrounding",
                    ],
                )
                context = browser.new_context(viewport={"width": 1920, "height": 720})
                page = context.new_page()
                page_errors: list[str] = []
                failed_requests: list[dict] = []
                page.on("pageerror", lambda item: page_errors.append(str(item)))
                page.on(
                    "requestfailed",
                    lambda item: failed_requests.append(
                        {
                            "url": item.url,
                            "error": item.failure,
                            "during_offline": network_offline,
                        }
                    ),
                )
                # This test deliberately cuts all browser networking to audit
                # Agent reconnection and retained resources. Keep the map on
                # the deterministic offline renderer so third-party AMap
                # errors do not contaminate the product-level page-error gate.
                config = json.dumps(
                    {
                        "apiBase": AGENT,
                        "token": TOKEN,
                        "stream": True,
                        "mapProvider": "offline",
                    }
                )
                page.add_init_script(RESOURCE_PROBE_SCRIPT)
                page.add_init_script(
                    f"window.AURI_HMI_CONFIG={config};"
                    "try{localStorage.removeItem('auri-hmi-next-config')}catch(_e){};"
                    "try{window.speechSynthesis.speak=()=>{}}catch(_e){}"
                )
                cdp = context.new_cdp_session(page)
                cdp.send("Network.enable")
                cdp.send("Performance.enable")
                page.goto(HMI, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_function(
                    "window.AURI_HMI_NEXT?.getState().syncMode === 'streaming'",
                    timeout=20000,
                )
                page.wait_for_function(
                    "revision => window.AURI_HMI_NEXT.getState().viewModel.meta.revision === revision",
                    arg=initial["revision"],
                    timeout=15000,
                )

                task_state = submit(
                    "task.created", {"text": "今天18:10接孩子，之后去超市"}, "mobile"
                )
                page.wait_for_function(
                    "revision => window.AURI_HMI_NEXT.getState().viewModel.meta.revision === revision",
                    arg=task_state["revision"],
                    timeout=15000,
                )
                before_offline_revision = task_state["revision"]

                set_offline(context, True)
                network_offline = True
                offline_started = time.monotonic()
                # Browser offline mode blocks retries but does not always tear
                # down an established fetch stream. window.stop() aborts the
                # active SSE request while keeping the rendered HMI alive.
                page.evaluate("window.stop()")
                page.wait_for_function(
                    "window.AURI_HMI_NEXT?.getState().syncMode !== 'streaming'",
                    timeout=15000,
                )
                before_offline_revision = page.evaluate(
                    "window.AURI_HMI_NEXT.getState().viewModel.meta.revision"
                )
                warning = submit("meeting.overrun", {"delay_minutes": 20})
                vehicle = submit("scene.vehicle_entered", {})
                traffic = submit(
                    "traffic.updated",
                    {
                        "eta": (datetime.now(TZ) + timedelta(minutes=28)).isoformat(),
                        "late_minutes": 18,
                    },
                )
                page.wait_for_timeout(round(OFFLINE_SECONDS * 1000))
                offline_elapsed = time.monotonic() - offline_started
                browser_revision_while_offline = page.evaluate(
                    "window.AURI_HMI_NEXT.getState().viewModel.meta.revision"
                )
                assert browser_revision_while_offline == before_offline_revision, (
                    "HMI revision changed while CDP networking was offline"
                )
                assert traffic["revision"] > browser_revision_while_offline
                assert offline_elapsed >= OFFLINE_SECONDS

                recovery_started = time.monotonic()
                set_offline(context, False)
                network_offline = False
                page.wait_for_function(
                    "window.AURI_HMI_NEXT?.getState().syncMode === 'streaming'",
                    timeout=45000,
                )
                page.wait_for_function(
                    "revision => window.AURI_HMI_NEXT.getState().viewModel.meta.revision === revision",
                    arg=traffic["revision"],
                    timeout=45000,
                )
                recovered = page.evaluate("window.AURI_HMI_NEXT.getState()")
                recovery_seconds = time.monotonic() - recovery_started
                report["recovery"] = {
                    "offline_requested_seconds": OFFLINE_SECONDS,
                    "offline_actual_seconds": round(offline_elapsed, 2),
                    "browser_revision_before_offline": before_offline_revision,
                    "browser_revision_while_offline": browser_revision_while_offline,
                    "agent_revision_while_offline": traffic["revision"],
                    "events_while_offline": [
                        {"stage": warning["stage"], "revision": warning["revision"]},
                        {"stage": vehicle["stage"], "revision": vehicle["revision"]},
                        {"stage": traffic["stage"], "revision": traffic["revision"]},
                    ],
                    "recovery_seconds": round(recovery_seconds, 2),
                    "sync_mode": recovered["syncMode"],
                    "caught_up_revision": recovered["viewModel"]["meta"]["revision"],
                }

                # Let offline notices and reconnect backoff timers settle before
                # establishing the retained-resource baseline.
                page.wait_for_timeout(6000)
                soak_started = time.monotonic()
                samples: list[dict] = []
                next_sample_at = soak_started
                sequence = 0
                while True:
                    now = time.monotonic()
                    if now < next_sample_at:
                        page.wait_for_timeout(round((next_sample_at - now) * 1000))
                    samples.append(sample_resources(page, cdp, soak_started, sequence))
                    sequence += 1
                    if time.monotonic() - soak_started >= SOAK_SECONDS:
                        break
                    next_sample_at = min(
                        soak_started + SOAK_SECONDS,
                        soak_started + sequence * SAMPLE_SECONDS,
                    )

                analysis, failures = analyze(samples)
                if page_errors:
                    failures.append(f"Uncaught page errors: {len(page_errors)}")
                report["soak"] = {
                    "actual_seconds": round(time.monotonic() - soak_started, 2),
                    "sample_count": len(samples),
                    "samples": samples,
                    "analysis": analysis,
                }
                report["browser"] = {
                    "page_errors": page_errors,
                    "failed_requests": failed_requests,
                }
                report["failures"].extend(failures)
                if failures:
                    raise AssertionError("; ".join(failures))

                # Close explicitly while Playwright is still active so the
                # report distinguishes verified teardown from implicit owner
                # cleanup performed by sync_playwright().__exit__().
                context.close()
                context_closed = True
                context = None
                browser.close()
                browser_closed = True
                browser = None
        finally:
            if cdp is not None and network_offline:
                try:
                    set_offline(context, False)
                except Exception:
                    pass
            if context is not None:
                if browser is not None and not browser.is_connected():
                    # Exiting sync_playwright closes every owned context first.
                    context_closed = True
                else:
                    try:
                        context.close()
                        context_closed = True
                    except Exception:
                        pass
            if browser is not None:
                if not browser.is_connected():
                    browser_closed = True
                else:
                    try:
                        browser.close()
                        browser_closed = True
                    except Exception:
                        pass
            stop_process(agent_process)
            report["cleanup"] = {
                "agent_stopped": agent_process is None or agent_process.poll() is not None,
                "context_closed": context is None or context_closed,
                "browser_closed": browser is None or browser_closed,
            }


def write_report(report: dict) -> None:
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(report, ensure_ascii=False, indent=2)
    REPORT_PATH.write_text(serialized + "\n", encoding="utf-8")
    print(serialized)


def main() -> None:
    agent_host, agent_port = validate_configuration()
    report = {
        "test": "AURI official HMI resilience and soak",
        "status": "running",
        "started_at": datetime.now(TZ).isoformat(),
        "configuration": {
            "agent_url": AGENT,
            "hmi_url": HMI,
            "token_configured": bool(TOKEN),
            "soak_seconds": SOAK_SECONDS,
            "sample_interval_seconds": SAMPLE_SECONDS,
            "fps_window_seconds": FPS_WINDOW_SECONDS,
            "offline_seconds": OFFLINE_SECONDS,
            "thresholds": THRESHOLDS,
        },
        "failures": [],
    }
    exit_code = 0
    try:
        run_test(report, agent_host, agent_port)
        report["status"] = "passed"
    except Exception as exc:
        exit_code = 1
        report["status"] = "failed"
        report["failures"].append(str(exc))
        report["exception"] = {
            "type": type(exc).__name__,
            "traceback": traceback.format_exc(),
        }
    finally:
        report["finished_at"] = datetime.now(TZ).isoformat()
        write_report(report)
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
