"""Verify the optional preset can connect and create tasks in one click."""

import json
import os
from pathlib import Path
from urllib import parse, request

from playwright.sync_api import sync_playwright


AGENT = os.getenv("AURI_AGENT_URL", "http://127.0.0.1:8795").rstrip("/")
TOKEN = os.getenv("AURI_AGENT_TOKEN", "test-shared-token")
CONSOLE = os.getenv(
    "AURI_CONSOLE_URL", "http://127.0.0.1:5174/apps/demo-console/"
)
CHROME = os.getenv(
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE",
    str(Path.home() / ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
)


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


def main() -> None:
    parsed = parse.urlparse(AGENT)
    if parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.port != 8795:
        raise SystemExit("This destructive test only accepts the isolated local Agent on port 8795.")

    api("/v1/session/reset", "POST", {"scenario_id": "console-preset-e2e"})
    config = json.dumps({"configVersion": 2, "apiBase": AGENT, "token": TOKEN})

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        page_errors: list[str] = []
        event_payloads: list[dict] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "request",
            lambda req: event_payloads.append(json.loads(req.post_data))
            if req.url == f"{AGENT}/v1/event" and req.post_data
            else None,
        )
        page.route(f"{AGENT}/health", lambda route: route.abort())
        page.add_init_script(
            f"localStorage.setItem('auri-demo-console-config', {json.dumps(config)});"
        )
        page.goto(CONSOLE, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_function(
            "document.querySelector('#sessionId')?.textContent !== '未连接'"
        )

        preset = page.locator('button[data-action="presetTask"]')
        assert preset.is_visible()
        assert preset.is_enabled()
        assert api("/v1/state")["tasks"] == []

        preset.click()
        page.wait_for_function(
            "document.querySelector('button[data-action=\"presetTask\"]')?.textContent.includes('连接并载入中')"
        )
        page.wait_for_function(
            "document.querySelectorAll('#tasks li').length === 2"
            " && document.querySelector('#tasks')?.textContent.includes('接孩子')"
            " && document.querySelector('#tasks')?.textContent.includes('超市采购')"
        )
        state = api("/v1/state")
        assert [task["title"] for task in state["tasks"]] == ["接孩子", "超市采购"]
        assert state["revision"] == 1
        assert len(event_payloads) == 1
        assert len(event_payloads[0]["payload"]["tasks"]) == 2
        assert event_payloads[0]["payload"]["tasks"][0]["task_type"] == "rigid"
        assert event_payloads[0]["payload"]["tasks"][1]["capability_tags"] == ["grocery_delivery"]
        assert preset.is_disabled()
        assert preset.inner_text() == "已载入"
        assert "已载入 2 项任务" in page.locator("#presetStatus").inner_text()
        assert "下一步：会议延迟" in page.locator("#nextStepHint").inner_text()
        assert "task.created" in page.locator("#eventLog").inner_text()
        assert not page_errors, page_errors

        page.screenshot(path="/tmp/auri-console-preset-task.png")

        unavailable = "http://127.0.0.1:8796"
        failed_page = browser.new_page(viewport={"width": 1280, "height": 720})
        failed_config = json.dumps({"configVersion": 2, "apiBase": unavailable, "token": ""})
        failed_page.add_init_script(
            f"localStorage.clear();localStorage.setItem('auri-demo-console-config', {json.dumps(failed_config)});"
        )
        failed_page.goto(CONSOLE, wait_until="domcontentloaded", timeout=30000)
        failed_preset = failed_page.locator('button[data-action="presetTask"]')
        failed_preset.click()
        failed_page.wait_for_function(
            "document.querySelector('#presetStatus')?.dataset.tone === 'error'",
            timeout=15000,
        )
        assert "载入失败" in failed_page.locator("#presetStatus").inner_text()
        assert failed_preset.inner_text() == "重新载入"
        assert failed_preset.is_enabled()
        failed_page.close()

        print(
            json.dumps(
                {
                    "status": "passed",
                    "session_id": state["session_id"],
                    "revision": state["revision"],
                    "tasks": [task["title"] for task in state["tasks"]],
                    "structured_task_count": len(event_payloads[0]["payload"]["tasks"]),
                    "button_locked_after_create": preset.is_disabled(),
                    "failure_feedback_visible": True,
                    "javascript_errors": len(page_errors),
                },
                ensure_ascii=False,
            )
        )
        browser.close()


if __name__ == "__main__":
    main()
