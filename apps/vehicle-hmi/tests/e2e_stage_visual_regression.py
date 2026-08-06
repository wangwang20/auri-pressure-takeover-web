"""Capture official HMI visuals across real and read-only fixture stages.

The test is intentionally destructive to the configured Agent session, so it
only accepts the dedicated local Agent at 127.0.0.1:8795. Nine stable stages
come from real Agent events. Transient/error stages are rendered from one real
waiting-confirmation snapshot with monotonically increasing local revisions;
those fixtures are injected into a disconnected HMI and never written back.
"""

from __future__ import annotations

import copy
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib import error, parse, request
from uuid import uuid4

from playwright.sync_api import Page, sync_playwright


AGENT = os.getenv("AURI_AGENT_URL", "http://127.0.0.1:8795").rstrip("/")
HMI = os.getenv(
    "AURI_HMI_URL", "http://127.0.0.1:5174/apps/vehicle-hmi/"
)
TOKEN = os.getenv("AURI_AGENT_TOKEN", "")
CHROME = os.getenv(
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE",
    str(Path.home() / ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
)
OUTPUT_DIR = Path(
    os.getenv("AURI_VISUAL_REGRESSION_DIR", "/tmp/auri-hmi-stage-visual-regression")
)
SUMMARY_PATH = OUTPUT_DIR / "summary.json"
TZ = timezone(timedelta(hours=8))
VIEWPORT = {"width": 1920, "height": 1080}
REAL_STAGES = [
    "off_vehicle_idle",
    "pre_departure_warning",
    "handover_to_vehicle",
    "vehicle_observation",
    "takeover_L2",
    "waiting_confirmation",
    "action_completed",
    "cooldown",
    "parked_review",
]
FIXTURE_STAGES = [
    "takeover_L3",
    "planning",
    "service_prepared",
    "executing",
    "service_executed",
    "error",
]
KEY_CONTAINERS = [
    "#hmi",
    ".top-bar",
    ".hmi-body",
    "#auri-driver-panel",
    ".auri-driver-summary",
    "#auri-driver-context",
    ".auri-driver-tasks",
    "#vd-panel",
    ".vd-half-top",
    ".vd-half-bot",
    ".right-panel",
    ".map-design",
    "#auri-nav-hud",
    ".bottom-bar",
    "#vd-nav-card",
    "#auri-responsibility-strip",
    "#auri-takeover-card",
    "#auri-stage-notice",
    "#auri-device-notice",
]

NOTICE_STAGES = {
    "pre_departure_warning",
    "handover_to_vehicle",
    "vehicle_observation",
    "takeover_L2",
    "takeover_L3",
    "planning",
    "service_prepared",
    "waiting_confirmation",
    "action_completed",
    "cooldown",
    "parked_review",
}


def validate_agent_url() -> None:
    parsed = parse.urlparse(AGENT)
    if "onrender" in parsed.netloc.lower():
        raise SystemExit("Refusing onrender: visual regression may reset only a local Agent.")
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise SystemExit("AURI_AGENT_URL must be the dedicated local HTTP Agent.")
    if parsed.port != 8795:
        raise SystemExit("AURI_AGENT_URL must use the isolated local Agent port 8795.")


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
    except error.URLError as exc:
        raise AssertionError(
            "Dedicated Agent is unavailable at http://127.0.0.1:8795. "
            "Start it before running this regression test."
        ) from exc


def submit(event_type: str, payload: dict, source: str = "demo_console") -> dict:
    state = api("/v1/state")
    envelope = {
        "schema_version": "0.2.0",
        "event_id": f"hmi_visual_{event_type.replace('.', '_')}_{uuid4().hex[:10]}",
        "session_id": state["session_id"],
        "type": event_type,
        "source": source,
        "timestamp": datetime.now(TZ).isoformat(),
        "payload": payload,
    }
    accepted = api("/v1/event", "POST", envelope)
    assert accepted["accepted"] is True
    assert accepted["duplicate"] is False
    return accepted["state"]


def configure_page(page: Page, *, connect: bool) -> None:
    config = json.dumps(
        {
            "apiBase": AGENT,
            "token": TOKEN,
            "stream": True,
            "mapProvider": "offline",
            "amapKey": "",
            "amapSecurityJsCode": "",
        }
    )
    page.add_init_script(
        f"window.AURI_HMI_CONFIG={config};"
        "try{localStorage.removeItem('auri-hmi-next-config')}catch(_e){};"
        "try{sessionStorage.clear()}catch(_e){};"
        "window.__auriSpoken=[];"
        "window.AURI_HMI_SPEECH_ADAPTER={speak:(text)=>{window.__auriSpoken.push(text);return true}};"
    )
    target = HMI if connect else f"{HMI}{'&' if '?' in HMI else '?'}offline=1"
    page.goto(target, wait_until="load", timeout=30000)
    page.wait_for_function("window.AURI_HMI_NEXT && document.querySelector('#hmi')")
    page.wait_for_function("document.fonts?.status === 'loaded'", timeout=15000)
    page.wait_for_function(
        "Array.from(document.images).every((image) => image.complete)", timeout=15000
    )


def wait_for_snapshot(page: Page, state: dict) -> None:
    page.wait_for_function(
        "expected => {"
        " const current=window.AURI_HMI_NEXT?.getState();"
        " return current?.viewModel?.lifecycle?.stage===expected.stage"
        "   && current?.viewModel?.meta?.revision===expected.revision;"
        "}",
        arg={"stage": state["stage"], "revision": state["revision"]},
        timeout=20000,
    )


def freeze_visuals(page: Page) -> None:
    page.evaluate(
        """() => {
          window.mapCarStop?.();
          document.getElementById('__auri_visual_freeze')?.remove();
          const style=document.createElement('style');
          style.id='__auri_visual_freeze';
          style.textContent='*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}';
          document.head.appendChild(style);
        }"""
    )
    page.wait_for_timeout(80)


def unfreeze_visuals(page: Page) -> None:
    page.evaluate("document.getElementById('__auri_visual_freeze')?.remove()")


def audit_layout(page: Page) -> dict:
    result = page.evaluate(
        """selectors => {
          const viewport={width:window.innerWidth,height:window.innerHeight};
          const visible=node=>{
            const style=getComputedStyle(node);
            const rect=node.getBoundingClientRect();
            return !node.hidden && style.display!=='none' && style.visibility!=='hidden'
              && Number(style.opacity||1)>0.001 && rect.width>0 && rect.height>0;
          };
          const rows=[];
          selectors.forEach(selector=>{
            document.querySelectorAll(selector).forEach((node,index)=>{
              if(!visible(node)) return;
              const rect=node.getBoundingClientRect();
              const inCanvas=rect.left>=-1 && rect.top>=-1
                && rect.right<=viewport.width+1 && rect.bottom<=viewport.height+1;
              const overflowX=node.scrollWidth>node.clientWidth+1;
              const overflowY=node.scrollHeight>node.clientHeight+1;
              rows.push({
                selector,index,
                rect:{
                  left:Math.round(rect.left*10)/10,top:Math.round(rect.top*10)/10,
                  right:Math.round(rect.right*10)/10,bottom:Math.round(rect.bottom*10)/10,
                  width:Math.round(rect.width*10)/10,height:Math.round(rect.height*10)/10
                },
                client:{width:node.clientWidth,height:node.clientHeight},
                scroll:{width:node.scrollWidth,height:node.scrollHeight},
                inCanvas,overflowX,overflowY
              });
            });
          });
          const brokenImages=Array.from(document.images)
            .filter(image=>image.complete && image.naturalWidth===0)
            .map(image=>image.getAttribute('src')||'');
          return {
            viewport,
            containers:rows,
            outOfCanvas:rows.filter(row=>!row.inCanvas),
            internalOverflow:rows.filter(row=>row.overflowX||row.overflowY),
            brokenImages
          };
        }""",
        KEY_CONTAINERS,
    )
    intentional_overflow = {".map-design", ".vd-half-bot"}
    result["intentionalOverflow"] = [
        row for row in result["internalOverflow"] if row["selector"] in intentional_overflow
    ]
    result["internalOverflow"] = [
        row for row in result["internalOverflow"] if row["selector"] not in intentional_overflow
    ]
    assert result["containers"], "No visible key containers were audited"
    assert not result["outOfCanvas"], result["outOfCanvas"]
    assert not result["internalOverflow"], result["internalOverflow"]
    assert not result["brokenImages"], result["brokenImages"]
    return result


def route_transform(page: Page) -> str:
    value = page.locator(".map-design .map-scroll-layer").get_attribute("transform")
    assert value and "translate" in value, "Offline route transform was not initialized"
    return value


def capture(page: Page, state: dict, index: int, source: str) -> dict:
    wait_for_snapshot(page, state)
    # Offline mapCarTo uses an 1150 ms stage tween. Allow it to reach the
    # stage target before freezing the visual baseline.
    page.wait_for_timeout(1320)
    freeze_visuals(page)
    transform = route_transform(page)
    audit = audit_layout(page)
    quality = page.evaluate(
        """() => {
          const rect=selector=>{
            const node=document.querySelector(selector);
            if(!node) return null;
            const box=node.getBoundingClientRect();
            return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height};
          };
          const visible=selector=>{
            const node=document.querySelector(selector);
            if(!node || node.hidden) return false;
            const style=getComputedStyle(node);
            const box=node.getBoundingClientRect();
            return style.display!=='none' && style.visibility!=='hidden' && Number(style.opacity||1)>.01 && box.width>0 && box.height>0;
          };
          const iconSelectors=['.auri-shell-row-icon','.auri-notice-icon','.auri-stage-notice-icon','.auri-takeover-action>span','.auri-driver-task-icon','.auri-driver-context-icon'];
          const iconTexts=iconSelectors.flatMap(selector=>Array.from(document.querySelectorAll(selector))).filter(node=>visibleNode(node)).map(node=>node.textContent.trim()).filter(Boolean);
          const actionRows=Array.from(document.querySelectorAll('.auri-takeover-action')).filter(node=>visibleNode(node)).map(node=>{
            const copy=node.querySelector('.auri-takeover-action-copy');
            const title=copy?.querySelector('b');
            const box=copy?.getBoundingClientRect();
            return {title:title?.textContent.trim()||'',copyWidth:box?.width||0,titleFontPx:Number.parseFloat(getComputedStyle(title).fontSize)||0};
          });
          const planSection=document.querySelector('.auri-takeover-section-head');
          const planNotice=document.querySelector('#auri-stage-notice');
          const confirm=document.querySelector('#auri-takeover-confirm');
          const confirmRect=confirm?.getBoundingClientRect();
          function visibleNode(node){
            const style=getComputedStyle(node); const box=node.getBoundingClientRect();
            return !node.hidden && style.display!=='none' && style.visibility!=='hidden' && box.width>0 && box.height>0;
          }
          return {
            driver:rect('#auri-driver-panel'), vehicle:rect('#vd-panel'), map:rect('.right-panel'), dock:rect('.bottom-bar'),
            driverVisible:visible('#auri-driver-panel'), navCardVisible:visible('#vd-nav-card'), navHudVisible:visible('#auri-nav-hud'),
            stageNoticeVisible:visible('#auri-stage-notice'), deviceNoticeVisible:visible('#auri-device-notice'),
            processPoisVisible:visible('.map-poi-layer'), iconTexts, actionRows,
            planSectionText:planSection?.textContent.replace(/\\s+/g,' ').trim()||'',
            planNoticeText:planNotice?.textContent.replace(/\\s+/g,' ').trim()||'',
            planNoticeReady:planNotice?.classList.contains('is-plan-ready')||false,
            confirmVisible:visible('#auri-takeover-confirm'),
            confirmHeight:confirmRect?.height||0,
            bottomLauncherVisible:visible('.sidebar')
          };
        }"""
    )
    assert quality["driverVisible"] is True, quality
    assert quality["navCardVisible"] is True, quality
    assert quality["navHudVisible"] is True, quality
    assert quality["bottomLauncherVisible"] is False, quality
    assert quality["processPoisVisible"] is False, quality
    assert quality["driver"]["right"] <= quality["map"]["left"] + 1, quality
    assert quality["map"]["right"] <= quality["vehicle"]["left"] + 1, quality
    assert quality["map"]["right"] <= quality["dock"]["right"] + 1, quality
    banned_icons = {"声", "腕", "表", "联", "刚", "弹", "信", "单", "路", "务", "返", "调", "距", "温"}
    assert not banned_icons.intersection(quality["iconTexts"]), quality
    assert all(len(row["title"]) >= 2 and row["copyWidth"] >= 100 for row in quality["actionRows"]), quality
    if state["stage"] in {"service_prepared", "waiting_confirmation", "action_completed"}:
        assert "Agent 处理方案" in quality["planSectionText"], quality
        assert quality["actionRows"], quality
        assert min(row["titleFontPx"] for row in quality["actionRows"]) >= 20, quality
    if state["stage"] == "waiting_confirmation":
        assert quality["confirmVisible"] is True, quality
        assert quality["confirmHeight"] >= 80, quality
    if state["stage"] in {"service_prepared", "waiting_confirmation"}:
        assert quality["stageNoticeVisible"] is True, quality
        assert quality["deviceNoticeVisible"] is False, quality
        assert quality["planNoticeReady"] is True, quality
        assert "AURI 处理方案已准备" in quality["planNoticeText"], quality
    # Stage and device notifications share one visual lane. Showing both at
    # once recreates the map occlusion this regression is intended to catch.
    assert not (
        quality["stageNoticeVisible"] and quality["deviceNoticeVisible"]
    ), quality
    if state["stage"] in NOTICE_STAGES:
        assert (
            quality["stageNoticeVisible"] or quality["deviceNoticeVisible"]
        ), quality
    occlusion = page.evaluate(
        """() => {
          const sample=(selector,xRatio=.5,yRatio=.5)=>{
            const target=document.querySelector(selector);
            if(!target) return {selector,missing:true};
            const rect=target.getBoundingClientRect();
            const x=rect.left+rect.width*xRatio;
            const y=rect.top+rect.height*yRatio;
            const stack=document.elementsFromPoint(x,y).slice(0,6).map(node=>({
              tag:node.tagName,
              id:node.id||'',
              className:typeof node.className==='string'?node.className:''
            }));
            const visible=stack.some(node=>node.id===target.id || String(node.className).split(/\\s+/).some(name=>target.classList.contains(name)));
            return {selector,x,y,visible,stack};
          };
          const takeover=document.querySelector('#auri-takeover-card:not([hidden])');
          return [
            sample('.auri-wordmark'),
            sample('.vd-half-top'),
            sample(takeover ? '#auri-takeover-card' : '#vd-nav-card')
          ];
        }"""
    )
    assert all(item.get("visible") for item in occlusion), occlusion
    filename = f"{index:02d}-{source}-{state['stage']}-r{state['revision']}.png"
    destination = OUTPUT_DIR / filename
    page.screenshot(path=destination, full_page=False)
    assert destination.exists() and destination.stat().st_size > 0
    return {
        "index": index,
        "source": source,
        "stage": state["stage"],
        "scene": state["scene"],
        "revision": state["revision"],
        "screenshot": str(destination),
        "route_transform": transform,
        "displayed_speed": page.locator("#vd-speed").inner_text(),
        "visible_container_count": len(audit["containers"]),
        "layout": {
            "out_of_canvas": len(audit["outOfCanvas"]),
            "internal_overflow": len(audit["internalOverflow"]),
            "broken_images": len(audit["brokenImages"]),
        },
        "quality": quality,
        "occlusion": occlusion,
    }


def fixture_from(base: dict, stage: str, revision: int) -> dict:
    fixture = copy.deepcopy(base)
    fixture["stage"] = stage
    fixture["revision"] = revision
    fixture["updated_at"] = datetime.now(TZ).isoformat()
    fixture["primary_surface"] = "vehicle_hmi"
    fixture["scene"] = "driving"
    fixture["output"] = {
        "message_id": f"fixture_{stage}_{revision}",
        "priority": "high",
        "owner_surface": "vehicle_hmi",
        "suppressed_surfaces": ["mobile", "wearable"],
        "expires_at": (datetime.now(TZ) + timedelta(minutes=10)).isoformat(),
        "requires_confirmation": False,
        "conclusion": "AURI 正在持续处理当前行程风险。",
    }

    if stage == "takeover_L3":
        fixture["scene"] = "high_load_driving"
        fixture["risk"] = {
            "pressure_level": "L3",
            "late_minutes": max(18, fixture["risk"]["late_minutes"]),
            "reason_codes": ["RISK_MULTI_SOURCE_HIGH_LOAD"],
            "auxiliary_signals": ["WEARABLE_HIGH_TREND", "DRIVING_HARSH_BRAKE"],
        }
        fixture["wearable"].update(
            mode="warning", text="高负荷保护", color="red", haptic="error_once"
        )
        fixture["output"].update(
            priority="critical", conclusion="已进入高负荷保护，非必要内容已暂停。"
        )
        fixture["confirmation"] = None
    elif stage == "planning":
        fixture["confirmation"] = None
        for action in fixture["actions"]:
            action["status"] = "planned"
        fixture["output"]["conclusion"] = "正在核对 ETA、任务优先级和可执行方案。"
    elif stage == "service_prepared":
        fixture["confirmation"] = None
        for action in fixture["actions"]:
            action["status"] = "ready"
        for order in fixture["service_orders"]:
            order["status"] = "preview"
        fixture["output"]["conclusion"] = "消息、任务调整和生活服务方案已经准备。"
    elif stage == "executing":
        fixture["confirmation"]["status"] = "accepted"
        fixture["confirmation"]["confirmed_by"] = "vehicle_hmi"
        fixture["output"]["conclusion"] = "正在执行已确认的消息与生活服务方案。"
    elif stage == "service_executed":
        fixture["confirmation"]["status"] = "accepted"
        fixture["confirmation"]["confirmed_by"] = "vehicle_hmi"
        for action in fixture["actions"]:
            action["status"] = "completed"
        for order in fixture["service_orders"]:
            order["status"] = "submitted"
            order["order_id"] = order.get("order_id") or f"fixture_order_{revision}"
        fixture["output"]["conclusion"] = "消息与生活服务已执行，正在同步结果。"
    elif stage == "error":
        fixture["confirmation"] = None
        fixture["risk"]["reason_codes"] = ["SERVICE_EXECUTION_ERROR"]
        if fixture["actions"]:
            fixture["actions"][0]["status"] = "failed"
            fixture["actions"][0]["error_code"] = "NOT_FOUND"
        if fixture["service_orders"]:
            fixture["service_orders"][0]["status"] = "failed"
            fixture["service_orders"][0]["error_code"] = "NOT_FOUND"
        fixture["wearable"].update(
            mode="error", text="服务连接异常", color="red", haptic="error_once"
        )
        fixture["output"].update(
            priority="critical", conclusion="服务暂不可用，任务与消息方案已保留。"
        )
    return fixture


def assert_real_route_progression(captures: list[dict]) -> dict:
    transforms = [item["route_transform"] for item in captures]
    transitions = [
        {
            "from": captures[index - 1]["stage"],
            "to": captures[index]["stage"],
            "changed": transforms[index - 1] != transforms[index],
        }
        for index in range(1, len(captures))
    ]
    moving_targets = {"vehicle_observation", "action_completed", "cooldown"}
    missing_motion = [
        item for item in transitions if item["to"] in moving_targets and not item["changed"]
    ]
    assert not missing_motion, f"Offline route did not advance during driving: {missing_motion}"
    congestion_holds = [
        item for item in transitions
        if item["from"] == "takeover_L2" and item["to"] == "waiting_confirmation"
    ]
    assert congestion_holds and not congestion_holds[0]["changed"], congestion_holds
    assert len(set(transforms)) >= 4
    return {
        "selector": ".map-design .map-scroll-layer",
        "unique_transforms": len(set(transforms)),
        "expected_motion_targets": sorted(moving_targets),
        "congestion_hold_verified": True,
        "transitions": transitions,
    }


def main() -> None:
    validate_agent_url()
    health = api("/health")
    assert health.get("status") == "ok", health
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    reset = api("/v1/session/reset", "POST", {"scenario_id": "hmi-stage-visual-regression"})

    scheduled = datetime.now(TZ) + timedelta(hours=2)
    task_state = submit(
        "task.created",
        {
            "tasks": [
                {
                    "task_id": "visual_school_pickup",
                    "title": "接孩子",
                    "scheduled_at": scheduled.isoformat(),
                    "location": "阳光小学",
                    "task_type": "rigid",
                    "priority": "high",
                    "adjustable": False,
                    "status": "pending",
                    "waiting_party": ["王老师", "孩子妈妈"],
                    "capability_tags": ["school_pickup", "message_drafting"],
                },
                {
                    "task_id": "visual_grocery",
                    "title": "去超市采购",
                    "scheduled_at": (scheduled + timedelta(minutes=35)).isoformat(),
                    "location": "邻里生鲜超市",
                    "task_type": "flexible",
                    "priority": "medium",
                    "adjustable": True,
                    "status": "pending",
                    "waiting_party": [],
                    "capability_tags": ["grocery_delivery"],
                },
            ]
        },
        "mobile",
    )
    assert task_state["stage"] == "off_vehicle_idle"

    summary: dict = {
        "agent_url": AGENT,
        "hmi_url": HMI,
        "viewport": VIEWPORT,
        "session_id": reset["session_id"],
        "schema_version": reset["schema_version"],
        "real_stage_count": len(REAL_STAGES),
        "fixture_stage_count": len(FIXTURE_STAGES),
        "captures": [],
        "javascript_errors": {"real": [], "fixture": []},
    }

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        context = browser.new_context(viewport=VIEWPORT, device_scale_factor=1)
        real_page = context.new_page()
        real_page.on(
            "pageerror", lambda item: summary["javascript_errors"]["real"].append(str(item))
        )
        configure_page(real_page, connect=True)
        real_page.wait_for_function(
            "window.AURI_HMI_NEXT?.getState().syncMode === 'streaming'", timeout=20000
        )

        real_captures: list[dict] = []

        def capture_real(state: dict) -> None:
            item = capture(real_page, state, len(summary["captures"]) + 1, "real")
            real_captures.append(item)
            summary["captures"].append(item)
            unfreeze_visuals(real_page)

        capture_real(task_state)
        warning = submit("meeting.overrun", {"delay_minutes": 20})
        capture_real(warning)
        handover = submit("scene.approaching", {})
        capture_real(handover)
        observation = submit("scene.vehicle_entered", {})
        capture_real(observation)
        takeover = submit(
            "traffic.updated",
            {"eta": (scheduled + timedelta(minutes=18)).isoformat(), "late_minutes": 18},
        )
        capture_real(takeover)
        offline_traffic = real_page.evaluate(
            """() => Array.from(document.querySelectorAll('.map-route-traffic')).map(node => ({
              display:getComputedStyle(node).display,
              stroke:getComputedStyle(node).stroke,
              className:node.getAttribute('class')
            }))"""
        )
        assert len(offline_traffic) == 3, offline_traffic
        assert all(item["display"] != "none" for item in offline_traffic), offline_traffic
        assert len({item["stroke"] for item in offline_traffic}) == 3, offline_traffic
        summary["offline_congestion_colors"] = offline_traffic
        waiting = submit(
            "user.utterance",
            {"text": "我还来得及吗？帮我处理", "input_mode": "voice"},
            "mobile",
        )
        assert waiting["confirmation"]["owner_surface"] == "vehicle_hmi"
        capture_real(waiting)
        ready_speech = real_page.evaluate("window.__auriSpoken")
        assert len(ready_speech) == 1, ready_speech
        assert "AURI 已准备处理方案" in ready_speech[0], ready_speech
        assert "2条消息和1项配送方案已准备" in ready_speech[0], ready_speech

        real_page.locator("#auri-takeover-confirm").click()
        real_page.wait_for_function(
            "window.AURI_HMI_NEXT.getState().viewModel.lifecycle.stage === 'action_completed'",
            timeout=20000,
        )
        completed = api("/v1/state")
        capture_real(completed)
        completed_speech = real_page.evaluate("window.__auriSpoken")
        assert len(completed_speech) == 2, completed_speech
        assert "AURI 已完成处理" in completed_speech[1], completed_speech
        summary["speech_briefings"] = {
            "ready": ready_speech[0],
            "completed": completed_speech[1],
            "dynamic_world_state": True,
            "duplicate_count": 0,
        }
        cooldown = submit("cooldown.elapsed", {})
        capture_real(cooldown)
        parked = submit("scene.parked", {})
        capture_real(parked)
        summary["offline_route_animation"] = assert_real_route_progression(real_captures)
        for item in real_captures:
            speed = int(item["displayed_speed"])
            if item["stage"] in {"vehicle_observation", "action_completed", "cooldown"}:
                assert 0 < speed <= 42, item
            else:
                assert speed == 0, item

        fixture_page = context.new_page()
        fixture_page.on(
            "pageerror",
            lambda item: summary["javascript_errors"]["fixture"].append(str(item)),
        )
        configure_page(fixture_page, connect=False)
        assert fixture_page.evaluate("window.AURI_HMI_NEXT.getState().syncMode") == "idle"
        next_revision = parked["revision"] + 1
        fixture_revisions = []
        for stage in FIXTURE_STAGES:
            fixture = fixture_from(waiting, stage, next_revision)
            applied = fixture_page.evaluate(
                "state => window.AURI_HMI_NEXT.applyState(state)", fixture
            )
            assert applied is not False, f"Fixture rejected for {stage}"
            item = capture(
                fixture_page, fixture, len(summary["captures"]) + 1, "fixture"
            )
            summary["captures"].append(item)
            fixture_revisions.append(next_revision)
            next_revision += 1
            unfreeze_visuals(fixture_page)

        summary["fixture_contract"] = {
            "base_stage": waiting["stage"],
            "base_revision": waiting["revision"],
            "agent_revision_before_fixtures": parked["revision"],
            "fixture_revisions": fixture_revisions,
            "strictly_increasing": fixture_revisions == sorted(set(fixture_revisions)),
            "write_requests": 0,
            "fixture_page_sync_mode": fixture_page.evaluate(
                "window.AURI_HMI_NEXT.getState().syncMode"
            ),
        }
        assert summary["fixture_contract"]["strictly_increasing"]
        assert api("/v1/state")["revision"] == parked["revision"]
        assert not summary["javascript_errors"]["real"], summary["javascript_errors"]["real"]
        assert not summary["javascript_errors"]["fixture"], summary["javascript_errors"]["fixture"]
        assert [item["stage"] for item in real_captures] == REAL_STAGES
        assert [item["stage"] for item in summary["captures"][len(REAL_STAGES):]] == FIXTURE_STAGES
        assert all(item["layout"]["out_of_canvas"] == 0 for item in summary["captures"])
        assert all(item["layout"]["internal_overflow"] == 0 for item in summary["captures"])
        browser.close()

    summary["passed"] = True
    SUMMARY_PATH.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
