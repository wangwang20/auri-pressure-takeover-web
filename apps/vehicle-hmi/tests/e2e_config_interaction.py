"""Verify the real HMI connection form survives reloads and live updates.

The test uses the isolated token-protected Agent on port 8795. It exercises the
same UI path as a teammate: open settings, enter the Team Token, save, reload,
expand map settings, and keep editing while World State changes.
"""

import json
import os
from pathlib import Path
from urllib import parse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright


AGENT = os.getenv("AURI_AGENT_URL", "http://127.0.0.1:8795").rstrip("/")
TOKEN = os.getenv("AURI_AGENT_TOKEN", "test-shared-token")
HMI = os.getenv("AURI_HMI_URL", "http://127.0.0.1:5174/apps/vehicle-hmi/")
CHROME = os.getenv(
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE",
    str(Path.home() / ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
)
SCREENSHOT = Path(os.getenv("AURI_CONFIG_SCREENSHOT", "/tmp/auri-hmi-config-interaction.png"))


def main() -> None:
    parsed = parse.urlparse(AGENT)
    if parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.port != 8795:
        raise SystemExit("This test only accepts the isolated local Agent on port 8795.")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        context = browser.new_context(viewport={"width": 1920, "height": 1080})
        initial = json.dumps({
            "apiBase": AGENT,
            "token": "",
            "stream": True,
            "mapProvider": "offline",
        })
        context.add_init_script(
            "if(!sessionStorage.getItem('auri-config-test-seeded')){"
            "localStorage.clear();"
            f"localStorage.setItem('auri-hmi-next-config', JSON.stringify({initial}));"
            "sessionStorage.setItem('auri-config-test-seeded','1');}"
        )
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        # This is intentionally the normal teammate URL. The settings form
        # must be reachable from the connection status chip, without setup=1.
        page.goto(HMI, wait_until="load", timeout=30000)
        page.wait_for_function(
            "document.querySelector('#tb-offline')?.classList.contains('show')",
            timeout=15000,
        )
        page.locator("#tb-offline").click()
        page.locator("[data-connection-settings]").click()
        page.locator("#auri-config-form").wait_for(state="visible")
        page.locator("#auri-config-token").fill(TOKEN)
        page.locator(".auri-map-config summary").click()
        assert page.locator(".auri-map-config").evaluate("node => node.open") is True
        page.locator("#auri-config-form").evaluate("form => form.requestSubmit()")

        page.wait_for_function(
            "window.AURI_HMI_NEXT?.getState().syncMode === 'streaming'"
            " && window.AURI_HMI_NEXT?.getState().worldState?.session_id",
            timeout=30000,
        )
        page.locator("#tb-offline").click()
        page.locator("[data-connection-settings]").click()
        page.wait_for_function(
            "document.querySelector('[data-connection-metric=session]')?.textContent !== '--'"
            " && document.querySelector('[data-connection-metric=revision]')?.textContent !== '--'"
        )
        assert page.locator("[data-connection-metric=sync]").inner_text() == "实时流"

        details = page.locator(".auri-map-config")
        details.locator("summary").click()
        assert details.evaluate("node => node.open") is True
        key_input = page.locator("#auri-config-amap-key")
        key_input.fill("unsaved-user-input")

        # A World State update previously rebuilt the entire form, collapsed the
        # details element, and erased in-progress input. Exercise that exact path.
        page.evaluate(
            """() => {
              const current=AURI_HMI_NEXT.getState().worldState;
              AURI_HMI_NEXT.applyState({...current,revision:current.revision+1},'interaction-test');
            }"""
        )
        page.wait_for_timeout(500)
        assert details.evaluate("node => node.open") is True
        assert key_input.input_value() == "unsaved-user-input"
        assert page.locator("[data-connection-metric=revision]").inner_text() != "--"
        assert page.locator("#auri-config-token").input_value() == TOKEN
        assert not errors, errors
        SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=SCREENSHOT, full_page=True)
        successful_session = page.locator("[data-connection-metric=session]").inner_text()
        successful_revision = page.locator("[data-connection-metric=revision]").inner_text()

        wrong = json.dumps({
            "apiBase": AGENT,
            "token": "wrong-team-token",
            "stream": True,
            "mapProvider": "offline",
        })
        page.evaluate(
            "config => {"
            " localStorage.setItem('auri-hmi-next-config',JSON.stringify(config));"
            " localStorage.setItem('auri-shared-agent-config-v1',JSON.stringify({apiBase:config.apiBase,token:config.token}));"
            "}",
            json.loads(wrong),
        )
        page.reload(wait_until="load", timeout=30000)
        try:
            page.wait_for_function("window.AURI_HMI_NEXT?.getState().syncMode === 'auth_required'", timeout=20000)
        except PlaywrightTimeoutError as exc:
            diagnostics = page.evaluate(
                """() => ({
                  state: window.AURI_HMI_NEXT?.getState(),
                  chip: document.querySelector('#tb-offline')?.textContent,
                  stored: localStorage.getItem('auri-hmi-next-config'),
                  shared: localStorage.getItem('auri-shared-agent-config-v1')
                })"""
            )
            raise AssertionError(f"wrong-token state did not settle: {diagnostics}") from exc
        page.locator("#tb-offline").click()
        page.locator("[data-connection-settings]").click()
        page.wait_for_function("document.querySelector('.auri-shell-copy')?.textContent.includes('Team Token')")
        assert "Team Token" in page.locator(".auri-shell-copy").inner_text()
        assert page.locator("[data-connection-metric=health]").inner_text() == "正常"
        assert page.locator("[data-connection-metric=session]").inner_text() == "--"
        print(json.dumps({
            "status": "passed",
            "sync": "实时流",
            "session": successful_session,
            "revision": successful_revision,
            "map_details_open": True,
            "draft_preserved": True,
            "wrong_token_visible": True,
            "normal_url": True,
            "javascript_errors": len(errors),
            "screenshot": str(SCREENSHOT),
        }, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    main()
