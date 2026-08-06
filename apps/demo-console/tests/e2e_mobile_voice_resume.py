"""Verify a phone-created task unlocks Console even when Console opens later.

Run only against the dedicated local Agent. This reproduces the field sequence:
mobile voice -> World State -> open Console -> complete the director flow.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


TESTS = Path(__file__).resolve().parents[2] / "vehicle-hmi" / "tests"
sys.path.insert(0, str(TESTS))

from e2e_console_hmi_sync import (  # noqa: E402
    AGENT,
    CHROME,
    CONSOLE,
    TOKEN,
    api,
    click_director_step,
    mobile_chat,
    wait_console_stage,
)


def main() -> None:
    if "onrender.com" in AGENT:
        raise SystemExit("Refusing to reset a shared public Agent; use the isolated local Agent.")

    initial = api("/v1/session/reset", "POST", {"scenario_id": "mobile-voice-console-resume"})
    events = mobile_chat("今天18:10接孩子，之后去超市", initial["session_id"])
    assert any(event.get("type") == "done" for event in events)
    task_state = api("/v1/state")
    assert task_state["stage"] == "off_vehicle_idle", task_state
    assert len(task_state["tasks"]) == 2, task_state

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        config = json.dumps({"apiBase": AGENT, "token": TOKEN, "stream": True})
        page.add_init_script(
            f"window.AURI_CONFIG={config};"
            "try{localStorage.removeItem('auri-demo-console-config')}catch(_e){}"
        )
        page.goto(CONSOLE, wait_until="domcontentloaded", timeout=30000)
        sse_parser = page.evaluate("""() => {
          const api=window.AURI_DEMO_CONSOLE_TEST;
          const split=api.splitSseFrames('event: state\\r\\ndata:{"revision":1}\\r\\n\\r\\ndata: {"revision":');
          return {
            frames: split.frames,
            rest: split.rest,
            compact: api.parseSseData('data:{"revision":1}'),
            multiline: api.parseSseData('event: state\\r\\ndata: {"revision":\\r\\ndata: 1}\\r\\n')
          };
        }""")
        assert sse_parser["frames"] == ['event: state\r\ndata:{"revision":1}'], sse_parser
        assert sse_parser["rest"] == 'data: {"revision":', sse_parser
        assert json.loads(sse_parser["compact"])["revision"] == 1, sse_parser
        assert json.loads(sse_parser["multiline"])["revision"] == 1, sse_parser
        page.wait_for_function("document.querySelector('#syncMode')?.textContent === 'SSE 实时'", timeout=20000)
        page.wait_for_function(
            "document.querySelector('#nextStepHint')?.textContent.includes('会议延迟')"
            " && !document.querySelector('#runCurrentStep')?.disabled",
            timeout=15000,
        )
        assert "接孩子" in page.locator("#tasks").inner_text()

        click_director_step(page, "pre_departure_warning")
        click_director_step(page, "handover_to_vehicle")
        click_director_step(page, "vehicle_observation")
        click_director_step(page, "takeover_L2")
        click_director_step(page, "takeover_L2")

        current = api("/v1/state")
        help_events = mobile_chat("我还来得及吗？帮我处理", current["session_id"])
        assert any(event.get("type") == "done" for event in help_events)
        wait_console_stage(page, "waiting_confirmation")
        click_director_step(page, "action_completed")
        click_director_step(page, "cooldown")
        final = click_director_step(page, "parked_review")

        assert final["stage"] == "parked_review"
        assert len(final["tasks"]) == 2
        assert final["actions"], final
        assert all(action.get("target") not in {"王老师", "孩子妈妈"} for action in final["actions"]), final
        assert all(action["status"] == "completed" for action in final["actions"])
        assert not errors, errors
        print(json.dumps({
            "session_id": final["session_id"],
            "task_revision_before_console": task_state["revision"],
            "final_revision": final["revision"],
            "final_stage": final["stage"],
            "tasks": len(final["tasks"]),
            "actions": len(final["actions"]),
            "console_sync": page.locator("#syncMode").inner_text(),
            "javascript_errors": errors,
        }, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    main()
