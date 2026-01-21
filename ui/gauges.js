export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
export function lerp(a, b, t) { return a + (b - a) * t; }

export function drawRingGauge(ctx, opts) {
  const { w, h, value, min, max, label, unit } = opts;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) * 0.33;
  const thick = Math.max(18, Math.floor(r * 0.12));

  const v = clamp(value, min, max);
  const pct = (v - min) / (max - min);

  // base ring
  ctx.lineWidth = thick;
  ctx.strokeStyle = "#162033";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // progress arc
  ctx.strokeStyle = "#39a7ff";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI/2, -Math.PI/2 + (Math.PI*2)*pct);
  ctx.stroke();

  // text
  ctx.fillStyle = "#9fb3d6";
  ctx.font = "700 28px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(label, cx, cy - 60);

  ctx.fillStyle = "#e8eefc";
  ctx.font = "900 88px system-ui";
  ctx.fillText(String(Math.round(v)), cx, cy + 30);

  ctx.fillStyle = "#9fb3d6";
  ctx.font = "600 26px system-ui";
  ctx.fillText(unit || "", cx, cy + 70);
}

export function drawNeedleGauge(ctx, opts) {
  const { w, h, value, min, max, label, unit } = opts;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) * 0.35;

  const v = clamp(value, min, max);
  const pct = (v - min) / (max - min);
  const a0 = (-140 * Math.PI) / 180;
  const a1 = ( 140 * Math.PI) / 180;
  const ang = lerp(a0, a1, pct);

  // rim
  ctx.strokeStyle = "#162033";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // needle
  ctx.strokeStyle = "#ffcc33";
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(ang) * (r * 0.85), cy + Math.sin(ang) * (r * 0.85));
  ctx.stroke();

  // hub
  ctx.fillStyle = "#ffcc33";
  ctx.beginPath();
  ctx.arc(cx, cy, 16, 0, Math.PI * 2);
  ctx.fill();

  // text
  ctx.fillStyle = "#9fb3d6";
  ctx.font = "700 28px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(label, cx, cy + r + 40);

  ctx.fillStyle = "#e8eefc";
  ctx.font = "900 64px system-ui";
  ctx.fillText(String(Math.round(v)), cx, cy + r + 110);

  ctx.fillStyle = "#9fb3d6";
  ctx.font = "600 22px system-ui";
  ctx.fillText(unit || "", cx, cy + r + 145);
}
