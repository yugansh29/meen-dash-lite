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
  previousTrack as previousTrackApi,
  getMediaThumbnail
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
  let mediaTrack = { title: "No track", artist: "", album: "", position: 0, duration: 0 };
  let mediaAvailable = false;
  let mediaThumbnailUrl = null;
  
  // Local position tracking for smooth progress bar
  let localPosition = 0;
  let lastPositionUpdate = Date.now();

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
      get: () => ({ speed, batt, temp, ownerDetected, headlightOn, healthErrors, upstreamOk, mediaStatus, mediaTrack, mediaAvailable, mediaThumbnailUrl, localPosition }),
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

  async function pollMedia(shouldRender = false) {
    try {
      const m = await getMediaStatus();
      mediaStatus = m?.status || "unavailable";
      mediaAvailable = m?.has_player && mediaStatus !== "unavailable" && mediaStatus !== "no_player";
      
      const prevTitle = mediaTrack.title;
      const prevArtist = mediaTrack.artist;
      
      if (m?.track) {
        mediaTrack = {
          title: m.track.title || "Unknown Track",
          artist: m.track.artist || "Unknown Artist",
          album: m.track.album || "",
          position: m.track.position || 0,
          duration: m.track.duration || 0
        };
        
        console.log('Track info received:', mediaTrack);
        
        // Sync local position with API position
        localPosition = mediaTrack.position;
        lastPositionUpdate = Date.now();
        
        // Fetch thumbnail if track changed and we have valid artist and title
        // Don't require exact string match - just check they exist and aren't empty
        const hasValidInfo = mediaTrack.artist && mediaTrack.title && 
                            mediaTrack.artist.trim() !== "" && 
                            mediaTrack.title.trim() !== "" &&
                            !mediaTrack.artist.toLowerCase().includes("unknown") &&
                            !mediaTrack.title.toLowerCase().includes("unknown");
        
        if ((mediaTrack.title !== prevTitle || mediaTrack.artist !== prevArtist) && hasValidInfo) {
          console.log('Track changed, fetching thumbnail');
          fetchThumbnail(mediaTrack.artist, mediaTrack.title);
        } else if (!hasValidInfo) {
          console.log('Skipping thumbnail fetch - invalid track info');
        }
      } else {
        mediaTrack = { title: "No track", artist: "", album: "", position: 0, duration: 0 };
        localPosition = 0;
        mediaThumbnailUrl = null;
      }
      setUpstream(true);
      if (shouldRender) {
        render();
      }
    } catch {
      mediaAvailable = false;
      setUpstream(false);
    } finally {
      setTimeout(pollMedia, CFG.MEDIA_POLL_MS);
    }
  }

  async function fetchThumbnail(artist, title) {
    try {
      console.log('Fetching thumbnail for:', artist, title);
      const result = await getMediaThumbnail(artist, title);
      console.log('Thumbnail result:', result);
      if (result?.thumbnail_url) {
        mediaThumbnailUrl = result.thumbnail_url;
        console.log('Thumbnail URL set:', mediaThumbnailUrl);
        render(); // Re-render to show new thumbnail
      } else {
        console.warn('No thumbnail URL in result');
        mediaThumbnailUrl = null;
      }
    } catch (e) {
      console.warn("Failed to fetch thumbnail:", e);
      mediaThumbnailUrl = null;
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
  let frameCount = 0;
  function anim() {
    speed = lerp(speed, targetSpeed, 0.12);
    batt  = lerp(batt,  targetBatt,  0.08);
    temp  = lerp(temp,  targetTemp,  0.10);
    
    // Update local position when playing
    if (mediaStatus === "playing" && mediaTrack.duration > 0) {
      const elapsed = Date.now() - lastPositionUpdate;
      localPosition = Math.min(mediaTrack.position + elapsed, mediaTrack.duration);
    }
    
    // Re-render media page every 15 frames (~4 times per second) if it's the active page
    frameCount++;
    const mediaPageIndex = (screen === "left") ? 2 : -1; // Media is 3rd page on left screen
    if (frameCount % 15 === 0 && page === mediaPageIndex && mediaStatus === "playing") {
      render();
    }
    
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
      setTimeout(() => pollMedia(true), 100);
    });
  }
  async function nextTrack() {
    await setUpstreamWrap(async () => {
      await nextTrackApi();
      // Wait for Bluetooth to update, then poll and re-render
      setTimeout(() => pollMedia(true), 800);
    });
  }
  async function previousTrack() {
    await setUpstreamWrap(async () => {
      await previousTrackApi();
      // Wait for Bluetooth to update, then poll and re-render
      setTimeout(() => pollMedia(true), 800);
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
    const { mediaStatus, mediaTrack, mediaAvailable, upstreamOk, mediaThumbnailUrl, localPosition } = get();
    const isPlaying = mediaStatus === "playing";
    
    // Calculate progress percentage using local position for smooth updates
    const currentPosition = localPosition || mediaTrack.position;
    const progress = mediaTrack.duration > 0 
      ? (currentPosition / mediaTrack.duration) * 100 
      : 0;
    
    // Format time in mm:ss
    const formatTime = (ms) => {
      const seconds = Math.floor(ms / 1000);
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    };
    
    const currentTime = formatTime(currentPosition);
    const totalTime = formatTime(mediaTrack.duration);
    
    // Build background style - use thumbnail if available, dimmed
    console.log('Media player rendering:', { mediaThumbnailUrl, mediaTrack });
    const backgroundStyle = mediaThumbnailUrl 
      ? `background-image: url('${mediaThumbnailUrl}'); background-size: cover; background-position: center;`
      : `background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%);`;
    
    root.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:center; width:100%; height:100%;">
        <div class="media-player" style="${backgroundStyle}">
          <div class="media-player-content">
            ${!upstreamOk || !mediaAvailable ? `
              <div class="media-error">
                ${!upstreamOk ? "API not reachable" : "No Bluetooth media player"}
              </div>
            ` : ""}
            
            <div class="media-info">
              <div class="media-title">${mediaTrack.title}</div>
              <div class="media-artist">${mediaTrack.artist}</div>
            </div>
            
            <div class="media-progress-container">
              <div class="media-progress-bar">
                <div class="media-progress-fill" style="width: ${progress}%"></div>
              </div>
              <div class="media-time">
                <span>${currentTime}</span>
                <span>${totalTime}</span>
              </div>
            </div>
            
            <div class="media-controls">
              <button class="media-btn media-btn-prev" id="btnPrev" ${!mediaAvailable ? "disabled" : ""}>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M15 3L6 10l9 7V3z"/>
                </svg>
              </button>
              <button class="media-btn media-btn-play" id="btnPlay" ${!mediaAvailable ? "disabled" : ""}>
                ${isPlaying ? `
                  <svg width="48" height="48" viewBox="0 0 48 48" fill="currentColor">
                    <rect x="14" y="10" width="6" height="28" rx="2"/>
                    <rect x="28" y="10" width="6" height="28" rx="2"/>
                  </svg>
                ` : `
                  <svg width="48" height="48" viewBox="0 0 48 48" fill="currentColor">
                    <path d="M16 10l24 14-24 14V10z"/>
                  </svg>
                `}
              </button>
              <button class="media-btn media-btn-next" id="btnNext" ${!mediaAvailable ? "disabled" : ""}>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M5 3l9 7-9 7V3z"/>
                </svg>
              </button>
            </div>
          </div>
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
