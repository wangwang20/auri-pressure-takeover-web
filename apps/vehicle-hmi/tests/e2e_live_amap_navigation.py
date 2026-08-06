"""Validate live AMap follow/overview cameras without committing credentials."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib import request
from uuid import uuid4

from playwright.sync_api import sync_playwright


AGENT = os.getenv("AURI_AGENT_URL", "http://127.0.0.1:8795").rstrip("/")
TOKEN = os.getenv("AURI_AGENT_TOKEN", "")
HMI = os.getenv("AURI_HMI_URL", "http://127.0.0.1:5174/apps/vehicle-hmi/")
AMAP_KEY = os.environ["AURI_AMAP_KEY"]
AMAP_SECURITY = os.environ["AURI_AMAP_SECURITY"]
CHROME = os.getenv(
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE",
    str(Path.home() / ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
)
HEADLESS = os.getenv("PLAYWRIGHT_HEADLESS", "1").strip().lower() not in {"0", "false", "no"}
OUTPUT = Path(os.getenv("AURI_AMAP_VISUAL_DIR", "/tmp/auri-live-amap-navigation"))
TZ = timezone(timedelta(hours=8))


def api(path: str, method: str = "GET", payload: dict | None = None) -> dict:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if TOKEN:
        headers["X-Agent-Token"] = TOKEN
    req = request.Request(f"{AGENT}{path}", method=method, data=body, headers=headers)
    with request.urlopen(req, timeout=20) as response:
        return json.loads(response.read().decode())


def submit(event_type: str, payload: dict, source: str = "demo_console") -> dict:
    state = api("/v1/state")
    return api("/v1/event", "POST", {
        "schema_version": "0.2.0",
        "event_id": f"live_amap_{event_type.replace('.', '_')}_{uuid4().hex[:8]}",
        "session_id": state["session_id"],
        "type": event_type,
        "source": source,
        "timestamp": datetime.now(TZ).isoformat(),
        "payload": payload,
    })["state"]


def follow_metrics(page) -> dict:
    return page.evaluate("""() => {
      const canvasNode=document.querySelector('#auri-amap-canvas');
      const mapsNode=canvasNode?.querySelector('.amap-maps');
      const fixedNode=document.querySelector('.auri-amap-fixed-vehicle');
      const fixedRing=fixedNode?.querySelector('span');
      const actualVehicle=document.querySelector('.auri-amap-vehicle');
      const originNode=document.querySelector('.auri-amap-origin');
      const destinationNode=document.querySelector('.auri-amap-destination');
      const canvas=canvasNode?.getBoundingClientRect();
      const maps=mapsNode?.getBoundingClientRect();
      const fixed=fixedNode?.getBoundingClientRect();
      const actual=actualVehicle?.getBoundingClientRect();
      const origin=originNode?.getBoundingClientRect();
      const destination=destinationNode?.getBoundingClientRect();
      const mapDesign=document.querySelector('.map-design');
      const offlineCar=document.querySelector('.map-car-dot');
      const offlineRoute=document.querySelector('.map-route-core');
      const mapDesignStyle=mapDesign ? getComputedStyle(mapDesign) : null;
      const canvasStyle=canvasNode ? getComputedStyle(canvasNode) : null;
      const offlineCarRect=offlineCar?.getBoundingClientRect();
      const routeSamples=[];
      if (offlineRoute && offlineCarRect && typeof offlineRoute.getTotalLength === 'function') {
        const total=offlineRoute.getTotalLength();
        const matrix=offlineRoute.getScreenCTM();
        for (let index=0; index<=100; index+=1) {
          const point=offlineRoute.getPointAtLength(total * index / 100);
          const screen=new DOMPoint(point.x, point.y).matrixTransform(matrix);
          routeSamples.push({x:screen.x,y:screen.y});
        }
      }
      const offlineCarCenter=offlineCarRect ? {x:offlineCarRect.x+offlineCarRect.width/2,y:offlineCarRect.y+offlineCarRect.height/2} : null;
      const nearestRouteDistance=offlineCarCenter && routeSamples.length
        ? Math.min(...routeSamples.map(point => Math.hypot(point.x-offlineCarCenter.x, point.y-offlineCarCenter.y)))
        : null;
      const traffic=[...document.querySelectorAll('.map-route-traffic')].map(node => {
        const style=getComputedStyle(node);
        return {display:style.display,stroke:style.stroke,opacity:Number(style.opacity)};
      });
      const zoomButtons=[...document.querySelectorAll('[data-map-control="zoom-in"], [data-map-control="zoom-out"]')];
      const chevrons=[...document.querySelectorAll('.auri-amap-chevron')]
        .map(node => {
          const rect=node.getBoundingClientRect();
          const style=getComputedStyle(node);
          return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,display:style.display,opacity:Number(style.opacity)};
        })
        .filter(item => item.display !== 'none' && item.width > 0 && item.height > 0 && item.opacity > 0);
      const visibleRouteLabels=[...document.querySelectorAll('.auri-amap-route-label')]
        .filter(node => {
          const rect=node.getBoundingClientRect();
          const style=getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
            && rect.width > 0 && rect.height > 0 && canvas
            && rect.right > canvas.left && rect.left < canvas.right && rect.bottom > canvas.top && rect.top < canvas.bottom;
        })
        .map(node => node.textContent.trim())
        .filter(Boolean);
      const visiblePoiLabels=[...document.querySelectorAll('.auri-amap-poi-label')]
        .filter(node => {
          const rect=node.getBoundingClientRect();
          const style=getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
            && rect.width > 0 && rect.height > 0 && canvas
            && rect.right > canvas.left && rect.left < canvas.right && rect.bottom > canvas.top && rect.top < canvas.bottom;
        })
        .map(node => node.textContent.trim())
        .filter(Boolean);
      const fixedStyle=fixedNode ? getComputedStyle(fixedNode) : null;
      const ringStyle=fixedRing ? getComputedStyle(fixedRing) : null;
      const tile=canvasNode?.querySelector('.amap-layer-tile');
      const tileStyle=tile ? getComputedStyle(tile) : null;
      return {
        canvas:{x:canvas?.x,y:canvas?.y,width:canvas?.width,height:canvas?.height},
        maps:{x:maps?.x,y:maps?.y,width:maps?.width,height:maps?.height},
        transform:mapsNode ? getComputedStyle(mapsNode).transform : 'none',
        fixed:{x:fixed?.x,y:fixed?.y,width:fixed?.width,height:fixed?.height},
        fixedDisplay:fixedStyle?.display || 'none',
        fixedCenterRatio:{
          x:canvas && fixed ? (fixed.x + fixed.width / 2 - canvas.x) / canvas.width : null,
          y:canvas && fixed ? (fixed.y + fixed.height / 2 - canvas.y) / canvas.height : null
        },
        fixedRingAnimation:ringStyle?.animationName || 'none',
        tileOpacity:tileStyle ? Number(tileStyle.opacity) : null,
        tileFilter:tileStyle?.filter || 'none',
        amapCanvasOpacity:canvasStyle ? Number(canvasStyle.opacity) : null,
        localRenderer:{
          opacity:mapDesignStyle ? Number(mapDesignStyle.opacity) : null,
          visibility:mapDesignStyle?.visibility || 'hidden',
          car:offlineCarRect ? {x:offlineCarRect.x,y:offlineCarRect.y,width:offlineCarRect.width,height:offlineCarRect.height} : null,
          carCenterRatio:{
            x:canvas && offlineCarCenter ? (offlineCarCenter.x-canvas.x)/canvas.width : null,
            y:canvas && offlineCarCenter ? (offlineCarCenter.y-canvas.y)/canvas.height : null
          },
          nearestRouteDistance,
          pointsAhead:offlineCarCenter ? routeSamples.filter(point => point.y < offlineCarCenter.y - 24).length : 0,
          traffic
        },
        actualVehicle:{
          x:actual?.x || 0,
          y:actual?.y || 0,
          width:actual?.width || 0,
          height:actual?.height || 0,
          display:actualVehicle ? getComputedStyle(actualVehicle).display : 'none',
          opacity:actualVehicle ? Number(getComputedStyle(actualVehicle).opacity) : 0,
          centerRatio:{
            x:canvas && actual ? (actual.x + actual.width / 2 - canvas.x) / canvas.width : null,
            y:canvas && actual ? (actual.y + actual.height / 2 - canvas.y) / canvas.height : null
          }
        },
        overviewMarkers:{
          origin:origin ? {x:origin.x,y:origin.y,width:origin.width,height:origin.height} : null,
          destination:destination ? {x:destination.x,y:destination.y,width:destination.width,height:destination.height} : null
        },
        vehicleMotion:document.querySelector('.right-panel')?.dataset.vehicleMotion || '',
        controls:{
          zoomDisabled:zoomButtons.map(button => button.disabled),
          trafficPressed:document.querySelector('[data-map-control="traffic"]')?.getAttribute('aria-pressed')
        },
        chevrons,
        visibleRouteLabels,
        visiblePoiLabels
      };
    }""")


def main() -> None:
    if AGENT not in {"http://127.0.0.1:8795", "http://localhost:8795"}:
        raise SystemExit("Live AMap test only resets the isolated local Agent on port 8795.")
    api("/v1/session/reset", "POST", {"scenario_id": "live-amap-navigation"})
    submit("task.created", {"text": "今天18:10接孩子，之后去超市"}, "mobile")
    submit("meeting.overrun", {"delay_minutes": 20})
    submit("scene.vehicle_entered", {})
    OUTPUT.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=CHROME,
            headless=HEADLESS,
            args=["--enable-webgl", "--ignore-gpu-blocklist"],
        )
        page = browser.new_page(viewport={"width": 1366, "height": 768})
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        config = json.dumps({
            "apiBase": AGENT,
            "token": TOKEN,
            "stream": True,
            "mapProvider": "amap",
            "amapKey": AMAP_KEY,
            "amapSecurityJsCode": AMAP_SECURITY,
        })
        page.add_init_script(
            f"window.AURI_HMI_CONFIG={config};"
            "try{localStorage.removeItem('auri-hmi-next-config')}catch(_e){};"
            "window.__auriSpoken=[];"
            "window.AURI_HMI_SPEECH_ADAPTER={speak:(text)=>{window.__auriSpoken.push(text);return true}};"
        )
        page.goto(HMI, wait_until="domcontentloaded", timeout=30000)
        try:
            page.wait_for_function("window.AURI_HMI_NEXT?.getState().map.status === 'online'", timeout=30000)
        except Exception:
            diagnostic = page.evaluate("window.AURI_HMI_NEXT?.getState() || null")
            page.screenshot(path=str(OUTPUT / "connection-failure.png"))
            raise AssertionError(f"AMap did not become online: {json.dumps(diagnostic, ensure_ascii=False)}")
        page.wait_for_function("window.AURI_HMI_NEXT?.getState().viewModel.lifecycle.stage === 'vehicle_observation'", timeout=30000)
        page.wait_for_timeout(2400)

        page.locator('[data-map-control="follow"]').click()
        page.wait_for_function("window.AURI_HMI_NEXT.getState().map.labels.labelsReadyModes.includes('follow')", timeout=8000)
        page.wait_for_function("['ready','empty','failed','usage_guard'].includes(window.AURI_HMI_NEXT.getState().map.labels.poiSearchStatus)", timeout=5000)
        page.wait_for_timeout(600)
        follow = page.evaluate("window.AURI_HMI_NEXT.getState().map")
        assert follow["labels"]["showLabel"] is True, follow
        assert follow["labels"]["labelRejectMask"] is True, follow
        assert follow["labels"]["features"] == ["bg", "road", "building", "point"], follow
        assert follow["labels"]["routeLabelCount"] >= 2, follow
        assert follow["labels"]["labelsReady"] is True, follow
        assert follow["labels"]["renderCompleteCount"] >= 1, follow
        assert "follow" in follow["labels"]["labelsReadyModes"], follow
        assert follow["labels"]["poiSearchStatus"] in {"ready", "empty", "failed", "usage_guard"}, follow
        if follow["labels"]["poiSearchStatus"] == "ready":
            assert follow["labels"]["poiLabelCount"] >= 3, follow
        if follow["labels"]["poiSearchStatus"] == "ready":
            assert follow["labels"]["poiVisibleCount"] >= 3, follow
        assert follow["usage"]["poiSearches"] == 1, follow
        follow_label = page.locator('[data-map-control="follow"] span').inner_text().strip()
        page.wait_for_function("document.querySelector('.right-panel')?.dataset.vehicleMotion === 'moving'", timeout=5000)
        moving_before = page.evaluate("window.AURI_HMI_NEXT.getState().drivePlayback.progress")
        moving_metrics = follow_metrics(page)
        assert moving_metrics["visibleRouteLabels"], moving_metrics
        if follow["labels"]["poiSearchStatus"] == "ready":
            assert moving_metrics["visiblePoiLabels"], moving_metrics
        page.screenshot(path=str(OUTPUT / "moving-follow.png"))
        page.wait_for_timeout(900)
        moving_after = page.evaluate("window.AURI_HMI_NEXT.getState().drivePlayback.progress")
        timing = page.evaluate("window.AURI_HMI_NEXT.getState().drivePlayback")

        state = api("/v1/state")
        rigid = next(task for task in state["tasks"] if task.get("task_type") == "rigid")
        scheduled = datetime.fromisoformat(rigid["scheduled_at"])
        submit("traffic.updated", {
            "eta": (scheduled + timedelta(minutes=18)).isoformat(),
            "late_minutes": 18,
        })
        page.wait_for_function("window.AURI_HMI_NEXT.getState().viewModel.lifecycle.stage === 'takeover_L2'", timeout=15000)
        page.wait_for_timeout(900)
        stopped_before = page.evaluate("window.AURI_HMI_NEXT.getState().drivePlayback.progress")
        page.wait_for_timeout(1300)
        stopped_after = page.evaluate("window.AURI_HMI_NEXT.getState().drivePlayback.progress")
        stopped_metrics = follow_metrics(page)
        stopped_map = page.evaluate("window.AURI_HMI_NEXT.getState().map")
        page.screenshot(path=str(OUTPUT / "stopped-follow.png"))
        page.locator('[data-map-control="traffic"]').click()
        page.wait_for_timeout(120)
        traffic_hidden_metrics = follow_metrics(page)
        traffic_hidden_map = page.evaluate("window.AURI_HMI_NEXT.getState().map")
        page.locator('[data-map-control="traffic"]').click()
        page.wait_for_timeout(120)

        submit("user.utterance", {"text": "我还来得及吗？帮我处理", "input_mode": "voice"}, "mobile")
        page.wait_for_function("window.AURI_HMI_NEXT.getState().viewModel.lifecycle.stage === 'waiting_confirmation'", timeout=15000)
        page.wait_for_function(
            "document.querySelector('.auri-takeover-section-head')?.textContent.includes('Agent 处理方案')"
            " && document.querySelectorAll('.auri-takeover-action').length >= 3"
            " && !document.querySelector('#auri-takeover-confirm')?.hidden",
            timeout=5000,
        )
        waiting_plan = page.evaluate("""() => ({
          section:document.querySelector('.auri-takeover-section-head')?.textContent.replace(/\\s+/g,' ').trim()||'',
          actionTitles:[...document.querySelectorAll('.auri-takeover-action b')].map(node=>({
            text:node.textContent.trim(),
            fontPx:Number.parseFloat(getComputedStyle(node).fontSize)||0
          })),
          confirmHeight:document.querySelector('#auri-takeover-confirm')?.getBoundingClientRect().height||0,
          noticeVisible:document.querySelector('#auri-stage-notice')?.classList.contains('is-visible')||false,
          noticeReady:document.querySelector('#auri-stage-notice')?.classList.contains('is-plan-ready')||false,
          noticeText:document.querySelector('#auri-stage-notice')?.textContent.replace(/\\s+/g,' ').trim()||'',
          deviceNoticeVisible:document.querySelector('#auri-device-notice')?.classList.contains('is-visible')||false
        })""")
        assert "Agent 处理方案" in waiting_plan["section"], waiting_plan
        assert len(waiting_plan["actionTitles"]) >= 3, waiting_plan
        assert min(item["fontPx"] for item in waiting_plan["actionTitles"]) >= 18, waiting_plan
        assert waiting_plan["confirmHeight"] >= 55, waiting_plan
        assert waiting_plan["noticeVisible"] is True, waiting_plan
        assert waiting_plan["noticeReady"] is True, waiting_plan
        assert "AURI 处理方案已准备" in waiting_plan["noticeText"], waiting_plan
        assert waiting_plan["deviceNoticeVisible"] is False, waiting_plan
        ready_speech = page.evaluate("window.__auriSpoken")
        assert len(ready_speech) == 1, ready_speech
        assert "AURI 已准备处理方案" in ready_speech[0], ready_speech
        page.screenshot(path=str(OUTPUT / "waiting-plan.png"))
        page.locator("#auri-takeover-confirm").click()
        page.wait_for_function("window.AURI_HMI_NEXT.getState().viewModel.lifecycle.stage === 'action_completed'", timeout=15000)
        page.wait_for_function("window.__auriSpoken.length === 2", timeout=5000)
        completed_speech = page.evaluate("window.__auriSpoken")
        assert "AURI 已完成处理" in completed_speech[1], completed_speech
        page.wait_for_function("window.AURI_HMI_NEXT.getState().drivePlayback.speedKph >= 20", timeout=5000)
        page.wait_for_function("document.querySelector('.right-panel')?.dataset.vehicleMotion === 'moving'", timeout=5000)
        resumed_before = page.evaluate("window.AURI_HMI_NEXT.getState().drivePlayback.progress")
        resumed_authoritative = float(api("/v1/state")["navigation"]["progress"])
        resumed_metrics = follow_metrics(page)
        resumed_map = page.evaluate("window.AURI_HMI_NEXT.getState().map")
        page.screenshot(path=str(OUTPUT / "resumed-follow.png"))
        page.wait_for_timeout(900)
        resumed_after = page.evaluate("window.AURI_HMI_NEXT.getState().drivePlayback.progress")

        display_progress_before_overview = float(
            page.evaluate("window.AURI_HMI_NEXT.getState().drivePlayback.progress")
        )
        page.locator('[data-map-control="overview"]').click()
        page.wait_for_function("window.AURI_HMI_NEXT.getState().map.labels.labelsReadyModes.includes('overview')", timeout=5000)
        page.wait_for_timeout(300)
        overview = page.evaluate("window.AURI_HMI_NEXT.getState().map")
        display_progress_after_overview = float(
            page.evaluate("window.AURI_HMI_NEXT.getState().drivePlayback.progress")
        )
        overview_metrics = follow_metrics(page)
        if overview["labels"]["poiSearchStatus"] == "ready":
            assert overview_metrics["visiblePoiLabels"], overview_metrics
            assert overview["labels"]["poiVisibleCount"] >= 3, overview
        overview_transform = overview_metrics["transform"]
        page.screenshot(path=str(OUTPUT / "overview.png"))
        page.locator('[data-map-control="follow"]').click()
        page.wait_for_timeout(900)
        return_follow = page.evaluate("window.AURI_HMI_NEXT.getState().map")
        return_follow_progress = float(page.evaluate("window.AURI_HMI_NEXT.getState().drivePlayback.progress"))
        return_follow_metrics = follow_metrics(page)
        # The quota-safe POI enhancement searches once near the initial route
        # position. Near the destination those markers may correctly be outside
        # the viewport; native AMap labels remain the required follow context.
        page.screenshot(path=str(OUTPUT / "return-follow.png"))
        assert follow["cameraMode"] == "follow", follow
        assert overview["cameraMode"] == "overview", overview
        assert return_follow["cameraMode"] == "follow", return_follow
        assert follow["motionMethod"] == "moveAlong", follow
        assert follow["rendering3d"] == "native", follow
        assert follow_label == "3D 跟车", follow_label
        assert moving_after > moving_before, (moving_before, moving_after)
        assert abs(stopped_after - stopped_before) < 0.001, (stopped_before, stopped_after)
        assert [item["color"] for item in stopped_map["congestion"]] == ["#e6a700", "#d1495b", "#8f2032"], stopped_map
        assert all(item["visible"] and item["pointCount"] > 1 for item in stopped_map["congestion"]), stopped_map
        assert all(not item["visible"] for item in traffic_hidden_map["congestion"]), traffic_hidden_map
        assert traffic_hidden_metrics["controls"]["trafficPressed"] == "false", traffic_hidden_metrics
        assert abs(resumed_before - resumed_authoritative) < 0.02, (resumed_before, resumed_authoritative)
        assert resumed_after > resumed_before, (resumed_before, resumed_after)
        assert timing["mapMotionDurationMs"] < timing["tickIntervalMs"], timing
        assert follow["motion"]["plannedDurationMs"] <= timing["mapMotionDurationMs"], (follow, timing)
        assert follow["motion"]["overlapCount"] == 0, follow
        assert follow["motion"]["completedCount"] > 0, follow
        assert overview["motion"]["overlapCount"] == 0, overview
        assert 0 <= display_progress_after_overview - display_progress_before_overview < 0.02, (
            display_progress_before_overview,
            display_progress_after_overview,
        )
        assert abs(overview["motion"]["markerProgress"] - display_progress_after_overview) < 0.012, (
            overview,
            display_progress_after_overview,
        )
        assert overview["routeMeta"]["remainingDistanceMeters"] <= resumed_map["routeMeta"]["remainingDistanceMeters"], (resumed_map, overview)
        assert 0 <= return_follow_progress - display_progress_after_overview < 0.02, (
            display_progress_after_overview,
            return_follow_progress,
        )
        for map_state in (follow, stopped_map, resumed_map, return_follow):
            assert map_state["anchor"] is not None, map_state
            assert map_state["anchor"]["errorPx"] <= 1, map_state["anchor"]
        assert follow["anchor"]["point"] != stopped_map["anchor"]["point"], (follow, stopped_map)
        assert overview["anchor"] is None, overview
        rotation_error = abs(((follow["cameraRotation"] - follow["requestedCameraRotation"] + 180) % 360) - 180)
        assert rotation_error <= 1, follow
        for metrics in (moving_metrics, stopped_metrics, resumed_metrics, return_follow_metrics):
            assert metrics["amapCanvasOpacity"] >= 0.99, metrics
            assert metrics["fixedDisplay"] == "grid", metrics
            assert 0.47 <= metrics["fixedCenterRatio"]["x"] <= 0.53, metrics
            assert 0.69 <= metrics["fixedCenterRatio"]["y"] <= 0.75, metrics
            assert metrics["localRenderer"]["opacity"] <= 0.01, metrics
            assert metrics["localRenderer"]["visibility"] == "hidden", metrics
            vehicle = metrics["actualVehicle"]
            assert vehicle["display"] == "none" or vehicle["opacity"] == 0 or vehicle["width"] == 0, metrics
            assert not any(metrics["controls"]["zoomDisabled"]), metrics
        assert stopped_metrics["vehicleMotion"] == "stopped", stopped_metrics
        assert overview_metrics["amapCanvasOpacity"] >= 0.99, overview_metrics
        assert overview_metrics["localRenderer"]["opacity"] <= 0.01, overview_metrics
        assert overview_metrics["localRenderer"]["visibility"] == "hidden", overview_metrics
        assert overview_metrics["fixedDisplay"] == "none", overview_metrics
        assert overview_metrics["actualVehicle"]["width"] > 0 and overview_metrics["actualVehicle"]["opacity"] > 0, overview_metrics
        for marker in overview_metrics["overviewMarkers"].values():
            assert marker and marker["width"] > 0 and marker["height"] > 0, overview_metrics
            marker_center_x = marker["x"] + marker["width"] / 2
            marker_center_y = marker["y"] + marker["height"] / 2
            canvas = overview_metrics["canvas"]
            assert canvas["x"] <= marker_center_x <= canvas["x"] + canvas["width"], overview_metrics
            assert canvas["y"] <= marker_center_y <= canvas["y"] + canvas["height"], overview_metrics
        assert 24 <= follow["cameraPitch"] <= 28 and overview["cameraPitch"] == 0, (follow, overview)
        assert not errors, errors
        print(json.dumps({
            "follow": follow,
            "overview": overview,
            "displayProgressBeforeOverview": display_progress_before_overview,
            "displayProgressAfterOverview": display_progress_after_overview,
            "motionProgress": {
                "moving": [moving_before, moving_after],
                "stopped": [stopped_before, stopped_after],
                "resumed": [resumed_before, resumed_after],
            },
            "resumedAuthoritativeProgress": resumed_authoritative,
            "movingMetrics": moving_metrics,
            "stoppedMetrics": stopped_metrics,
            "trafficHiddenMetrics": traffic_hidden_metrics,
            "trafficHiddenMap": traffic_hidden_map,
            "resumedMetrics": resumed_metrics,
            "overviewMetrics": overview_metrics,
            "returnFollow": return_follow,
            "returnFollowMetrics": return_follow_metrics,
            "followLabel": follow_label,
            "overviewTransform": overview_transform,
            "timing": timing,
            "waitingPlan": waiting_plan,
            "speechBriefings": {"ready": ready_speech[0], "completed": completed_speech[1]},
            "screenshots": [
                str(OUTPUT / "moving-follow.png"),
                str(OUTPUT / "stopped-follow.png"),
                str(OUTPUT / "waiting-plan.png"),
                str(OUTPUT / "resumed-follow.png"),
                str(OUTPUT / "overview.png"),
                str(OUTPUT / "return-follow.png"),
            ],
            "javascriptErrors": errors,
        }, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    main()
