"""Verify shared Agent config and stable Console layout after steps 1 and 2.

Run against the dedicated token-protected local Agent on port 8795. The test
resets the session and refuses any public or non-isolated target.
"""

import json
import os
from pathlib import Path
from urllib import parse, request

from playwright.sync_api import Page, sync_playwright


AGENT = os.getenv("AURI_AGENT_URL", "http://127.0.0.1:8795").rstrip("/")
TOKEN = os.getenv("AURI_AGENT_TOKEN", "test-shared-token")
WEB_ROOT = os.getenv("AURI_WEB_ROOT", "http://127.0.0.1:5174").rstrip("/")
CHROME = os.getenv(
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE",
    str(Path.home() / ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
)
OUTPUT = Path(os.getenv("AURI_CONSOLE_LAYOUT_DIR", "/tmp/auri-console-layout"))
VIEWPORTS = [(1920, 1080), (1600, 900), (1366, 768), (1280, 720), (1024, 768)]


def api(path: str, method: str = "GET", payload: dict | None = None) -> dict:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
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
        return json.loads(response.read().decode("utf-8"))


def audit(page: Page) -> dict:
    result = page.evaluate(
        """() => {
          const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
          const area=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
          const list=document.querySelector('.script-list');
          const main=document.querySelector('.main-grid');
          const buttons=Array.from(document.querySelectorAll('.script-list button'));
          const overlaps=[];
          buttons.forEach((button,index)=>buttons.slice(index+1).forEach((other,offset)=>{
            const value=area(rect(button),rect(other));
            if(value>1) overlaps.push([index,index+offset+1,value]);
          }));
          return {
            viewport: innerWidth,
            bodyScrollWidth: document.body.scrollWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
            mainHeight: rect(main).height,
            scriptHeight: rect(list).height,
            buttonStructure: buttons.map(button=>({
              b:button.querySelectorAll(':scope > b').length,
              span:button.querySelectorAll(':scope > span').length,
              em:button.querySelectorAll(':scope > em').length,
              overflowX:button.scrollWidth>button.clientWidth+1,
              overflowY:button.scrollHeight>button.clientHeight+1,
              text:button.innerText.trim()
            })),
            overlaps
          };
        }"""
    )
    assert result["bodyScrollWidth"] <= result["viewport"] + 1, result
    assert result["documentScrollWidth"] <= result["viewport"] + 1, result
    assert not result["overlaps"], result
    assert all(
        row["b"] == 1 and row["span"] == 1 and row["em"] == 1
        and not row["overflowX"] and not row["overflowY"] and row["text"]
        for row in result["buttonStructure"]
    ), result
    return result


def main() -> None:
    parsed = parse.urlparse(AGENT)
    if parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.port != 8795:
        raise SystemExit("This destructive test only accepts the isolated local Agent on port 8795.")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    reports = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        for width, height in VIEWPORTS:
            api("/v1/session/reset", "POST", {"scenario_id": f"console-layout-{width}"})
            context = browser.new_context(viewport={"width": width, "height": height})
            page = context.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            app_config = json.dumps({"configVersion": 2, "apiBase": AGENT, "token": TOKEN})
            page.add_init_script(
                f"localStorage.clear();localStorage.setItem('auri-demo-console-config',{json.dumps(app_config)});"
            )
            page.goto(f"{WEB_ROOT}/apps/demo-console/", wait_until="domcontentloaded")
            page.wait_for_function("document.querySelector('#sessionId').textContent !== '未连接'", timeout=15000)

            if width == VIEWPORTS[0][0]:
                page.locator("#apiBase").fill("https://example.invalid")
                page.locator("#preflightBtn").click()
                page.wait_for_function(
                    "Array.from(document.querySelectorAll('#eventLog .log-row')).some(row => row.dataset.raw.includes('不是团队主地址、备用地址或本地开发地址'))",
                    timeout=5000,
                )
                page.locator("#apiBase").fill(AGENT)
                page.locator("#token").fill(TOKEN)

            page.locator("#preflightBtn").click()
            page.wait_for_function(
                "Array.from(document.querySelectorAll('#eventLog .log-row')).some(row => row.dataset.raw.includes('preflight ok'))",
                timeout=15000,
            )
            initial = audit(page)

            page.locator('button[data-action="presetTask"]').click()
            page.wait_for_function("document.querySelectorAll('#tasks li').length === 2", timeout=15000)
            page.wait_for_function("document.querySelector('#nextStepHint').textContent.includes('会议延迟')", timeout=15000)
            step1 = audit(page)
            page.locator('button[data-action="meeting"]').click()
            page.wait_for_function("document.querySelector('#stage').textContent === 'pre_departure_warning'", timeout=15000)
            step2 = audit(page)
            assert abs(initial["scriptHeight"] - step1["scriptHeight"]) <= 1, (initial, step1)
            assert abs(step1["scriptHeight"] - step2["scriptHeight"]) <= 1, (step1, step2)
            if width > 1180:
                assert abs(initial["mainHeight"] - step1["mainHeight"]) <= 1, (initial, step1)
                assert abs(step1["mainHeight"] - step2["mainHeight"]) <= 1, (step1, step2)
            page.screenshot(path=OUTPUT / f"console-step2-{width}x{height}.png", full_page=True)

            hmi = context.new_page()
            hmi_errors: list[str] = []
            hmi.on("pageerror", lambda error: hmi_errors.append(str(error)))
            hmi.goto(f"{WEB_ROOT}/apps/vehicle-hmi/", wait_until="load", timeout=30000)
            hmi.wait_for_function(
                "window.AURI_HMI_NEXT?.getState().syncMode === 'streaming'"
                " && window.AURI_HMI_NEXT?.getState().worldState?.revision === 2",
                timeout=20000,
            )
            hmi_state = hmi.evaluate("window.AURI_HMI_NEXT.getState()")
            assert hmi_state["config"]["apiBase"] == AGENT
            assert hmi_state["config"]["streamUrl"] == f"{AGENT}/v1/stream"
            assert hmi_state["config"]["token"] == "***"
            navigation = hmi_state["viewModel"]["navigation"]
            assert navigation and navigation["route"]["id"], navigation
            heartbeat_idle_seconds = 0
            if width == VIEWPORTS[0][0]:
                heartbeat_idle_seconds = 17
                page.wait_for_timeout(heartbeat_idle_seconds * 1000)
                assert hmi.evaluate("window.AURI_HMI_NEXT.getState().syncMode") == "streaming"
            assert not hmi_errors, hmi_errors
            assert not errors, errors
            reports.append({
                "viewport": f"{width}x{height}",
                "main_height": step2["mainHeight"],
                "script_height": step2["scriptHeight"],
                "session_id": hmi_state["worldState"]["session_id"],
                "revision": hmi_state["worldState"]["revision"],
                "route_id": navigation["route"]["id"],
                "page_errors": 0,
                "heartbeat_idle_seconds": heartbeat_idle_seconds,
            })
            context.close()
        browser.close()

    print(json.dumps({"status": "passed", "viewports": reports}, ensure_ascii=False))


if __name__ == "__main__":
    main()
