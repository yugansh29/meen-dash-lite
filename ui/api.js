// Edit these in one place
export const CFG = {
  BASE_URL: "http://meenmotors.local:8000",
  VEHICLE_ID: "685aa1bece3473f0456478b3",

  // Polling (ms) - keep reasonable; UI will animate smoothly on its own
  CARSTATE_POLL_MS: 100,
  OWNER_POLL_MS: 500,
  TEMP_POLL_MS: 500,
  HEADLIGHT_POLL_MS: 500,

  // Health check on-demand, not constant
};

async function http(method, path, body) {
  const url = CFG.BASE_URL.replace(/\/$/, "") + path;
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export async function getCarstateHistory() {
  return http("GET", `/carstate/${CFG.VEHICLE_ID}`);
}

export async function getOwnerStatus() {
  return http("GET", `/carstate/devices/${CFG.VEHICLE_ID}/owner_status`);
}

export async function getTempCurrent() {
  return http("GET", `/temperature/current`);
}

export async function getHeadlightLatest() {
  return http("GET", `/vehicles/${CFG.VEHICLE_ID}/headlight`);
}

export async function setHeadlight(on) {
  return http("POST", `/vehicles/${CFG.VEHICLE_ID}/headlight`, { on: !!on });
}

export async function setCabinlight(payload) {
  return http("POST", `/cabinlight`, payload);
}

export async function runHealthCheck() {
  return http("POST", `/health/check`, {});
}

// Latest selection from JSON array of records
export function pickLatestCarstate(records) {
  if (!Array.isArray(records) || records.length === 0) return null;

  // prefer max timestamp if parseable ISO string
  let best = records[records.length - 1];
  let bestTs = -1;

  for (const r of records) {
    const ts = r?.timestamp;
    if (typeof ts === "string") {
      const t = Date.parse(ts);
      if (!Number.isNaN(t) && t > bestTs) {
        bestTs = t;
        best = r;
      }
    }
  }
  return best;
}

// Extract error-only health entries (your rule)
export function extractHealthErrors(resp) {
  const latest = resp?.latest_health?.health_data;
  if (!latest || typeof latest !== "object") return [];

  const errors = [];
  for (const [subsystem, info] of Object.entries(latest)) {
    if (!info || typeof info !== "object") continue;
    if (info.status === "error") {
      errors.push({ path: `${subsystem}.status`, value: "error" });
      for (const [k, v] of Object.entries(info)) {
        if (k === "status") continue;
        errors.push({ path: `${subsystem}.${k}`, value: v });
      }
    }
  }
  return errors;
}
