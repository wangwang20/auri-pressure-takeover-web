"""Verify that a hung AMap route falls back to the Bosch map within two seconds."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


REPO_ROOT = Path(__file__).resolve().parents[3]
HMI = os.getenv(
    "AURI_HMI_URL", "http://127.0.0.1:5174/apps/vehicle-hmi/"
)
CHROME = os.getenv(
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE",
    str(Path.home() / ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
)
FIXTURE = REPO_ROOT / "contracts/examples/world-state.json"
SCREENSHOT = Path(os.getenv("AURI_AMAP_FALLBACK_SCREENSHOT", "/tmp/auri-hmi-amap-fallback.png"))


FAKE_AMAP = r"""
(() => {
  class FakeMap {
    constructor() { this.items = []; }
    add(item) { this.items.push(item); }
    remove() {}
    setFitView() {}
    setZoomAndCenter() {}
    setPitch() {}
    setRotation() {}
    zoomIn() {}
    zoomOut() {}
  }
  class Traffic {
    setOpacity() {}
  }
  class Driving {
    search() { /* Deliberately never calls back. */ }
  }
  window.AMap = {
    Map: FakeMap,
    TileLayer: { Traffic },
    Driving,
    DrivingPolicy: { LEAST_TIME: 0 }
  };
})();
"""


def main() -> None:
    if not Path(CHROME).is_file():
        raise AssertionError(f"Chromium executable does not exist: {CHROME}")
    state = json.loads(FIXTURE.read_text(encoding="utf-8"))
    config = {
        "apiBase": "http://127.0.0.1:8798",
        "token": "",
        "stream": False,
        "mapProvider": "amap",
        "amapKey": "browser-fallback-test-key",
        "amapRouteTimeoutMs": 1800,
        "amapMonthlyMapLimit": 20,
        "amapMonthlyRouteLimit": 20,
    }

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        context = browser.new_context(viewport={"width": 1920, "height": 1080})
        page = context.new_page()
        page_errors: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.add_init_script(
            f"window.AURI_HMI_CONFIG={json.dumps(config)};"
            "try{localStorage.removeItem('auri-hmi-next-config')}catch(_error){};"
            "try{localStorage.removeItem('auri-hmi-next-amap-usage')}catch(_error){};"
            "try{window.speechSynthesis.speak=()=>{}}catch(_error){};"
        )
        page.add_init_script(FAKE_AMAP)
        page.goto(HMI, wait_until="load", timeout=30000)
        page.wait_for_function("window.AURI_HMI_NEXT?.applyState")

        started = time.monotonic()
        applied = page.evaluate("state => window.AURI_HMI_NEXT.applyState(state)", state)
        assert applied is not False
        page.wait_for_function(
            "window.AURI_HMI_NEXT.getState().map.status === 'offline'"
            " && document.querySelector('#auri-map-source')?.textContent === '已切换离线导航'",
            timeout=2500,
        )
        elapsed = time.monotonic() - started

        canvas_hidden = page.locator("#auri-amap-canvas").evaluate("node => node.hidden")
        online_class = page.locator(".right-panel").evaluate(
            "node => node.classList.contains('is-amap-online')"
        )
        offline_map_visible = page.locator(".map-design").evaluate(
            "node => { const style=getComputedStyle(node); return style.display !== 'none' && style.visibility !== 'hidden'; }"
        )
        status_text = page.locator("#auri-map-source").inner_text()
        usage = page.evaluate("window.AURI_HMI_NEXT.getState().map.usage")
        SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=SCREENSHOT)

        assert elapsed < 2.0, f"offline fallback took {elapsed:.3f}s"
        assert canvas_hidden is True
        assert online_class is False
        assert offline_map_visible is True
        assert usage["routePlans"] == 1
        assert not page_errors, page_errors
        context.close()
        browser.close()

    print(json.dumps({
        "status": "passed",
        "fallback_seconds": round(elapsed, 3),
        "status_text": status_text,
        "route_plans": usage["routePlans"],
        "offline_map_visible": offline_map_visible,
        "screenshot": str(SCREENSHOT),
        "javascript_errors": len(page_errors),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
