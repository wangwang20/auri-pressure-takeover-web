"""Validate the official HMI at the 1920x720 cockpit target.

The test is destructive and therefore accepts only the isolated local Agent
on port 8795. It verifies physical pixel sizes, full-canvas rendering and the
UTC-to-Shanghai ETA shown in generated message drafts.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib import parse, request
from uuid import uuid4

from playwright.sync_api import sync_playwright


AGENT = os.getenv("AURI_AGENT_URL", "http://127.0.0.1:8795").rstrip("/")
TOKEN = os.getenv("AURI_AGENT_TOKEN", "test-shared-token")
HMI = os.getenv("AURI_HMI_URL", "http://127.0.0.1:5174/apps/vehicle-hmi/")
CHROME = os.getenv(
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE",
    str(Path.home() / ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
)
OUTPUT = Path(os.getenv("AURI_ULTRAWIDE_DIR", "/tmp/auri-hmi-ultrawide"))
TZ = timezone(timedelta(hours=8))


def api(path: str, method: str = "GET", payload: dict | None = None) -> dict:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
    req = request.Request(
        f"{AGENT}{path}",
        method=method,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Agent-Token": TOKEN,
        },
    )
    with request.urlopen(req, timeout=15) as response:
        return json.loads(response.read().decode())


def submit(event_type: str, payload: dict, source: str = "demo_console") -> dict:
    state = api("/v1/state")
    envelope = {
        "schema_version": "0.2.0",
        "event_id": f"ultrawide_{event_type.replace('.', '_')}_{uuid4().hex[:10]}",
        "session_id": state["session_id"],
        "type": event_type,
        "source": source,
        "timestamp": datetime.now(TZ).isoformat(),
        "payload": payload,
    }
    return api("/v1/event", "POST", envelope)["state"]


def main() -> None:
    parsed = parse.urlparse(AGENT)
    if parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.port != 8795:
        raise SystemExit("This destructive test only accepts the isolated local Agent on port 8795.")

    api("/v1/session/reset", "POST", {"scenario_id": "hmi-ultrawide"})
    scheduled = datetime(2026, 8, 3, 18, 10, tzinfo=TZ)
    submit(
        "task.created",
        {
            "text": "今天18:10接孩子，之后去超市",
            "tasks": [
                {
                    "task_id": "task_pickup_child",
                    "title": "接孩子",
                    "scheduled_at": scheduled.isoformat(),
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
                    "scheduled_at": (scheduled + timedelta(hours=1, minutes=20)).isoformat(),
                    "location": None,
                    "task_type": "flexible",
                    "priority": "low",
                    "adjustable": True,
                    "status": "pending",
                    "waiting_party": [],
                    "capability_tags": ["grocery_delivery"],
                },
            ],
        },
        "mobile",
    )
    submit("meeting.overrun", {"delay_minutes": 20})
    submit("scene.approaching", {})
    submit("scene.vehicle_entered", {})
    # Match the Console's ISO serialization: 18:28+08:00 becomes 10:28Z.
    submit("traffic.updated", {"eta": "2026-08-03T10:28:00.000Z", "late_minutes": 18})
    submit("wearable.signal", {"heart_rate": 120, "confidence": 0.9}, "wearable")
    waiting = submit(
        "user.utterance",
        {"text": "我还来得及吗？帮我处理", "input_mode": "voice"},
        "mobile",
    )
    assert waiting["stage"] == "waiting_confirmation"
    summaries = "\n".join(action["summary"] for action in waiting["actions"])
    assert "预计18:28到" in summaries, summaries
    assert "预计10:28到" not in summaries, summaries

    OUTPUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        page = browser.new_page(viewport={"width": 1920, "height": 720})
        errors: list[str] = []
        page.on("pageerror", lambda item: errors.append(str(item)))
        config = json.dumps(
            {"apiBase": AGENT, "token": TOKEN, "stream": True, "mapProvider": "offline"}
        )
        page.add_init_script(
            f"window.AURI_HMI_CONFIG={config};"
            "try{localStorage.clear()}catch(_e){};"
            "try{sessionStorage.clear()}catch(_e){}"
        )
        page.goto(HMI, wait_until="load", timeout=30000)
        page.wait_for_function(
            "window.AURI_HMI_NEXT?.getState().viewModel.lifecycle.stage === 'waiting_confirmation'",
            timeout=20000,
        )
        page.wait_for_timeout(300)
        metrics = page.evaluate(
            """() => {
              const rect = selector => {
                const box = document.querySelector(selector).getBoundingClientRect();
                return {left:box.left,top:box.top,right:box.right,bottom:box.bottom,width:box.width,height:box.height};
              };
              const font = selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
              const canvas = document.querySelector('#hmi');
              const visualScale = canvas.getBoundingClientRect().width / parseFloat(canvas.style.width);
              return {
                canvas: rect('#hmi'),
                visualScale,
                conclusionFont: font('.auri-takeover-conclusion') * visualScale,
                actionFonts: Array.from(document.querySelectorAll('.auri-takeover-action b')).map(node => parseFloat(getComputedStyle(node).fontSize) * visualScale),
                actionRows: Array.from(document.querySelectorAll('.auri-takeover-action')).map(node => {
                  const copy=node.querySelector('.auri-takeover-action-copy');
                  const title=copy?.querySelector('b');
                  const copyBox=copy?.getBoundingClientRect();
                  return {
                    title:title?.textContent.trim()||'',
                    copyWidth:copyBox?.width||0,
                    copyClient:copy?.clientWidth||0,
                    copyScroll:copy?.scrollWidth||0,
                    copyDisplay:copy?getComputedStyle(copy).display:'',
                    copyPosition:copy?getComputedStyle(copy).position:''
                  };
                }),
                conclusionText: document.querySelector('.auri-takeover-conclusion').textContent.trim(),
                conclusionFits: document.querySelector('.auri-takeover-conclusion').scrollHeight <= document.querySelector('.auri-takeover-conclusion').clientHeight + 1,
                conclusionBox: {client:document.querySelector('.auri-takeover-conclusion').clientHeight,scroll:document.querySelector('.auri-takeover-conclusion').scrollHeight},
                conclusionStyle: (()=>{const s=getComputedStyle(document.querySelector('.auri-takeover-conclusion'));return {display:s.display,overflow:s.overflow,lineClamp:s.webkitLineClamp,minHeight:s.minHeight,height:s.height,lineHeight:s.lineHeight,flexShrink:s.flexShrink}})(),
                button: rect('#auri-takeover-confirm'),
                card: rect('#auri-takeover-card'),
                scene: rect('#scene3d'),
                carPlate: rect('.auri-car-mark--plate'),
                dock: rect('.bottom-bar'),
                dockEntries:Array.from(document.querySelectorAll('.bottom-bar [data-auri-section]')).map(node=>{
                  const box=node.getBoundingClientRect();
                  const style=getComputedStyle(node);
                  const image=node.querySelector('img');
                  const stack=document.elementsFromPoint(box.left+box.width/2,box.top+box.height/2);
                  return {
                    section:node.dataset.auriSection,
                    width:box.width,
                    height:box.height,
                    display:style.display,
                    visibility:style.visibility,
                    opacity:parseFloat(style.opacity),
                    imageLoaded:!image||image.complete&&image.naturalWidth>0,
                    hit:stack.some(item=>item===node||node.contains(item))
                  };
                }),
                clock: document.querySelector('#tb-clock-v2').textContent.trim(),
                overflow: getComputedStyle(document.body).overflow,
                ultrawide: document.querySelector('#hmi').classList.contains('is-ultrawide')
              };
            }"""
        )
        page.screenshot(path=OUTPUT / "waiting-confirmation-1920x720.png")
        browser.close()

    assert metrics["ultrawide"] is True, metrics
    assert metrics["canvas"]["left"] >= -1 and metrics["canvas"]["right"] >= 1919, metrics
    assert metrics["canvas"]["top"] >= -1 and metrics["canvas"]["bottom"] >= 719, metrics
    assert metrics["conclusionFont"] >= 32, metrics
    assert "预计晚到 18 分钟" in metrics["conclusionText"], metrics
    assert metrics["conclusionFits"] is True, metrics
    assert metrics["actionFonts"] and min(metrics["actionFonts"]) >= 18, metrics
    assert all(len(row["title"]) >= 2 and row["copyWidth"] >= 100 for row in metrics["actionRows"]), metrics
    assert metrics["button"]["height"] >= 55.5, metrics
    assert metrics["button"]["bottom"] <= metrics["card"]["bottom"] + 1, metrics
    assert metrics["carPlate"]["top"] >= metrics["scene"]["top"] and metrics["carPlate"]["bottom"] <= metrics["scene"]["bottom"], metrics
    assert metrics["card"]["bottom"] <= metrics["dock"]["top"] + 1, metrics
    assert len(metrics["dockEntries"]) == 5, metrics
    assert all(
        entry["width"] > 20
        and entry["height"] > 20
        and entry["display"] != "none"
        and entry["visibility"] == "visible"
        and entry["opacity"] >= 0.9
        and entry["imageLoaded"]
        and entry["hit"]
        for entry in metrics["dockEntries"]
    ), metrics
    assert metrics["overflow"] == "hidden", metrics
    assert metrics["clock"] != "06:40", metrics
    assert not errors, errors
    print(json.dumps({"status": "passed", "metrics": metrics, "javascript_errors": 0}, ensure_ascii=False))


if __name__ == "__main__":
    main()
