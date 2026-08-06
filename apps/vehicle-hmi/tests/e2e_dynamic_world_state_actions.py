"""Verify the Agent/HMI action contract for mobile and Console task entry.

This test serially resets the dedicated local Agent and drives the real HMI
and Console pages through the local static server. Do not run it alongside
other tests that reset port 8795.

Run only against the dedicated local services:

    AURI_AGENT_URL=http://127.0.0.1:8795 \
    AURI_WEB_ROOT=http://127.0.0.1:5174 \
    python apps/vehicle-hmi/tests/e2e_dynamic_world_state_actions.py
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib import error, request
from uuid import uuid4

from playwright.sync_api import Page, sync_playwright


AGENT = os.getenv("AURI_AGENT_URL", "http://127.0.0.1:8795").rstrip("/")
WEB_ROOT = os.getenv("AURI_WEB_ROOT", "http://127.0.0.1:5174").rstrip("/")
HMI = f"{WEB_ROOT}/apps/vehicle-hmi/"
CONSOLE = f"{WEB_ROOT}/apps/demo-console/"
TOKEN = os.getenv("AURI_AGENT_TOKEN", "")
CHROME = os.getenv(
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE",
    str(Path.home() / ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
)
TZ = timezone(timedelta(hours=8), name="Asia/Shanghai")


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
    except OSError as exc:
        raise AssertionError(f"Cannot reach {AGENT}: {exc}") from exc


def event(event_type: str, payload: dict, source: str = "mobile") -> dict:
    state = api("/v1/state")
    return api(
        "/v1/event",
        "POST",
        {
            "schema_version": "0.2.0",
            "event_id": f"dynamic_actions_{event_type}_{uuid4().hex[:12]}",
            "session_id": state["session_id"],
            "type": event_type,
            "source": source,
            "timestamp": datetime.now(TZ).isoformat(),
            "payload": payload,
        },
    )["state"]


def reset(scenario_id: str) -> dict:
    return api("/v1/session/reset", "POST", {"scenario_id": scenario_id})


def mobile_chat(message: str, session_id: str) -> list[dict]:
    payload = json.dumps(
        {
            "message": message,
            "inputMode": "voice",
            "sessionId": session_id,
            "clientEventId": f"dynamic_actions_chat_{uuid4().hex}",
        },
        ensure_ascii=False,
    ).encode("utf-8")
    headers = {"Accept": "text/event-stream", "Content-Type": "application/json"}
    if TOKEN:
        headers["X-Agent-Token"] = TOKEN
    req = request.Request(f"{AGENT}/v1/chat", method="POST", data=payload, headers=headers)
    try:
        with request.urlopen(req, timeout=30) as response:
            raw = response.read().decode("utf-8")
    except OSError as exc:
        raise AssertionError(f"Cannot reach {AGENT}/v1/chat: {exc}") from exc
    events = []
    for frame in raw.replace("\r\n", "\n").split("\n\n"):
        data = "\n".join(
            line[5:].lstrip() for line in frame.splitlines() if line.startswith("data:")
        )
        if data:
            events.append(json.loads(data))
    return events


def connect_hmi(page: Page, session_id: str) -> None:
    page.wait_for_function(
        "sessionId => window.AURI_HMI_NEXT?.getState().viewModel.meta.sessionId === sessionId",
        arg=session_id,
        timeout=20000,
    )
    page.wait_for_function(
        "() => ['streaming', 'polling_fallback'].includes(window.AURI_HMI_NEXT?.getState().syncMode)",
        timeout=20000,
    )


def open_hmi(browser_context, session_id: str) -> Page:
    page = browser_context.new_page()
    config = json.dumps({"apiBase": AGENT, "token": TOKEN, "stream": True})
    page.add_init_script(
        f"window.AURI_HMI_CONFIG={config};"
        "try{localStorage.removeItem('auri-hmi-next-config')}catch(_e){};"
        "window.SAFEDRIVER_CONFIG={systemSpeechFallback:false};"
        "window.AURI_HMI_SPEECH_ADAPTER={cancel(){},speak(){return true}};"
    )
    page.goto(HMI, wait_until="domcontentloaded", timeout=30000)
    connect_hmi(page, session_id)
    return page


def open_console(browser_context, session_id: str) -> Page:
    page = browser_context.new_page()
    config = json.dumps({"apiBase": AGENT, "token": TOKEN, "stream": True})
    page.add_init_script(
        f"window.AURI_CONFIG={config};"
        "try{localStorage.removeItem('auri-demo-console-config')}catch(_e){};"
    )
    page.goto(CONSOLE, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_function(
        "sessionId => document.querySelector('#sessionId')?.textContent === sessionId",
        arg=session_id,
        timeout=20000,
    )
    page.wait_for_function(
        "() => document.querySelector('#syncMode')?.textContent === 'SSE 实时'",
        timeout=20000,
    )
    return page


def progress_to_help() -> dict:
    event("meeting.overrun", {"delay_minutes": 20}, "demo_console")
    event("scene.vehicle_entered", {}, "demo_console")
    event(
        "traffic.updated",
        {"eta": "2026-08-05T18:28:00+08:00", "late_minutes": 18},
        "demo_console",
    )
    return event(
        "user.utterance",
        {"text": "我还来得及吗？帮我处理", "input_mode": "voice"},
        "mobile",
    )


def assert_hmi_action_details(page: Page, state: dict) -> None:
    actions = state["actions"]
    buttons = page.locator('#auri-takeover-actions [data-panel-target^="action:"]')
    assert buttons.count() == len(actions), (buttons.count(), len(actions))

    for action in actions:
        selector = f'[data-panel-target="action:{action["action_id"]}"]'
        button = page.locator(f"#auri-takeover-actions {selector}")
        assert button.count() == 1, action
        assert action["target"] in button.inner_text(), action

        button.click()
        page.wait_for_function(
            "() => document.querySelector('#auri-driver-detail')?.hidden === false",
            timeout=5000,
        )
        detail = page.locator("#auri-detail-body").inner_text()
        assert action["target"] in detail, (action, detail)
        if action["type"] == "message":
            body = action.get("message_draft", {}).get("body")
            assert body, action
            assert body in detail, (action, detail)
        else:
            assert action["summary"] in detail or action["target"] in detail, (action, detail)
        page.locator("#auri-driver-back").click()
        page.wait_for_function(
            "() => document.querySelector('#auri-driver-detail')?.hidden === false"
            " && document.querySelector('#auri-detail-title')?.textContent === '处理进度'",
            timeout=5000,
        )
        page.locator("#auri-driver-back").click()
        page.wait_for_function(
            "() => document.querySelector('#auri-driver-detail')?.hidden === true",
            timeout=5000,
        )


def scenario_mobile_task_has_no_invented_contacts(browser_context) -> None:
    state = reset("dynamic-world-state-mobile-no-contacts")
    page = open_hmi(browser_context, state["session_id"])
    try:
        events = mobile_chat("18:10接孩子，之后去超市", state["session_id"])
        assert any(item.get("type") == "done" for item in events), events
        task_state = api("/v1/state")
        assert [item["title"] for item in task_state["tasks"]] == ["接孩子", "超市采购"], task_state
        assert all(item["waiting_party"] == [] for item in task_state["tasks"]), task_state["tasks"]

        final = progress_to_help()
        assert final["stage"] == "waiting_confirmation", final
        assert final["primary_surface"] == "vehicle_hmi", final
        messages = [action for action in final["actions"] if action["type"] == "message"]
        orders = [action for action in final["actions"] if action["type"] == "service_order"]
        assert messages == [], final["actions"]
        assert len(orders) == 1
        assert len(final["actions"]) == 1
        assert len(final["service_orders"]) == 1

        page.wait_for_function(
            "count => document.querySelectorAll('#auri-takeover-actions [data-panel-target^=\\\"action:\\\"]') .length === count",
            arg=1,
            timeout=15000,
        )
        assert_hmi_action_details(page, final)
        page_text = page.locator("body").inner_text()
        assert "王老师" not in page_text
        assert "孩子妈妈" not in page_text
    finally:
        page.close()


def scenario_console_preset_allows_explicit_contacts(browser_context) -> None:
    state = reset("dynamic-world-state-console-preset")
    page = open_hmi(browser_context, state["session_id"])
    console = open_console(browser_context, state["session_id"])
    try:
        submitted_events: list[dict] = []
        console.on(
            "request",
            lambda item: submitted_events.append(json.loads(item.post_data))
            if item.url == f"{AGENT}/v1/event" and item.post_data
            else None,
        )
        assert "可选兜底" in console.locator(".optional-preset").inner_text()
        console.locator('button[data-action="presetTask"]').click()
        console.wait_for_function(
            "() => document.querySelectorAll('#tasks li').length === 2",
            timeout=15000,
        )
        preset_events = [item for item in submitted_events if item.get("type") == "task.created"]
        assert len(preset_events) == 1, submitted_events
        preset_tasks = preset_events[0]["payload"]["tasks"]
        assert preset_tasks[0]["waiting_party"] == ["王老师", "孩子妈妈"], preset_tasks
        assert preset_tasks[1]["waiting_party"] == [], preset_tasks

        final = progress_to_help()
        assert final["stage"] == "waiting_confirmation", final
        messages = [action for action in final["actions"] if action["type"] == "message"]
        orders = [action for action in final["actions"] if action["type"] == "service_order"]
        assert [action["target"] for action in messages] == ["王老师", "孩子妈妈"], final["actions"]
        assert len(orders) == 1
        assert len(final["actions"]) == 3

        page.wait_for_function(
            "count => document.querySelectorAll('#auri-takeover-actions [data-panel-target^=\\\"action:\\\"]') .length === count",
            arg=3,
            timeout=15000,
        )
        page_text = page.locator("body").inner_text()
        assert "王老师" in page_text
        assert "孩子妈妈" in page_text
        assert_hmi_action_details(page, final)
    finally:
        console.close()
        page.close()


def main() -> None:
    if AGENT not in {"http://127.0.0.1:8795", "http://localhost:8795"}:
        raise SystemExit(f"Refusing to reset non-dedicated Agent URL: {AGENT}")

    health = api("/health")
    assert health.get("status") == "ok", health
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        context = browser.new_context(viewport={"width": 1920, "height": 720})
        try:
            scenario_mobile_task_has_no_invented_contacts(context)
            scenario_console_preset_allows_explicit_contacts(context)
        finally:
            context.close()
            browser.close()
    print("PASS: mobile task rendered no invented contacts; Console preset rendered its explicit contacts")


if __name__ == "__main__":
    main()
