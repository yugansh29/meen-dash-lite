import {
  CFG,
  getCarstateHistory, pickLatestCarstate,
  getOwnerStatus, getTempCurrent, getHeadlightLatest,
  runHealthCheck, extractHealthErrors,
  setHeadlight, setCabinlight
} from "./api.js";

import { drawRingGauge, drawNeedleGauge, lerp } from "./gauges.js";

export function mountApp(screen) {
  const el = document.getElementById("app");
  const titleEl = document.getElementById("title");
  const dotEl = document.getElementById("dot");
  const pagesEl = document.getElementById("pages");

  titleEl.textContent = screen.toUpperCase();

  const pages = (screen === "left")
    ? [pageBattery, pageSpeed]
    : [pageOwner, pageHealth, pageControls];

  let page = 0;

  // live telemetry targets (from API)
  let targetSpeed = 0, targetBatt = 0, targetTemp = 0;
  let ownerDetected = false;
  let headlightOn = false;
  let healthErrors = [];
  let upstreamOk = true;

  // smoothed render values
  let speed = 0, batt = 0, temp = 0;

  function setUpstream(ok) {
    upstreamOk = ok;
    dotEl.className = "dot " + (ok ? "ok" : "bad");
  }

  function render() {
    pagesEl.textContent = `${page + 1}/${pages.length}`;
    el.innerHTML = "";
    pages[page]({
      root: el,
      get: () => ({ speed, batt, temp, ownerDetected, headlightOn, healthErrors, upstreamOk }),
      actions: { runHealth, setHeadlight, setCabinlight }
    });
  }

  // swipe
  bindSwipe(document.body,
    () => { page = (page + 1) % pages.length; render(); },
    () => { page = (page - 1 + pages.length) % pages.length; render(); }
  );

  async function pollCarstate() {
    try {
      const hist = await getCarstateHistory();
      const latest = pickLatestCarstate(hist);
      const data = latest?.data || {};
      targetSpeed = Number(data.speed ?? targetSpeed);
      targetBatt = Number(data.battery ?? targetBatt);
      setUpstream(true);
    } catch {
      setUpstream(false);
    } finally {
      setTimeout(pollCarstate, CFG.CARSTATE_POLL_MS);
    }
  }

  async function pollOwner() {
    try {
      const o = await getOwnerStatus();
      ownerDetected = !!o?.isOwnerDetected;
      setUpstream(true);
    } catch {
      setUpstream(false);
    } finally {
      setTimeout(pollOwner, CFG.OWNER_POLL_MS);
    }
  }

  async function pollTemp() {
    try {
      const t = await getTempCurrent();
      const v = (t?.battery_c ?? t?.battery ?? t?.battery_temp ?? t?.temperature ?? t?.temp_c);
      if (v !== undefined) targetTemp = Number(v);
      setUpstream(true);
    } catch {
      setUpstream(false);
    } finally {
      setTimeout(pollTemp, CFG.TEMP_POLL_MS);
    }
  }

  async function pollHeadlight() {
    try {
      const h = await getHeadlightLatest();
      headlightOn = !!h?.headlight;
      setUpstream(true);
    } catch {
      setUpstream(false);
    } finally {
      setTimeout(pollHeadlight, CFG.HEADLIGHT_POLL_MS);
    }
  }

  async function runHealth() {
    try {
      const resp = await runHealthCheck();
      healthErrors = extractHealthErrors(resp);
      setUpstream(true);
      render();
    } catch {
      setUpstream(false);
    }
  }

  // 60fps smoothing loop (no need to hit APIs at 60Hz)
  function anim() {
    speed = lerp(speed, targetSpeed, 0.12);
    batt  = lerp(batt,  targetBatt,  0.08);
    temp  = lerp(temp,  targetTemp,  0.10);
    requestAnimationFrame(anim);
  }

  // start
  render();
  anim();
  pollCarstate();
  pollOwner();
  pollTemp();
  pollHeadlight();

  // expose for controls page
  async function setHeadlight(on) {
    await setUpstreamWrap(() => setHeadlightApi(on));
  }
  async function setCabinlight(payload) {
    await setUpstreamWrap(() => setCabinlightApi(payload));
  }

  async function setUpstreamWrap(fn) {
    try { await fn(); setUpstream(true); }
    catch { setUpstream(false); }
  }

  async function setHeadlightApi(on) { return setHeadlight(on); }
  async function setCabinlightApi(payload) { return setCabinlight(payload); }

  // pages
  function pageBattery({root, get}) {
    const { batt, temp } = get();
    root.innerHTML = `
      <div class="card" style="display:flex; flex-direction:column; align-items:center; gap:10px;">
        <canvas id="ring" width="720" height="720"></canvas>
        <canvas id="needle" width="720" height="720" style="margin-top:-140px;"></canvas>
      </div>
    `;
    drawRingGauge(document.getElementById("ring").getContext("2d"), {
      w:720, h:720, value:batt, min:0, max:100, label:"BATTERY", unit:"%"
    });
    drawNeedleGauge(document.getElementById("needle").getContext("2d"), {
      w:720, h:720, value:temp, min:0, max:80, label:"BAT TEMP", unit:"°C"
    });
  }

  function pageSpeed({root, get}) {
    const { speed, batt } = get();
    root.innerHTML = `
      <div class="card" style="display:flex; flex-direction:column; align-items:center;">
        <canvas id="needle" width="720" height="720"></canvas>
        <canvas id="ring" width="720" height="720" style="margin-top:-170px;"></canvas>
      </div>
    `;
    drawNeedleGauge(document.getElementById("needle").getContext("2d"), {
      w:720, h:720, value:speed, min:0, max:160, label:"SPEED", unit:"km/h"
    });
    drawRingGauge(document.getElementById("ring").getContext("2d"), {
      w:720, h:720, value:batt, min:0, max:100, label:"BATT", unit:"%"
    });
  }

  function pageOwner({root, get}) {
    const { ownerDetected, upstreamOk } = get();
    root.innerHTML = `
      <div class="card">
        <div class="statuspill ${ownerDetected ? "ok" : "bad"}">
          <div class="statuslabel">OWNER / KEYFOB</div>
          <div class="statusvalue">${ownerDetected ? "PRESENT" : "NOT SEEN"}</div>
        </div>
        <div class="statuspill ${upstreamOk ? "ok" : "bad"}">
          <div class="statuslabel">API LINK</div>
          <div class="statusvalue">${upstreamOk ? "OK" : "DOWN"}</div>
        </div>
      </div>
    `;
  }

  function pageHealth({root, get, actions}) {
    const { healthErrors, upstreamOk } = get();
    const items = (healthErrors || []).map(e => `
      <div class="erritem">
        <div class="errpath">${e.path}</div>
        <div class="errval">${String(e.value)}</div>
      </div>
    `).join("");

    root.innerHTML = `
      <div class="card">
        <div style="font-size:34px; font-weight:900; margin-bottom:12px;">HEALTH</div>
        ${!upstreamOk ? `<div style="color:#ff3b3b; margin-bottom:10px;">Upstream API not reachable</div>` : ""}
        ${healthErrors.length === 0 ? `<div style="opacity:0.75; font-size:26px;">No faults</div>` : items}
        <button id="btnHealth" style="margin-top:10px;">Run Health Check</button>
        <div style="margin-top:10px; opacity:0.5; font-size:14px;">This page shows errors only.</div>
      </div>
    `;
    document.getElementById("btnHealth").onclick = () => actions.runHealth();
  }

  function pageControls({root, get, actions}) {
    const { headlightOn, upstreamOk } = get();
    root.innerHTML = `
      <div class="card">
        <div style="font-size:34px; font-weight:900; margin-bottom:12px;">CONTROLS</div>
        <button id="btnHead" ${upstreamOk ? "" : "disabled"}>
          Headlight: ${headlightOn ? "ON" : "OFF"}
        </button>
        <div style="height:10px"></div>
        <div class="btnrow">
          <button id="cGreen" ${upstreamOk ? "" : "disabled"}>Green</button>
          <button id="cWarm"  ${upstreamOk ? "" : "disabled"}>Warm White</button>
          <button id="b120"   ${upstreamOk ? "" : "disabled"}>Brightness 120</button>
          <button id="cOff"   ${upstreamOk ? "" : "disabled"}>Off</button>
        </div>
      </div>
    `;

    document.getElementById("btnHead").onclick = async () => {
      await actions.setHeadlight(!headlightOn);
    };
    document.getElementById("cGreen").onclick = async () => {
      await actions.setCabinlight({ state:"on", color:{r:0,g:255,b:0}, brightness:180 });
    };
    document.getElementById("cWarm").onclick = async () => {
      await actions.setCabinlight({ state:"on", color:{r:255,g:230,b:180}, brightness:180 });
    };
    document.getElementById("b120").onclick = async () => {
      await actions.setCabinlight({ brightness:120 });
    };
    document.getElementById("cOff").onclick = async () => {
      await actions.setCabinlight({ state:"off" });
    };
  }
}

function bindSwipe(el, onLeft, onRight) {
  let sx=0, sy=0, active=false;
  const threshold=50, restraint=80;

  el.addEventListener("pointerdown", (e) => {
    active=true; sx=e.clientX; sy=e.clientY;
  }, {passive:true});

  el.addEventListener("pointerup", (e) => {
    if (!active) return;
    active=false;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (Math.abs(dx) >= threshold && Math.abs(dy) <= restraint) {
      if (dx < 0) onLeft(); else onRight();
    }
  }, {passive:true});
}
