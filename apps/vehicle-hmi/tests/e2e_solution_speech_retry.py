"""Verify a blocked step-7 plan briefing is retried after HMI audio activation."""

from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[3]
HMI = (ROOT / "apps/vehicle-hmi/index.html").as_uri() + "?offline=1"
FIXTURE = ROOT / "contracts/examples/world-state.json"
CHROME = Path.home() / ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"


def main() -> None:
    state = json.loads(FIXTURE.read_text(encoding="utf-8"))
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=str(CHROME), headless=True)
        page = browser.new_page(viewport={"width": 1600, "height": 900})
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script(
            """
            window.__auriSpeechAttempts = [];
            window.__auriSpeechAllowed = false;
            window.AURI_HMI_SPEECH_ADAPTER = {
              cancel() {},
              speak(text) {
                window.__auriSpeechAttempts.push({ text, allowed: window.__auriSpeechAllowed });
                return window.__auriSpeechAllowed;
              }
            };
            """
        )
        page.goto(HMI, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_function("window.AURI_HMI_NEXT?.applyState")
        page.evaluate(
            """() => {
              window.unlockAudio = () => window.dispatchEvent(new CustomEvent('auri:audio-ready'));
            }"""
        )
        page.evaluate("state => window.AURI_HMI_NEXT.applyState(state)", state)
        page.wait_for_function("window.__auriSpeechAttempts.length === 1")
        first = page.evaluate("window.__auriSpeechAttempts[0]")
        assert first["allowed"] is False, first
        assert "AURI 已准备处理方案" in first["text"], first

        page.evaluate("window.__auriSpeechAllowed = true")
        page.locator("#auri-driver-panel").click(position={"x": 40, "y": 40})
        page.wait_for_function("window.__auriSpeechAttempts.length === 2")
        second = page.evaluate("window.__auriSpeechAttempts[1]")
        assert second["allowed"] is True, second
        assert second["text"] == first["text"], (first, second)

        page.locator("#auri-driver-panel").click(position={"x": 40, "y": 40})
        page.wait_for_timeout(250)
        assert page.evaluate("window.__auriSpeechAttempts.length") == 2
        assert not errors, errors
        print(json.dumps({"status": "passed", "attempts": 2, "briefing": second["text"]}, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    main()
