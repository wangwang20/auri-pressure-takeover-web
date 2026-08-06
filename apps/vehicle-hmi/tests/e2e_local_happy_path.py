"""Run the real HMI happy path against a dedicated local Agent instance.

This test resets the configured Agent session. Do not point it at the shared
public Agent.
"""

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib import error, request
from uuid import uuid4

from playwright.sync_api import sync_playwright


AGENT = os.getenv("AURI_AGENT_URL", "http://127.0.0.1:8795").rstrip("/")
HMI = os.getenv("AURI_HMI_URL", "http://127.0.0.1:5174/apps/vehicle-hmi/")
TOKEN = os.getenv("AURI_AGENT_TOKEN", "")
CHROME = os.getenv(
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE",
    str(Path.home() / ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
)
SCREENSHOT_DIR = Path(os.getenv("AURI_E2E_SCREENSHOT_DIR", "/tmp"))
TZ = timezone(timedelta(hours=8))


def api(path, method="GET", payload=None):
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if TOKEN:
        headers["X-Agent-Token"] = TOKEN
    req = request.Request(f"{AGENT}{path}", method=method, data=body, headers=headers)
    try:
        with request.urlopen(req, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8")
        raise AssertionError(f"{method} {path} failed: {exc.code} {detail}") from exc


def submit(event_type, payload, source="demo_console"):
    state = api("/v1/state")
    envelope = {
        "schema_version": "0.2.0",
        "event_id": f"hmi_e2e_{event_type}_{uuid4().hex[:10]}",
        "session_id": state["session_id"],
        "type": event_type,
        "source": source,
        "timestamp": datetime.now(TZ).isoformat(),
        "payload": payload,
    }
    return api("/v1/event", "POST", envelope)["state"]


def main():
    if "onrender.com" in AGENT:
        raise SystemExit("Refusing to reset a shared public Agent; use a dedicated local Agent URL.")
    api("/v1/session/reset", "POST", {"scenario_id": "hmi-local-e2e"})
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        page_errors = []
        page.on("pageerror", lambda item: page_errors.append(str(item)))
        config = json.dumps({"apiBase": AGENT, "token": TOKEN, "stream": True})
        page.add_init_script(
            f"window.AURI_HMI_CONFIG={config};"
            "try{localStorage.removeItem('auri-hmi-next-config')}catch(_e){};"
            "window.__auriSpoken=[];"
            "window.__systemSpeechCalls=[];"
            "window.SAFEDRIVER_CONFIG={...(window.SAFEDRIVER_CONFIG||{}),ttsKey:'e2e-tts-key',systemSpeechFallback:false};"
        )
        page.goto(HMI, wait_until="domcontentloaded", timeout=30000)
        page.evaluate(
            """() => {
              window.speakText=(text)=>{window.__auriSpoken.push(text);return Promise.resolve(true)};
              try {
                Object.defineProperty(window.speechSynthesis, 'speak', {
                  configurable: true,
                  value: utterance => window.__systemSpeechCalls.push(utterance?.text || '')
                });
              } catch (_error) {}
            }"""
        )
        page.wait_for_function(
            "window.AURI_HMI_NEXT?.getState().viewModel.lifecycle.stage === 'off_vehicle_idle'"
        )
        page.wait_for_function("window.AURI_HMI_NEXT?.getState().syncMode === 'streaming'")
        initial = page.evaluate("window.AURI_HMI_NEXT.getState()")
        assert initial["viewModel"]["tasks"]["total"] == 0
        assert page.locator("#auri-responsibility-strip").is_hidden()
        assert "等待手机创建今天的任务" in page.locator("#auri-driver-title").inner_text()
        assert page.locator("#auri-driver-task-count").inner_text() == "0 项"

        task_state = submit(
            "task.created", {"text": "今天18:10接孩子，之后去超市"}, "mobile"
        )
        assert task_state["navigation"]["task_id"] == "task_pickup_child"
        assert task_state["navigation"]["source"] == "demo_fixture"
        assert task_state["navigation"]["is_simulated"] is True
        page.wait_for_function("window.AURI_HMI_NEXT.getState().viewModel.tasks.total >= 2")
        assert page.evaluate(
            "window.AURI_HMI_NEXT.getState().viewModel.meta.revision"
        ) == task_state["revision"]
        displayed_route = page.evaluate("window.AURI_HMI_NEXT.getState().viewModel.navigation.route")
        assert displayed_route["id"] == task_state["navigation"]["route_id"]
        assert displayed_route["destination"]["coordinates"] == [120.7359, 31.3048]
        assert page.locator(".auri-responsibility-item").count() == 2
        assert page.locator(".auri-driver-task:not(.is-empty)").count() == 2
        responsibility_text = page.locator("#auri-responsibility-strip").inner_text()
        assert "接孩子" in responsibility_text
        assert "超市" in responsibility_text

        page.locator("#vd-nav-card").click(position={"x": 180, "y": 18})
        assert "行程详情" in page.locator("#auri-detail-title").inner_text()
        assert "阳光小学" in page.locator("#auri-detail-body").inner_text()
        assert page.locator("#auri-driver-panel").evaluate("node => node.classList.contains('is-detail')")
        integrated = page.evaluate(
            """() => {
              const driver=document.querySelector('#auri-driver-panel').getBoundingClientRect();
              const detail=document.querySelector('#auri-driver-detail').getBoundingClientRect();
              return {
                inside: detail.left >= driver.left && detail.right <= driver.right && detail.top >= driver.top && detail.bottom <= driver.bottom,
                legacyHidden: getComputedStyle(document.querySelector('#left-panel')).display === 'none'
              };
            }"""
        )
        assert integrated == {"inside": True, "legacyHidden": True}
        page.screenshot(path=SCREENSHOT_DIR / "auri-hmi-e2e-left-route.png")
        page.locator("#auri-driver-back").click()

        dock_details = {
            "tasks": "今日任务",
            "messages": "处理进度",
            "vehicle": "座舱状态",
        }
        for section, expected_title in dock_details.items():
            page.locator(f'[data-auri-section="{section}"]').click()
            assert expected_title in page.locator("#auri-detail-title").inner_text()
            assert page.locator("#auri-driver-detail").is_visible()
            assert page.locator("#left-panel").is_hidden()
            page.locator("#auri-driver-back").click()
            assert page.locator("#auri-driver-overview").is_visible()
        page.locator('[data-auri-section="home"]').click()
        assert page.locator("#auri-driver-detail").is_hidden()
        assert page.locator("#auri-driver-overview").is_visible()
        page.locator('[data-auri-section="navigation"]').click()
        assert page.locator("#auri-driver-detail").is_hidden()
        assert page.locator("#auri-driver-overview").is_visible()

        warning_state = submit("meeting.overrun", {"delay_minutes": 20})
        page.wait_for_function(
            "revision => window.AURI_HMI_NEXT.getState().viewModel.meta.revision >= revision",
            arg=warning_state["revision"],
        )
        assert warning_state["stage"] == "pre_departure_warning"
        page.wait_for_function("document.querySelector('#auri-device-notice')?.classList.contains('is-visible')")
        assert "腕表" in page.locator("#auri-device-notice").inner_text()
        page.wait_for_function("document.querySelector('#auri-stage-notice')?.classList.contains('is-visible')")
        assert "出发窗口正在缩短" in page.locator("#auri-stage-notice").inner_text()

        vehicle_state = submit("scene.vehicle_entered", {})
        page.wait_for_function(
            "window.AURI_HMI_NEXT.getState().viewModel.lifecycle.primarySurface === 'vehicle_hmi'"
        )
        assert vehicle_state["scene"] == "driving"
        page.wait_for_function("document.querySelector('#auri-device-notice')?.classList.contains('is-visible')")
        assert "腕表" in page.locator("#auri-device-notice").inner_text()
        page.wait_for_function("document.querySelector('#auri-stage-notice')?.classList.contains('is-visible')")
        stage_notice_text = page.locator("#auri-stage-notice").inner_text()
        assert any(text in stage_notice_text for text in ["路线正在同步到车机", "正在前往"])

        page.locator('[data-auri-section="home"]').click()
        page.locator('#auri-driver-overview [data-panel-target="sync"]').first.click()
        assert "设备同步" in page.locator("#auri-detail-title").inner_text()
        assert all(label in page.locator("#auri-detail-body").inner_text() for label in ["手机", "腕表", "车机"])
        page.screenshot(path=SCREENSHOT_DIR / "auri-hmi-e2e-left-sync.png")
        page.locator("#auri-driver-back").click()

        rigid = next(
            (task for task in vehicle_state["tasks"] if task.get("task_type") == "rigid"),
            None,
        )
        scheduled = (
            datetime.fromisoformat(rigid["scheduled_at"])
            if rigid and rigid.get("scheduled_at")
            else datetime.now(TZ)
        )
        traffic_state = submit(
            "traffic.updated",
            {"eta": (scheduled + timedelta(minutes=18)).isoformat(), "late_minutes": 18},
        )
        page.wait_for_function(
            "window.AURI_HMI_NEXT.getState().viewModel.risk.lateMinutes === 18"
        )
        assert traffic_state["risk"]["pressure_level"] == "L2"

        prepared = submit(
            "user.utterance",
            {"text": "我还来得及吗？帮我处理", "input_mode": "voice"},
            "mobile",
        )
        page.wait_for_function(
            "window.AURI_HMI_NEXT.getState().viewModel.lifecycle.stage === 'waiting_confirmation'"
        )
        assert prepared["confirmation"]["owner_surface"] == "vehicle_hmi"
        assert page.locator("#auri-takeover-confirm").is_enabled()
        assert "预计晚到 18 分钟" in page.locator("#auri-takeover-risk").inner_text()
        assert "我还来得及吗" in page.locator("#auri-driver-utterance").inner_text()
        assert page.locator("#auri-takeover-conclusion").inner_text() == "无法准点，预计晚到 18 分钟"
        assert "下一步你说" not in page.locator("#auri-driver-panel").inner_text()
        assert page.locator(".auri-takeover-action").count() == len(prepared["actions"])
        action_metrics = page.evaluate(
            """() => Array.from(document.querySelectorAll('.auri-takeover-action')).map(node => {
              const rect=node.getBoundingClientRect(); const style=getComputedStyle(node);
              const topNode=document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
              return {top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height,display:style.display,visibility:style.visibility,opacity:style.opacity,topTag:topNode?.tagName,topClass:topNode?.className||'',topId:topNode?.id||'',uncovered:node.contains(topNode)};
            })"""
        )
        assert all(
            item["height"] > 0
            and item["width"] > 0
            and item["display"] != "none"
            and item["visibility"] == "visible"
            and float(item["opacity"]) > 0.9
            and item["uncovered"]
            for item in action_metrics
        ), action_metrics
        assert float(page.locator("#auri-takeover-card").evaluate("node => getComputedStyle(node).opacity")) > 0.9
        page.wait_for_timeout(400)
        page.screenshot(path=SCREENSHOT_DIR / "auri-hmi-e2e-waiting-confirmation.png")
        ready_speech = page.evaluate("window.__auriSpoken")
        assert len(ready_speech) == 1, ready_speech
        assert "AURI 已准备处理方案" in ready_speech[0], ready_speech
        assert page.evaluate("window.__systemSpeechCalls.length") == 0

        page.locator("#auri-takeover-confirm").click()
        page.wait_for_function(
            "window.AURI_HMI_NEXT.getState().viewModel.lifecycle.stage === 'action_completed'",
            timeout=15000,
        )
        completed = api("/v1/state")
        shown = page.evaluate("window.AURI_HMI_NEXT.getState().viewModel")
        assert shown["meta"]["revision"] == completed["revision"]
        assert all(action["status"] == "completed" for action in completed["actions"])
        page.wait_for_timeout(200)
        completed_speech = page.evaluate("window.__auriSpoken")
        assert len(completed_speech) == 2, completed_speech
        assert "AURI 已完成处理" in completed_speech[1], completed_speech
        assert page.evaluate("window.__systemSpeechCalls.length") == 0

        # A revision-only update must not enqueue the same completion speech.
        revision_only = submit("service.mock.config", {"mode": "success"})
        page.wait_for_function(
            "revision => window.AURI_HMI_NEXT.getState().viewModel.meta.revision === revision",
            arg=revision_only["revision"],
        )
        page.wait_for_timeout(800)
        assert page.evaluate("window.__auriSpoken.length") == 2, page.evaluate("window.__auriSpoken")

        submit("cooldown.elapsed", {})
        page.wait_for_function(
            "window.AURI_HMI_NEXT.getState().viewModel.lifecycle.stage === 'cooldown'"
        )
        assert page.locator("#vd-nav-card").is_visible()
        page.wait_for_function(
            "document.querySelector('#auri-stage-notice')?.classList.contains('is-visible')"
        )
        assert page.locator("#auri-stage-notice").is_visible()
        assert "AURI 已降低打扰" in page.locator("#auri-stage-notice").inner_text()

        parked = submit("scene.parked", {})
        page.wait_for_function(
            "window.AURI_HMI_NEXT.getState().viewModel.lifecycle.stage === 'parked_review'"
        )
        assert parked["primary_surface"] == "mobile"
        assert page.locator("#auri-takeover-card").is_visible()
        assert page.locator("#vd-nav-card").is_visible()
        assert "手机继续处理" in page.locator("#auri-takeover-stage").inner_text()
        page.wait_for_timeout(400)
        page.screenshot(path=SCREENSHOT_DIR / "auri-hmi-e2e-parked-review.png")

        final_state = page.evaluate("window.AURI_HMI_NEXT.getState()")
        assert final_state["syncMode"] == "streaming"
        assert not page_errors, page_errors
        print(json.dumps({
            "session_id": parked["session_id"],
            "initial_revision": initial["viewModel"]["meta"]["revision"],
            "final_revision": parked["revision"],
            "tasks": len(parked["tasks"]),
            "actions": len(parked["actions"]),
            "final_stage": parked["stage"],
            "sync_mode": final_state["syncMode"],
            "javascript_errors": len(page_errors),
        }, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    main()
