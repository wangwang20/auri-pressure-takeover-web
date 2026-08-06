"""Verify Console steps 7/8 use Bosch TTS and never browser speech synthesis.

The test runs the real Console -> Agent World State -> HMI path against the
dedicated local Agent. It intercepts the Bosch audio endpoint at the browser
boundary, so it verifies the request that production ``speakText`` creates,
without spending a TTS quota or requiring an audible headless browser.
"""

from __future__ import annotations

import json
import os
import time

from playwright.sync_api import Page, sync_playwright

import e2e_console_hmi_sync as sync_helpers


# Keep the standalone test aligned with e2e_config_interaction.py. The
# isolated 8795 Agent uses this token unless the caller supplies another one.
sync_helpers.TOKEN = os.getenv("AURI_AGENT_TOKEN", "test-shared-token")
AGENT = sync_helpers.AGENT
CHROME = sync_helpers.CHROME
CONSOLE = sync_helpers.CONSOLE
HMI = sync_helpers.HMI
TOKEN = sync_helpers.TOKEN
api = sync_helpers.api
click_director_step = sync_helpers.click_director_step
mobile_chat = sync_helpers.mobile_chat
wait_console_stage = sync_helpers.wait_console_stage


TTS_ENDPOINT = "https://aigc.bosch.com.cn/llmservice/api/v1/audio/speech"
REAL_TTS = os.getenv("AURI_REAL_TTS", "0") == "1"


def wait_tts_requests(page: Page, expected: int) -> list[dict]:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        requests = page.evaluate("window.__auriBoschTtsRequests || []")
        if len(requests) >= expected:
            return requests
        page.wait_for_timeout(100)
    raise AssertionError(
        f"Bosch TTS request count did not reach {expected}: "
        f"{page.evaluate('window.__auriBoschTtsRequests || []')}"
    )


def assert_tts_request(payload: dict, marker: str, expected_phrase: str) -> None:
    assert payload["model"] == "qwen3-tts-flash", payload
    assert payload["voice"] == "longxiaochun", payload
    assert expected_phrase in payload["input"], payload
    assert "Chinese letter" not in payload["input"], payload
    assert marker in payload["input"], payload


def main() -> None:
    if "onrender.com" in AGENT:
        raise SystemExit("Refusing to reset a shared public Agent; use a dedicated local Agent URL.")

    initial = api("/v1/session/reset", "POST", {"scenario_id": "bosch-tts-console-e2e"})

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=CHROME,
            headless=not REAL_TTS,
            args=["--autoplay-policy=no-user-gesture-required"] if REAL_TTS else [],
        )
        context = browser.new_context(viewport={"width": 1920, "height": 1080})
        console = context.new_page()
        hmi = context.new_page()
        errors: dict[str, list[str]] = {"console": [], "hmi": []}
        console.on("pageerror", lambda error: errors["console"].append(str(error)))
        hmi.on("pageerror", lambda error: errors["hmi"].append(str(error)))

        console_config = json.dumps({"apiBase": AGENT, "token": TOKEN, "stream": True})
        hmi_config = json.dumps({"apiBase": AGENT, "token": TOKEN, "stream": True})
        console.add_init_script(
            f"window.AURI_CONFIG={console_config};"
            "try{localStorage.removeItem('auri-demo-console-config')}catch(_error){}"
        )
        hmi.add_init_script(
            f"window.AURI_HMI_CONFIG={hmi_config};"
            "try{localStorage.removeItem('auri-hmi-next-config')}catch(_error){};"
            "window.__auriBoschTtsRequests=[];"
            "window.SAFEDRIVER_CONFIG={...(window.SAFEDRIVER_CONFIG||{}),"
            "ttsKey:'e2e-bosch-tts-key',systemSpeechFallback:false};"
        )

        def intercept_tts(route) -> None:
            request = route.request
            assert request.url.startswith(TTS_ENDPOINT), request.url
            payload = json.loads(request.post_data or "{}")
            hmi.evaluate("payload => window.__auriBoschTtsRequests.push(payload)", payload)
            if REAL_TTS:
                route.continue_()
                return
            # speakText only needs an audio Blob to enter the production Bosch
            # path. A tiny invalid body is sufficient; playback failure is
            # handled by the existing non-blocking TTS fallback.
            route.fulfill(status=200, content_type="audio/mpeg", body=b"e2e-audio")

        hmi.route("**/audio/speech", intercept_tts)
        console.goto(CONSOLE, wait_until="domcontentloaded", timeout=30000)
        hmi.goto(HMI, wait_until="domcontentloaded", timeout=30000)
        if REAL_TTS:
            hmi.locator("body").click(position={"x": 960, "y": 540})

        hmi.wait_for_function("window.AURI_HMI_NEXT?.getState().syncMode === 'streaming'", timeout=20000)
        console.wait_for_function("document.querySelector('#syncMode')?.textContent === 'SSE 实时'", timeout=20000)

        speech_guard = hmi.evaluate(
            """() => ({
              blocked: window.__AURI_SYSTEM_SPEECH_BLOCKED__ === true,
              source: String(window.speechSynthesis?.speak || ''),
              hasSpeech: Boolean(window.speechSynthesis),
              hasUtterance: Boolean(window.SpeechSynthesisUtterance)
            })"""
        )
        assert speech_guard["blocked"] is True, speech_guard
        assert "auriSystemSpeechBlocked" in speech_guard["source"], speech_guard
        assert speech_guard["hasSpeech"] is True, speech_guard
        assert speech_guard["hasUtterance"] is True, speech_guard

        # Step 1 is the real phone-created task, not a Console fixture.
        chat_events = mobile_chat("今天18:10接孩子，之后去超市", initial["session_id"])
        assert any(event.get("type") == "done" for event in chat_events)
        console.wait_for_function(
            "document.querySelector('#nextStepHint')?.textContent.includes('会议延迟')",
            timeout=15000,
        )

        click_director_step(console, "pre_departure_warning")
        click_director_step(console, "handover_to_vehicle")
        click_director_step(console, "vehicle_observation")
        click_director_step(console, "takeover_L2")
        click_director_step(console, "takeover_L2")

        current = api("/v1/state")
        help_events = mobile_chat("我还来得及吗？帮我处理", current["session_id"])
        assert any(event.get("type") == "done" for event in help_events)
        wait_console_stage(console, "waiting_confirmation")
        ready_requests = wait_tts_requests(hmi, 1)
        assert_tts_request(
            ready_requests[0],
            "AURI 已准备处理方案",
            "AURI 已准备处理方案",
        )

        # Step 8 is driven by the Console button, matching the operator path.
        completed = click_director_step(console, "action_completed")
        assert completed["stage"] == "action_completed", completed
        all_requests = wait_tts_requests(hmi, 2)
        assert_tts_request(
            all_requests[1],
            "AURI 已完成处理",
            "AURI 已完成处理",
        )
        if REAL_TTS:
            hmi.wait_for_timeout(6000)

        # The native browser path must remain unused for both announcements.
        native_probe = hmi.evaluate(
            """() => {
              let result = 'threw';
              try {
                result = window.speechSynthesis.speak(
                  new SpeechSynthesisUtterance('测试系统语音')
                );
              } catch (_error) {}
              return { result, source: String(window.speechSynthesis.speak || '') };
            }"""
        )
        assert native_probe["result"] is None, native_probe
        assert "auriSystemSpeechBlocked" in native_probe["source"], native_probe
        assert not errors["console"], errors["console"]
        assert not errors["hmi"], errors["hmi"]
        print(
            json.dumps(
                {
                    "status": "passed",
                    "session_id": completed["session_id"],
                    "stage": completed["stage"],
                    "bosch_tts_requests": len(all_requests),
                    "tts_model": all_requests[0]["model"],
                    "tts_voice": all_requests[0]["voice"],
                    "speech_synthesis_blocked": speech_guard["blocked"],
                    "system_speech_calls": 0,
                    "real_tts": REAL_TTS,
                    "tts_inputs": [request["input"] for request in all_requests],
                    "javascript_errors": errors,
                },
                ensure_ascii=False,
            )
        )
        browser.close()


if __name__ == "__main__":
    main()
