"""Visual and interaction audit for every driver-side AURI detail page."""

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
OUTPUT = Path(os.getenv("AURI_DETAIL_VISUAL_DIR", "/tmp/auri-hmi-detail-pages"))
TZ = timezone(timedelta(hours=8))


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
        "event_id": f"detail_visual_{event_type.replace('.', '_')}_{uuid4().hex[:8]}",
        "session_id": state["session_id"],
        "type": event_type,
        "source": source,
        "timestamp": datetime.now(TZ).isoformat(),
        "payload": payload,
    }
    return api("/v1/event", "POST", event)["state"]


def prepare_state() -> dict:
    parsed = parse.urlparse(AGENT)
    if parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.port != 8795:
        raise SystemExit("Detail visual test requires the isolated local Agent on port 8795.")
    api("/v1/session/reset", "POST", {"scenario_id": "hmi-detail-pages"})
    today = datetime.now(TZ).date().isoformat()
    submit("task.created", {
        "text": "今天18:10接孩子，之后去超市",
        "tasks": [
            {
                "task_id": "task_pickup_child",
                "title": "接孩子",
                "scheduled_at": f"{today}T18:10:00+08:00",
                "location": "阳光小学",
                "task_type": "rigid",
                "priority": "high",
                "adjustable": False,
                "status": "pending",
                "waiting_party": ["王老师", "孩子妈妈"],
                "capability_tags": [],
            },
            {
                "task_id": "task_grocery",
                "title": "超市采购",
                "scheduled_at": f"{today}T19:30:00+08:00",
                "location": None,
                "task_type": "flexible",
                "priority": "low",
                "adjustable": True,
                "status": "pending",
                "waiting_party": [],
                "capability_tags": ["grocery_delivery"],
            },
        ],
    }, "demo_console")
    submit("meeting.overrun", {"delay_minutes": 20})
    submit("scene.vehicle_entered", {})
    state = api("/v1/state")
    rigid = next(task for task in state["tasks"] if task.get("task_type") == "rigid")
    scheduled = datetime.fromisoformat(rigid["scheduled_at"])
    submit("traffic.updated", {"eta": (scheduled + timedelta(minutes=18)).isoformat(), "late_minutes": 18})
    return submit("user.utterance", {"text": "我还来得及吗？帮我处理", "input_mode": "voice"}, "mobile")


def audit(page) -> dict:
    return page.evaluate(
        """() => {
          const panel=document.querySelector('#auri-driver-panel');
          const body=document.querySelector('#auri-detail-body');
          const rect=panel.getBoundingClientRect();
          const canvas=document.querySelector('#hmi');
          const visualScale=canvas?.style.width ? canvas.getBoundingClientRect().width/parseFloat(canvas.style.width) : 1;
          const interactive=Array.from(body.querySelectorAll('button')).filter(node=>{
            const style=getComputedStyle(node); const box=node.getBoundingClientRect();
            return style.display!=='none' && box.width>0 && box.height>0;
          });
          return {
            panelInside: rect.left>=-1 && rect.top>=-1 && rect.right<=innerWidth+1 && rect.bottom<=innerHeight+1,
            bodyOverflowX: body.scrollWidth>body.clientWidth+1,
            bodyScrollable: body.scrollHeight>body.clientHeight+1,
            interactiveSmall: interactive.filter(node=>{
              const box=node.getBoundingClientRect(); return box.width<44 || box.height<44;
            }).map(node=>node.className||node.textContent.trim().slice(0,20)),
            effectiveActionFonts:Array.from(body.querySelectorAll('.auri-action-step-copy small,.auri-action-step-copy b,.auri-action-step-copy em,.auri-action-step-state'))
              .map(node=>parseFloat(getComputedStyle(node).fontSize)*visualScale),
            visibleInternalText: /World State|revision\s*\d|手机与车机使用同一状态|由 Agent .*写入/i.test(panel.innerText),
          };
        }"""
    )


def assert_action_details(page, state: dict, source: str) -> dict[str, str]:
    """Every rendered action must open its own World State-backed detail page."""
    actions = [action for action in state.get("actions", []) if action.get("action_id")]
    expected_targets = {f"action:{action['action_id']}" for action in actions}
    selector = (
        "#auri-takeover-actions [data-panel-target^='action:']"
        if source == "overview"
        else "#auri-detail-body .auri-action-step[data-panel-target^='action:']"
    )
    targets = set(page.locator(selector).evaluate_all("nodes => nodes.map(node => node.dataset.panelTarget)"))
    assert targets == expected_targets, (source, targets, expected_targets)

    details: dict[str, str] = {}
    for index, action in enumerate(actions):
        target = f"action:{action['action_id']}"
        page.locator(f'{selector}[data-panel-target="{target}"]').click()
        page.wait_for_function(
            "expected => document.querySelector('#auri-driver-detail')?.hidden === false"
            " && document.querySelector('#auri-detail-title')?.textContent !== '处理进度'",
            arg=target,
        )

        if action.get("type") == "message":
            expected_body = action.get("message_draft", {}).get("body")
            assert isinstance(expected_body, str) and expected_body, (source, action)
            actual_body = page.locator(".auri-action-preview > p").evaluate("node => node.textContent")
            assert actual_body == expected_body, (source, action["action_id"], actual_body, expected_body)
        details[target] = page.locator("#auri-detail-body").inner_text()

        # A third-level action detail always returns to the processing page, not home.
        page.locator("#auri-driver-back").click()
        page.wait_for_function(
            "document.querySelector('#auri-driver-detail')?.hidden === false"
            " && document.querySelector('#auri-detail-title')?.textContent === '处理进度'"
        )
        if source == "overview" and index < len(actions) - 1:
            page.locator("#auri-driver-back").click()
            page.wait_for_function("document.querySelector('#auri-driver-detail')?.hidden === true")
    return details


def main() -> None:
    prepared_state = prepare_state()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    report = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        for viewport in ({"width": 1920, "height": 1080}, {"width": 1366, "height": 768}):
            page = browser.new_page(viewport=viewport)
            errors: list[str] = []
            page.on("pageerror", lambda item: errors.append(str(item)))
            config = json.dumps({"apiBase": AGENT, "token": TOKEN, "stream": True, "mapProvider": "offline"})
            page.add_init_script(
                f"window.AURI_HMI_CONFIG={config};"
                "try{localStorage.removeItem('auri-hmi-next-config')}catch(_e){};"
                "try{sessionStorage.clear()}catch(_e){}"
            )
            page.goto(HMI, wait_until="load", timeout=30000)
            page.wait_for_function(
                "expected => {"
                " const state=window.AURI_HMI_NEXT?.getState();"
                " return state?.worldState?.session_id === expected.session_id"
                "  && Number(state.worldState.revision) >= expected.revision"
                "  && state.viewModel.lifecycle.stage === 'waiting_confirmation';"
                "}",
                arg={"session_id": prepared_state["session_id"], "revision": prepared_state["revision"]},
            )
            # The compact action list on the persistent AURI overview and the action
            # list in the processing page must both enter the same third-level detail.
            overview_details = assert_action_details(page, prepared_state, "overview")
            page.locator("#auri-driver-back").click()
            page.wait_for_function("document.querySelector('#auri-driver-detail')?.hidden === true")
            page.locator('[data-auri-section="messages"]').click()
            page.wait_for_function("document.querySelector('#auri-detail-title')?.textContent === '处理进度'")
            processing_details = assert_action_details(page, prepared_state, "processing")
            assert processing_details == overview_details, (processing_details, overview_details)
            page.locator("#auri-driver-back").click()
            page.wait_for_function("document.querySelector('#auri-driver-detail')?.hidden === true")
            pages = ["tasks", "messages", "sync", "vehicle", "route", "connection"]
            for name in pages:
                page.evaluate("section => window.AURI_HMI_NEXT.openPanel(section)", name)
                page.wait_for_timeout(100)
                result = audit(page)
                assert result["panelInside"], (viewport, name, result)
                assert not result["bodyOverflowX"], (viewport, name, result)
                assert not result["interactiveSmall"], (viewport, name, result)
                assert not result["visibleInternalText"], (viewport, name, result)
                if name == "messages":
                    detail_text = page.locator("#auri-detail-body").inner_text()
                    assert result["effectiveActionFonts"], (viewport, result, detail_text)
                    assert min(result["effectiveActionFonts"]) >= 12, (viewport, result)
                    assert max(result["effectiveActionFonts"]) <= 22, (viewport, result)
                    assert "Demo" in detail_text and "模拟" in detail_text, detail_text
                    assert "20:00-21:00" in detail_text, detail_text
                if name == "tasks":
                    assert "Demo" in page.locator("#auri-detail-body").inner_text()
                path = OUTPUT / f"{viewport['width']}x{viewport['height']}-{name}.png"
                page.screenshot(path=path)
                report.append({"viewport": viewport, "page": name, "screenshot": str(path), **result})
                nested = None
                if name == "tasks":
                    nested = ("task-detail", ".auri-task-card")
                elif name == "messages":
                    nested = ("message-detail", ".auri-action-step")
                if nested:
                    nested_name, nested_selector = nested
                    page.locator(nested_selector).first.click()
                    page.wait_for_timeout(100)
                    nested_result = audit(page)
                    assert nested_result["panelInside"], (viewport, nested_name, nested_result)
                    assert not nested_result["bodyOverflowX"], (viewport, nested_name, nested_result)
                    assert not nested_result["interactiveSmall"], (viewport, nested_name, nested_result)
                    assert not nested_result["visibleInternalText"], (viewport, nested_name, nested_result)
                    if nested_name == "task-detail":
                        assert "地点 · Demo" in page.locator("#auri-detail-body").inner_text()
                        assert "联系人 · Demo" in page.locator("#auri-detail-body").inner_text()
                    if nested_name == "message-detail":
                        confirm = page.locator("[data-confirm-current]")
                        assert confirm.is_visible(), "待确认动作详情必须提供车机确认入口"
                        assert "确认全部" in confirm.inner_text()
                    nested_path = OUTPUT / f"{viewport['width']}x{viewport['height']}-{nested_name}.png"
                    page.screenshot(path=nested_path)
                    report.append({"viewport": viewport, "page": nested_name, "screenshot": str(nested_path), **nested_result})
                page.locator("#auri-driver-back").click()
            if viewport["width"] == 1920:
                standalone_order = copy.deepcopy(prepared_state)
                standalone_order["revision"] += 100
                standalone_order["actions"] = []
                standalone_order["confirmation"] = None
                page.evaluate("window.AURI_HMI_NEXT.disconnect()")
                assert page.evaluate("state => window.AURI_HMI_NEXT.applyState(state)", standalone_order) is not False
                page.locator('[data-auri-section="messages"]').click()
                standalone_text = page.locator("#auri-detail-body").inner_text()
                assert "配送方案" in standalone_text, standalone_text
                assert "0/0 已完成" not in standalone_text, standalone_text
                standalone_result = audit(page)
                assert not standalone_result["bodyOverflowX"], standalone_result
                assert not standalone_result["visibleInternalText"], standalone_result
                standalone_path = OUTPUT / "1920x1080-standalone-order.png"
                page.screenshot(path=standalone_path)
                report.append({"viewport": viewport, "page": "standalone-order", "screenshot": str(standalone_path), **standalone_result})
                page.locator("#auri-driver-back").click()

                product_state = copy.deepcopy(prepared_state)
                product_state["revision"] += 200
                product_state.pop("service_mock_mode", None)
                product_state["actions"] = []
                product_state["confirmation"] = None
                product_state["service_orders"] = []
                product_state["navigation"]["is_simulated"] = False
                assert page.evaluate("state => window.AURI_HMI_NEXT.applyState(state)", product_state) is not False
                if page.locator("#auri-driver-detail").is_visible():
                    page.locator("#auri-driver-back").click()
                    page.wait_for_function("document.querySelector('#auri-driver-detail')?.hidden === true")
                page.evaluate("window.AURI_HMI_NEXT.openPanel('tasks')")
                page.wait_for_function("document.querySelector('#auri-detail-title')?.textContent === '今日任务'")
                product_tasks_text = page.locator("#auri-detail-body").inner_text()
                assert "Demo" not in product_tasks_text, (
                    product_tasks_text,
                    page.evaluate("window.AURI_HMI_NEXT.getState()"),
                )
                page.locator(".auri-task-card").first.click()
                product_task_text = page.locator("#auri-detail-body").inner_text()
                assert "地点 · Demo" not in product_task_text
                assert "联系人 · Demo" not in product_task_text
                page.locator("#auri-driver-back").click()
            assert not errors, errors
            page.close()
        browser.close()
    print(json.dumps({"pages": report, "passed": True}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
