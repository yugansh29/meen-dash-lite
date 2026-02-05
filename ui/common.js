import {
  CFG,
  getCarstateHistory, pickLatestCarstate,
  getOwnerStatus, getTempCurrent, getHeadlightLatest,
  runHealthCheck, extractHealthErrors,
  setHeadlight as setHeadlightApi, 
  setCabinlight as setCabinlightApi,
  getMediaStatus, 
  playPauseMedia as playPauseMediaApi, 
  nextTrack as nextTrackApi, 
  previousTrack as previousTrackApi
} from "./api.js";

import { drawRingGauge, drawNeedleGauge, lerp } from "./gauges.js";

export function mountApp(screen) {
  const el = document.getElementById("app");
  const titleEl = document.getElementById("title");
  const dotEl = document.getElementById("dot");
  const pagesEl = document.getElementById("pages");

  titleEl.textContent = screen.toUpperCase();

  const pages = (screen === "left")
    ? [pageBattery, pageSpeed, pageMedia]
    : [pageOwner, pageHealth, pageControls];

  let page = 0;

  // live telemetry targets (from API)
  let targetSpeed = 0, targetBatt = 0, targetTemp = 0;
  let ownerDetected = false;
  let headlightOn = false;
  let healthErrors = [];
  let upstreamOk = true;
  let mediaStatus = "unavailable";
  let mediaTrack = { title: "No track", artist: "", album: "" };
  let mediaAvailable = false;

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
      get: () => ({ speed, batt, temp, ownerDetected, headlightOn, healthErrors, upstreamOk, mediaStatus, mediaTrack, mediaAvailable }),
      actions: { runHealth, setHeadlight, setCabinlight, playPauseMedia, nextTrack, previousTrack }
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

  async function pollMedia() {
    try {
      const m = await getMediaStatus();
      mediaStatus = m?.status || "unavailable";
      mediaAvailable = m?.has_player && mediaStatus !== "unavailable" && mediaStatus !== "no_player";
      if (m?.track) {
        mediaTrack = {
          title: m.track.title || "Unknown Track",
          artist: m.track.artist || "Unknown Artist",
          album: m.track.album || ""
        };
      } else {
        mediaTrack = { title: "No track", artist: "", album: "" };
      }
      setUpstream(true);
    } catch {
      mediaAvailable = false;
      setUpstream(false);
    } finally {
      setTimeout(pollMedia, CFG.MEDIA_POLL_MS);
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
  pollMedia();

  // expose for controls page
  async function setHeadlight(on) {
    await setUpstreamWrap(() => setHeadlightApi(on));
  }
  async function setCabinlight(payload) {
    await setUpstreamWrap(() => setCabinlightApi(payload));
  }
  async function playPauseMedia() {
    await setUpstreamWrap(async () => {
      await playPauseMediaApi();
      // Immediately poll to update UI
      setTimeout(pollMedia, 100);
    });
  }
  async function nextTrack() {
    await setUpstreamWrap(async () => {
      await nextTrackApi();
      setTimeout(pollMedia, 500);
    });
  }
  async function previousTrack() {
    await setUpstreamWrap(async () => {
      await previousTrackApi();
      setTimeout(pollMedia, 500);
    });
  }

  async function setUpstreamWrap(fn) {
    try { await fn(); setUpstream(true); }
    catch { setUpstream(false); }
  }

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

  function pageMedia({root, get, actions}) {
    const { mediaStatus, mediaTrack, mediaAvailable, upstreamOk } = get();
    const isPlaying = mediaStatus === "playing";
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    
    root.innerHTML = `
      <div class="card media-player">
        <div class="media-time">${timeStr}</div>
        <div class="media-art-container">
          <div class="media-art">
            <div class="media-art-icon">♪</div>
          </div>
        </div>
        ${!upstreamOk || !mediaAvailable ? `
          <div class="media-error">
            ${!upstreamOk ? "API not reachable" : "No Bluetooth media player"}
          </div>
        ` : ""}
        <div class="media-info">
          <div class="media-title">${mediaTrack.title}</div>
          <div class="media-artist">${mediaTrack.artist}</div>
        </div>
        <div class="media-controls">
          <button class="media-btn media-btn-prev" id="btnPrev" ${!mediaAvailable ? "disabled" : ""}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 20L9 12l10-8v16z"/>
              <path d="M5 19V5"/>
            </svg>
          </button>
          <button class="media-btn media-btn-play" id="btnPlay" ${!mediaAvailable ? "disabled" : ""}>
            ${isPlaying ? `
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="6" y="4" width="4" height="16"/>
                <rect x="14" y="4" width="4" height="16"/>
              </svg>
            ` : `
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            `}
          </button>
          <button class="media-btn media-btn-next" id="btnNext" ${!mediaAvailable ? "disabled" : ""}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 4l10 8-10 8V4z"/>
              <path d="M19 5v14"/>
            </svg>
          </button>
        </div>
      </div>
    `;
    
    if (mediaAvailable) {
      document.getElementById("btnPlay").onclick = () => actions.playPauseMedia();
      document.getElementById("btnPrev").onclick = () => actions.previousTrack();
      document.getElementById("btnNext").onclick = () => actions.nextTrack();
    }
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
