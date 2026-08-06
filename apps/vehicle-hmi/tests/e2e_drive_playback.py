"""Verify HMI route playback and the right-side driving view stay synchronized.

This test resets an Agent session and therefore only accepts the isolated local
Agent on port 8795. It never targets the shared public deployment.
"""

from __future__ import annotations

import copy
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib import parse, request
from uuid import uuid4

from playwright.sync_api import sync_playwright


AGENT = os.getenv("AURI_AGENT_URL", "http://127.0.0.1:8795").rstrip("/")
HMI = os.getenv("AURI_HMI_URL", "http://127.0.0.1:5174/apps/vehicle-hmi/")
TOKEN = os.getenv("AURI_AGENT_TOKEN", "")
CHROME = os.getenv(
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE",
    str(Path.home() / ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
)
TZ = timezone(timedelta(hours=8))


def validate_agent() -> None:
    parsed = parse.urlparse(AGENT)
    if parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.port != 8795:
        raise SystemExit("Playback test requires the isolated local Agent on port 8795.")


def api(path: str, method: str = "GET", payload: dict | None = None) -> dict:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if TOKEN:
        headers["X-Agent-Token"] = TOKEN
    req = request.Request(f"{AGENT}{path}", method=method, data=body, headers=headers)
    with request.urlopen(req, timeout=20) as response:
        return json.loads(response.read().decode())


def submit(event_type: str, payload: dict, source: str = "demo_console") -> dict:
    state = api("/v1/state")
    event = {
        "schema_version": "0.2.0",
        "event_id": f"drive_playback_{event_type.replace('.', '_')}_{uuid4().hex[:8]}",
        "session_id": state["session_id"],
        "type": event_type,
        "source": source,
        "timestamp": datetime.now(TZ).isoformat(),
        "payload": payload,
    }
    return api("/v1/event", "POST", event)["state"]


def playback(page) -> dict:
    return page.evaluate("window.AURI_HMI_NEXT.getState().drivePlayback")


def playback_view(page) -> dict:
    return page.evaluate("""() => ({
      playback: window.AURI_HMI_NEXT.getState().drivePlayback,
      displayedSpeed: Number(document.querySelector('#vd-speed')?.textContent || 0),
      motion: document.querySelector('#hmi')?.getAttribute('data-auri-motion') || ''
    })""")


def main() -> None:
    validate_agent()
    api("/v1/session/reset", "POST", {"scenario_id": "hmi-drive-playback"})
    submit("task.created", {"text": "今天18:10接孩子，之后去超市"}, "mobile")
    submit("meeting.overrun", {"delay_minutes": 20})
    submit("scene.vehicle_entered", {})

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        errors: list[str] = []
        page.on("pageerror", lambda item: errors.append(str(item)))
        config = json.dumps({
            "apiBase": AGENT,
            "token": TOKEN,
            "stream": True,
            "mapProvider": "offline",
        })
        page.add_init_script(
            f"window.AURI_HMI_CONFIG={config};"
            "try{localStorage.removeItem('auri-hmi-next-config')}catch(_e){};"
            "try{sessionStorage.clear()}catch(_e){}"
        )
        page.goto(HMI, wait_until="load", timeout=30000)
        page.wait_for_function(
            "window.AURI_HMI_NEXT?.getState().viewModel.lifecycle.stage === 'vehicle_observation'"
        )
        moving_before = playback(page)
        page.wait_for_timeout(1800)
        moving_view = playback_view(page)
        moving_after = moving_view["playback"]
        assert moving_after["progress"] > moving_before["progress"], (moving_before, moving_after)
        assert 0 < moving_after["speedKph"] <= 42, moving_after
        assert moving_view["motion"] == "moving"
        assert moving_view["displayedSpeed"] == round(moving_after["speedKph"])

        state = api("/v1/state")
        rigid = next(task for task in state["tasks"] if task.get("task_type") == "rigid")
        scheduled = datetime.fromisoformat(rigid["scheduled_at"])
        submit(
            "traffic.updated",
            {"eta": (scheduled + timedelta(minutes=18)).isoformat(), "late_minutes": 18},
        )
        page.wait_for_function(
            "window.AURI_HMI_NEXT.getState().viewModel.lifecycle.stage === 'takeover_L2'"
        )
        page.wait_for_timeout(1000)
        stopped_before = playback(page)
        page.wait_for_timeout(1500)
        stopped_after = playback(page)
        assert abs(stopped_after["progress"] - stopped_before["progress"]) < 0.001, (
            stopped_before,
            stopped_after,
        )
        assert stopped_after["speedKph"] == 0
        assert page.locator("#hmi").get_attribute("data-auri-motion") == "stopped"
        assert page.locator("#vd-speed").inner_text().strip() == "0"

        submit("user.utterance", {"text": "我还来得及吗？帮我处理", "input_mode": "voice"}, "mobile")
        page.wait_for_function(
            "window.AURI_HMI_NEXT.getState().viewModel.lifecycle.stage === 'waiting_confirmation'"
        )
        page.locator("#auri-takeover-confirm").click()
        page.wait_for_function(
            "window.AURI_HMI_NEXT.getState().viewModel.lifecycle.stage === 'action_completed'",
            timeout=15000,
        )
        resumed_before = playback(page)
        page.wait_for_timeout(1800)
        resumed_after = playback(page)
        assert resumed_after["progress"] > resumed_before["progress"], (resumed_before, resumed_after)
        assert resumed_after["speedKph"] > 0
        assert page.locator("#hmi").get_attribute("data-auri-motion") == "moving"
        assert page.locator("#vd-speed-arrow").inner_text().strip() == "▲"
        assert "dn" not in (page.locator("#vd-speed-arrow").get_attribute("class") or "").split()

        authoritative = api("/v1/state")
        fixture_page = browser.new_page(viewport={"width": 1280, "height": 720})
        fixture_page.add_init_script(
            "window.AURI_HMI_CONFIG={apiBase:'http://127.0.0.1:1',token:'',stream:false,mapProvider:'offline'};"
            "try{localStorage.removeItem('auri-hmi-next-config')}catch(_e){}"
        )
        fixture_page.goto(f"{HMI}?offline=1", wait_until="load", timeout=30000)
        fixture_page.wait_for_function("window.AURI_HMI_NEXT")
        fixture_page.evaluate("""() => {
          const original = window.mapCarReset;
          window.__auriMapResetCount = 0;
          window.mapCarReset = (...args) => {
            window.__auriMapResetCount += 1;
            return original?.(...args);
          };
        }""")
        route_a = copy.deepcopy(authoritative)
        route_a["revision"] += 100
        route_a["navigation"]["route_id"] = "playback_route_a"
        route_a["navigation"]["progress"] = 0.64
        assert fixture_page.evaluate("state => window.AURI_HMI_NEXT.applyState(state)", route_a) is not False
        progress_a = playback(fixture_page)["progress"]

        route_b = copy.deepcopy(route_a)
        route_b["revision"] += 1
        route_b["navigation"]["route_id"] = "playback_route_b"
        route_b["navigation"]["progress"] = 0.12
        assert fixture_page.evaluate("state => window.AURI_HMI_NEXT.applyState(state)", route_b) is not False
        progress_b = playback(fixture_page)["progress"]
        assert abs(progress_b - 0.12) < 0.01, (progress_a, progress_b)
        assert fixture_page.evaluate("window.__auriMapResetCount") >= 2

        route_b_update = copy.deepcopy(route_b)
        route_b_update["revision"] += 1
        route_b_update["navigation"]["progress"] = 0.07
        assert fixture_page.evaluate("state => window.AURI_HMI_NEXT.applyState(state)", route_b_update) is not False
        progress_b_update = playback(fixture_page)["progress"]
        assert abs(progress_b_update - 0.07) < 0.01, (progress_b, progress_b_update)
        route_switch_local_resets = fixture_page.evaluate("window.__auriMapResetCount")
        fixture_page.close()
        assert not errors, errors
        print(json.dumps({
            "moving_progress_delta": round(moving_after["progress"] - moving_before["progress"], 4),
            "stopped_progress_delta": round(stopped_after["progress"] - stopped_before["progress"], 4),
            "resumed_progress_delta": round(resumed_after["progress"] - resumed_before["progress"], 4),
            "right_view_speed": page.locator("#vd-speed").inner_text().strip(),
            "route_switch_progress": [progress_a, progress_b, progress_b_update],
            "route_switch_local_resets": route_switch_local_resets,
            "javascript_errors": len(errors),
        }, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    main()
