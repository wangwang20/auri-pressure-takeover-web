"""Validate the permanent driver-side AURI panel across task counts and displays."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[3]
HMI = os.getenv("AURI_HMI_URL", "http://127.0.0.1:5174/apps/vehicle-hmi/")
CHROME = os.getenv(
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE",
    str(Path.home() / ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
)
FIXTURE = ROOT / "contracts/examples/world-state.json"
OUTPUT = Path(os.getenv("AURI_DRIVER_PANEL_DIR", "/tmp/auri-hmi-driver-panel"))
VIEWPORTS = [
    (1280, 720),
    (1600, 814),
    (1600, 900),
    (1920, 720),
    (1920, 1080),
    (2560, 1080),
]
BANNED = {"声", "腕", "表", "联", "刚", "弹", "信", "单", "路", "务", "返", "调", "距", "温"}


def state_with_tasks(base: dict, count: int, revision: int) -> dict:
    state = copy.deepcopy(base)
    seeds = base.get("tasks") or []
    if not seeds:
        raise AssertionError("world-state fixture must contain task seeds")
    tasks = []
    for index in range(count):
        task = copy.deepcopy(seeds[index % len(seeds)])
        task["task_id"] = f"driver_panel_task_{index + 1}"
        task["title"] = f"动态任务 {index + 1}"
        task["task_type"] = "rigid" if index % 2 == 0 else "flexible"
        task["adjustable"] = task["task_type"] == "flexible"
        tasks.append(task)
    state.update(
        revision=revision,
        stage="vehicle_observation",
        scene="driving",
        primary_surface="vehicle_hmi",
        tasks=tasks,
        actions=[],
        confirmation=None,
    )
    if count == 0:
        state["navigation"] = None
        state["eta"] = None
    return state


def metrics(page, task_count: int) -> dict:
    return page.evaluate(
        """expected => {
          const box=selector=>{
            const node=document.querySelector(selector); const rect=node.getBoundingClientRect();
            return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height,
              overflowX:node.scrollWidth>node.clientWidth+1,overflowY:node.scrollHeight>node.clientHeight+1};
          };
          const iconTexts=Array.from(document.querySelectorAll('.auri-driver-panel [aria-hidden=true],.auri-takeover-action>span'))
            .map(node=>node.textContent.trim()).filter(Boolean);
          const canvas=document.querySelector('#hmi');
          const visualScale=canvas.getBoundingClientRect().width/parseFloat(canvas.style.width);
          const scaledFont=selector=>parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)*visualScale;
          return {
            expected,
            driver:box('#auri-driver-panel'), vehicle:box('#vd-panel'), map:box('.right-panel'), dock:box('.bottom-bar'),
            taskSection:box('.auri-driver-tasks'), glance:box('.auri-driver-glance'), devices:box('.auri-driver-devices'),
            ultrawide:document.querySelector('#hmi').classList.contains('is-ultrawide'),
            visualScale,
            taskTitleFont:document.querySelector('.auri-driver-task:not(.is-empty) b')?scaledFont('.auri-driver-task:not(.is-empty) b'):null,
            taskMetaFont:document.querySelector('.auri-driver-task:not(.is-empty) small')?scaledFont('.auri-driver-task:not(.is-empty) small'):null,
            glanceTitleFont:scaledFont('.auri-driver-glance b'),
            deviceTitleFont:scaledFont('.auri-driver-devices b'),
            deviceMetaFont:scaledFont('.auri-driver-devices small'),
            countText:document.querySelector('#auri-driver-task-count').textContent.trim(),
            taskRows:document.querySelectorAll('.auri-driver-task:not(.is-empty)').length,
            emptyRows:document.querySelectorAll('.auri-driver-task.is-empty').length,
            moreText:document.querySelector('.auri-driver-task-more')?.textContent.trim()||'',
            sidebarDisplay:getComputedStyle(document.querySelector('.sidebar')).display,
            navVisible:getComputedStyle(document.querySelector('#vd-nav-card')).display!=='none',
            iconTexts
          };
        }""",
        task_count,
    )


def main() -> None:
    base = json.loads(FIXTURE.read_text(encoding="utf-8"))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            errors = []
            page.on("pageerror", lambda item: errors.append(str(item)))
            page.add_init_script(
                "try{localStorage.clear();sessionStorage.clear()}catch(_error){};"
                "try{window.speechSynthesis.speak=()=>{}}catch(_error){}"
            )
            page.goto(f"{HMI}{'&' if '?' in HMI else '?'}offline=1", wait_until="load", timeout=30000)
            page.wait_for_function("window.AURI_HMI_NEXT?.applyState")
            for offset, count in enumerate((0, 1, 2, 5), start=1):
                state = state_with_tasks(base, count, 1000 + offset)
                assert page.evaluate("state=>window.AURI_HMI_NEXT.applyState(state)", state) is not False
                page.wait_for_function(
                    "expected=>window.AURI_HMI_NEXT.getState().viewModel.tasks.total===expected",
                    arg=count,
                )
                measured = metrics(page, count)
                assert measured["driver"]["right"] <= measured["map"]["left"] + 1, measured
                assert measured["map"]["right"] <= measured["vehicle"]["left"] + 1, measured
                assert measured["driver"]["bottom"] <= measured["dock"]["top"] + 1, measured
                assert measured["vehicle"]["bottom"] <= measured["dock"]["top"] + 1, measured
                assert measured["map"]["bottom"] <= measured["dock"]["top"] + 1, measured
                assert not measured["driver"]["overflowX"] and not measured["driver"]["overflowY"], measured
                assert measured["taskSection"]["bottom"] <= measured["glance"]["top"] + 1, measured
                assert measured["glance"]["bottom"] <= measured["devices"]["top"] + 1, measured
                assert measured["countText"] == f"{count} 项", measured
                preview_limit = 2 if measured["ultrawide"] else 3
                assert measured["taskRows"] == min(count, preview_limit), measured
                assert measured["emptyRows"] == (1 if count == 0 else 0), measured
                assert (f"其余 {count - preview_limit} 项" in measured["moreText"]) if count > preview_limit else not measured["moreText"], measured
                assert measured["sidebarDisplay"] == "none", measured
                assert measured["navVisible"] is True, measured
                assert not BANNED.intersection(measured["iconTexts"]), measured
                if measured["ultrawide"] and count:
                    assert measured["taskTitleFont"] >= 18, measured
                    assert measured["taskMetaFont"] >= 13, measured
                    assert measured["glanceTitleFont"] >= 18, measured
                    assert measured["deviceTitleFont"] >= 18, measured
                    assert measured["deviceMetaFont"] >= 13, measured
                assert not errors, errors
                if count == 5:
                    page.screenshot(path=OUTPUT / f"tasks-5-{width}x{height}.png")
            results.append({"viewport": f"{width}x{height}", "status": "passed"})
            page.close()
        browser.close()
    print(json.dumps({"status": "passed", "viewports": results, "task_counts": [0, 1, 2, 5]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
