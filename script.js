"use strict";

/* iOS ก่อน 15.4 (เช่น iPhone 6s/7 ที่ยังไม่ได้อัปเดต) ไม่มีสองฟังก์ชันนี้
   ถ้าไม่เติมให้ แดชบอร์ดแสดงไม่ครบและกดเปลี่ยนหน้าไม่ได้ตั้งแต่เปิดเว็บ */
if (!Object.hasOwn) Object.hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
if (!Array.prototype.at) {
  Object.defineProperty(Array.prototype, "at", {
    configurable: true, writable: true,
    value(index) { const i = Math.trunc(index) || 0; return this[i < 0 ? this.length + i : i]; },
  });
}

/* =========================================================
   CONSTANTS
   ========================================================= */
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB — ต้องตรงกับ worker/src/index.js และ firestore.rules
const PDF_MIME = "application/pdf";
const PAGE_SIZE = 8;
const STATUS_LABEL = {
  approved: "อนุมัติแล้ว", pending: "รอดำเนินการ", rejected: "ไม่อนุมัติ",
  "in-progress": "กำลังดำเนินการ", completed: "เสร็จสิ้น", cancelled: "ยกเลิก",
};
// ตัวเลือกสถานะของแต่ละฟอร์ม ต้องตรงกับ firestore.rules
// ทั้งสองแบบไม่บังคับเลือก ("" = ยังไม่ระบุ) คำสั่งมี 4 ขั้น ใช้ "รอดำเนินการ" ร่วมกับเอกสาร
const DOC_STATUSES = ["", "pending", "approved", "rejected"];
const ORDER_STATUSES = ["", "pending", "in-progress", "completed", "cancelled"];
// ชั้นความเร็วของหนังสือ — ค่าว่าง (หรือเอกสารเดิมที่ไม่มีช่องนี้) คือปกติ ต้องตรงกับ firestore.rules
const URGENCY_LABEL = { urgent: "ด่วน", "very-urgent": "ด่วนมาก", "most-urgent": "ด่วนที่สุด" };

/* =========================================================
   STATE
   ========================================================= */
let allDocuments = [];   // live, non-deleted
let allTrash = [];       // soft-deleted
let allCategories = [];

let pendingFileData = null; // { file, name, size } — ตัวไฟล์ส่งไป R2 ตอนบันทึก
let confirmCallback = null;
let charts = {};
let fileReadVersion = 0;
let fileReading = false;
let fileInvalid = false;
let previewUrl = null;
let previewRequest = 0;

/* =========================================================
   THEME & APPEARANCE
   ผู้ใช้เลือกโหมดสีและปรับไล่ระดับเฉดสีม่วงได้
   ค่าที่ตั้งไว้ถูกเขียนทับลงบนตัวแปร CSS ของ :root แล้วบันทึกใน localStorage
   ========================================================= */
const APPEARANCE_KEY = "govdocs-appearance";
const RADIUS_BASE = { "--radius-xs": 8, "--radius-sm": 12, "--radius": 18, "--radius-lg": 24 };

/* สีพื้นฐานและสีสถานะของแต่ละโหมด */
const APPEARANCE_DEFAULTS = {
  light: { bg: "#F8F5FC", surface: "#FFFFFF", text: "#30203F", primary: "#7851A9", accent: "#D9C9EE", success: "#17805A", warning: "#B5771A", danger: "#BE3535" },
  dark:  { bg: "#150D20", surface: "#231730", text: "#F3EBFA", primary: "#BC9AE0", accent: "#DFD1F1", success: "#46C68D", warning: "#E7B953", danger: "#EB7A7A" },
};

const COLOR_PRESETS = [
  { id: "default", name: "ม่วงราชินี", start: [270, 38, 55], end: [272, 39, 32] },
  { id: "lavender", name: "ลาเวนเดอร์", start: [260, 65, 88], end: [272, 52, 70] },
  { id: "lilac", name: "ไลแลค", start: [280, 48, 85], end: [290, 40, 65] },
  { id: "violet", name: "ไวโอเล็ต", start: [260, 80, 67], end: [275, 65, 40] },
  { id: "amethyst", name: "อเมทิสต์", start: [272, 58, 65], end: [283, 52, 38] },
  { id: "orchid", name: "กล้วยไม้", start: [292, 62, 75], end: [285, 64, 44] },
  { id: "royal", name: "ม่วงราชสำนัก", start: [260, 50, 48], end: [275, 58, 25] },
  { id: "plum", name: "ม่วงพลัม", start: [290, 35, 48], end: [295, 42, 22] },
  { id: "midnight", name: "ม่วงราตรี", start: [255, 45, 32], end: [275, 48, 12] },
];
const PURPLE_CHANNELS = { h: [250, 300], s: [10, 100], l: [5, 95] };

function presetGradient(preset, mode) {
  const stop = ([h, s, l]) => ({ h, s, l: mode === "dark" ? Math.max(5, Math.round(l * 0.65)) : l });
  return { start: stop(preset.start), end: stop(preset.end), angle: 135 };
}

function cleanGradient(value, fallback) {
  const stop = (key) => Object.fromEntries(Object.entries(PURPLE_CHANNELS).map(([channel, [min, max]]) => [
    channel, Number.isFinite(value?.[key]?.[channel]) ? Math.round(Math.min(max, Math.max(min, value[key][channel]))) : fallback[key][channel],
  ]));
  return {
    start: stop("start"), end: stop("end"),
    angle: Number.isFinite(value?.angle) ? Math.round(Math.min(360, Math.max(0, value.angle)) / 5) * 5 : fallback.angle,
  };
}

/* ---------- color helpers ---------- */
const isHex = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

function parseHex(hex) {
  let h = String(hex).trim().replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16) || 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function toHex({ r, g, b }) {
  const part = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}
/** ผสมสี a กับ b — t = 0 ได้ a ล้วน, t = 1 ได้ b ล้วน */
function mixHex(a, b, t) {
  const A = parseHex(a), B = parseHex(b);
  return toHex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t });
}
function rgbList(hex) { const c = parseHex(hex); return `${c.r}, ${c.g}, ${c.b}`; }
function rgbaHex(hex, alpha) { const c = parseHex(hex); return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`; }

function purpleHex({ h, s, l }) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return toHex({ r: channel(0), g: channel(8), b: channel(4) });
}

// Keep valid purple choices from the previous color picker; discard other hues.
function legacyPurple(hex) {
  if (!isHex(hex)) return null;
  const { r, g, b } = parseHex(hex);
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
  const delta = max - min, l = (max + min) / 2;
  if (!delta) return null;
  const h = ((max === r / 255 ? (g - b) / (255 * delta) : max === g / 255 ? (b - r) / (255 * delta) + 2 : (r - g) / (255 * delta) + 4) * 60 + 360) % 360;
  if (h < 250 || h > 300) return null;
  return { h, s: delta / (1 - Math.abs(2 * l - 1)) * 100, l: l * 100 };
}

function gradientCSS(gradient, start = purpleHex(gradient.start), end = purpleHex(gradient.end)) {
  return `linear-gradient(${gradient.angle}deg, ${start} 0%, ${end} 100%)`;
}

function luminance(hex) {
  const linear = Object.values(parseHex(hex)).map((n) => {
    n /= 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

// Pick readable text, adjusting the surface only for gradients that span light and dark.
function readableGradient(gradient) {
  const start = purpleHex(gradient.start), end = purpleHex(gradient.end);
  const contrast = (ink, a, b) => {
    const text = luminance(ink);
    return Math.min(...Array.from({ length: 17 }, (_, i) => {
      const bg = luminance(mixHex(a, b, i / 16));
      return (Math.max(text, bg) + 0.05) / (Math.min(text, bg) + 0.05);
    }));
  };
  const ink = contrast("#20102E", start, end) >= contrast("#FFFFFF", start, end) ? "#20102E" : "#FFFFFF";
  const target = ink === "#FFFFFF" ? "#000000" : "#FFFFFF";
  let a = start, b = end;
  for (let step = 1; contrast(ink, a, b) < 4.5 && step <= 20; step++) {
    a = mixHex(start, target, step / 20);
    b = mixHex(end, target, step / 20);
  }
  return { background: gradientCSS(gradient, a, b), ink, start: a, end: b };
}

/** สร้างตัวแปร CSS ทั้งชุดจากโทนม่วงและสีสถานะ */
function deriveVars(b, dark) {
  const W = "#FFFFFF", K = "#000000";
  const tint = (c, t) => mixHex(c, dark ? b.bg : W, t);
  return {
    "--bg": b.bg,
    "--bg-deep": mixHex(b.bg, K, dark ? 0.3 : 0.055),
    "--surface": b.surface,
    "--surface-2": dark ? mixHex(b.surface, W, 0.05) : mixHex(b.surface, b.bg, 0.55),
    "--surface-3": dark ? mixHex(b.surface, W, 0.1) : mixHex(b.surface, b.bg, 0.85),
    "--glass": rgbaHex(b.surface, 0.72),
    "--glass-strong": rgbaHex(b.surface, 0.92),
    "--border": mixHex(dark ? b.surface : b.bg, b.text, dark ? 0.16 : 0.14),
    "--border-soft": mixHex(dark ? b.surface : b.bg, b.text, dark ? 0.09 : 0.07),
    "--text": b.text,
    "--text-muted": mixHex(b.text, b.bg, 0.38),
    "--text-faint": mixHex(b.text, b.bg, 0.55),
    "--primary": b.primary,
    "--primary-600": dark ? mixHex(b.primary, W, 0.16) : mixHex(b.primary, K, 0.22),
    "--primary-400": dark ? mixHex(b.primary, K, 0.12) : mixHex(b.primary, W, 0.18),
    "--primary-100": dark ? mixHex(b.primary, b.bg, 0.84) : mixHex(b.primary, W, 0.88),
    "--primary-rgb": rgbList(b.primary),
    "--accent": b.accent,
    "--accent-soft": tint(b.accent, dark ? 0.84 : 0.82),
    "--success": b.success,
    "--success-bg": tint(b.success, dark ? 0.86 : 0.84),
    "--success-rgb": rgbList(b.success),
    "--warning": b.warning,
    "--warning-bg": tint(b.warning, dark ? 0.86 : 0.84),
    "--warning-rgb": rgbList(b.warning),
    "--danger": b.danger,
    "--danger-bg": tint(b.danger, dark ? 0.86 : 0.84),
    "--danger-rgb": rgbList(b.danger),
    "--grad-primary": `linear-gradient(135deg, ${mixHex(b.primary, W, dark ? 0.06 : 0.1)} 0%, ${b.primary} 45%, ${mixHex(b.primary, K, dark ? 0.35 : 0.28)} 100%)`,
    "--grad-start": mixHex(b.primary, W, dark ? 0.06 : 0.1),
    "--grad-end": mixHex(b.primary, K, dark ? 0.35 : 0.28),
    "--grad-accent": `linear-gradient(135deg, ${mixHex(b.accent, W, 0.22)}, ${b.accent})`,
  };
}

const MANAGED_VARS = [...Object.keys(deriveVars(APPEARANCE_DEFAULTS.light, false)), "--on-primary", "--on-primary-muted", ...Object.keys(RADIUS_BASE)];

/* ---------- state ---------- */
let appearance = loadAppearance();

function loadAppearance() {
  let fallbackMode = "system";
  const blank = {
    version: 2, mode: fallbackMode, radius: 100,
    light: presetGradient(COLOR_PRESETS[0], "light"), dark: presetGradient(COLOR_PRESETS[0], "dark"),
  };
  try {
    const legacyMode = localStorage.getItem("govdocs-theme");
    if (["light", "dark", "system"].includes(legacyMode)) fallbackMode = legacyMode;
    blank.mode = fallbackMode;
    const saved = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || "null");
    if (!saved || typeof saved !== "object") return blank;
    const clean = (mode) => {
      if (saved.version === 2) return cleanGradient(saved[mode], blank[mode]);
      const start = legacyPurple(saved[mode]?.primary);
      if (!start) return blank[mode];
      const end = legacyPurple(saved[mode]?.accent) || { ...start, l: start.l * 0.65 };
      return cleanGradient({ start, end, angle: 135 }, blank[mode]);
    };
    return {
      version: 2,
      mode: ["light", "dark", "system"].includes(saved.mode) ? saved.mode : fallbackMode,
      radius: Number.isFinite(saved.radius) ? Math.min(200, Math.max(0, saved.radius)) : 100,
      light: clean("light"),
      dark: clean("dark"),
    };
  } catch {
    return blank;
  }
}

function saveAppearance() {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
    localStorage.setItem("govdocs-theme", appearance.mode); // เผื่อโค้ดเดิมที่อ่านคีย์นี้
  } catch { /* โหมดส่วนตัวของเบราว์เซอร์อาจบันทึกไม่ได้ — ไม่ถือเป็นข้อผิดพลาด */ }
}

const systemMode = () => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
const activeMode = () => (appearance.mode === "system" ? systemMode() : appearance.mode);
function baseColors(mode) {
  const dark = mode === "dark";
  const { start, end } = appearance[mode];
  const middle = { h: (start.h + end.h) / 2, s: (start.s + end.s) / 2, l: (start.l + end.l) / 2 };
  const primary = purpleHex({ ...middle, l: dark ? Math.max(65, Math.min(82, middle.l)) : Math.max(30, Math.min(47, middle.l)) });
  return {
    ...APPEARANCE_DEFAULTS[mode], primary,
    accent: purpleHex({ ...middle, s: Math.min(60, middle.s), l: dark ? 84 : 86 }),
    bg: purpleHex({ h: middle.h, s: 35, l: dark ? 8 : 97 }),
    surface: dark ? purpleHex({ h: middle.h, s: 30, l: 14 }) : "#FFFFFF",
    text: purpleHex({ h: middle.h, s: 30, l: dark ? 95 : 19 }),
  };
}

/** ใส่ค่าสีทั้งหมดลง :root ตามโหมดปัจจุบัน */
function applyAppearance({ repaintCharts = false } = {}) {
  const mode = activeMode();
  const root = document.documentElement;
  root.setAttribute("data-theme", mode);

  MANAGED_VARS.forEach((prop) => root.style.removeProperty(prop));

  const vars = deriveVars(baseColors(mode), mode === "dark");
  const readable = readableGradient(appearance[mode]);
  vars["--grad-primary"] = readable.background;
  vars["--grad-start"] = readable.start;
  vars["--grad-end"] = readable.end;
  vars["--on-primary"] = readable.ink;
  vars["--on-primary-muted"] = readable.ink;
  Object.entries(vars).forEach(([prop, value]) => root.style.setProperty(prop, value));
  if (appearance.radius !== 100) {
    Object.entries(RADIUS_BASE).forEach(([prop, px]) => root.style.setProperty(prop, `${Math.round((px * appearance.radius) / 100)}px`));
  }
  if (repaintCharts) renderCharts();
}

/* ---------- UI ---------- */
function renderPresets() {
  const grid = document.getElementById("presetGrid");
  const focusedPreset = document.activeElement?.dataset?.preset;
  grid.innerHTML = "";
  const mode = activeMode();
  COLOR_PRESETS.forEach((p) => {
    const btn = document.createElement("button");
    const gradient = presetGradient(p, mode);
    const selected = JSON.stringify(appearance[mode]) === JSON.stringify(gradient);
    btn.type = "button";
    btn.className = `preset-btn${selected ? " is-active" : ""}`;
    btn.dataset.preset = p.id;
    btn.setAttribute("aria-pressed", String(selected));
    btn.innerHTML = `<span class="preset-gradient" aria-hidden="true" style="background:${readableGradient(gradient).background}"></span><span>${p.name}</span>`;
    btn.addEventListener("click", () => applyPreset(p));
    grid.appendChild(btn);
    if (focusedPreset === p.id) btn.focus({ preventScroll: true });
  });
}

function applyPreset(p) {
  appearance[activeMode()] = presetGradient(p, activeMode());
  saveAppearance();
  applyAppearance({ repaintCharts: true });
  syncAppearanceUI();
  showToast(`ใช้ชุดสี “${p.name}” แล้ว`, "success");
}

function syncGradientUI() {
  const gradient = appearance[activeMode()];
  const channels = { h: "Hue", s: "Saturation", l: "Lightness" };
  ["start", "end"].forEach((stop) => {
    const prefix = `gradient${stop === "start" ? "Start" : "End"}`;
    const color = purpleHex(gradient[stop]);
    document.getElementById(`${prefix}Chip`).style.background = color;
    document.getElementById(`${prefix}Hex`).textContent = color;
    Object.entries(channels).forEach(([channel, suffix]) => {
      const input = document.getElementById(prefix + suffix);
      input.value = gradient[stop][channel];
      document.getElementById(`${prefix}${suffix}Value`).textContent = `${input.value}${channel === "h" ? "°" : "%"}`;
      const [min, max] = PURPLE_CHANNELS[channel];
      const samples = Array.from({ length: 7 }, (_, i) => purpleHex({ ...gradient[stop], [channel]: min + (max - min) * i / 6 }));
      input.style.background = `linear-gradient(90deg, ${samples.join(", ")})`;
    });
  });
  document.getElementById("gradientAngle").value = gradient.angle;
  document.getElementById("gradientAngleValue").textContent = `${gradient.angle}°`;
  document.getElementById("gradientPreview").style.background = readableGradient(gradient).background;
}

function syncAppearanceUI() {
  const mode = activeMode();
  document.querySelectorAll("#modeSegment button").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.mode === appearance.mode);
    b.setAttribute("aria-pressed", String(b.dataset.mode === appearance.mode));
  });
  document.getElementById("tuneModeNote").textContent =
    `กำลังแก้ไขสีของโหมด${mode === "dark" ? "มืด" : "สว่าง"}`;

  syncGradientUI();

  document.getElementById("radiusRange").value = appearance.radius;
  document.getElementById("radiusValue").textContent = `${appearance.radius}%`;
  renderPresets();
}

function setMode(mode) {
  appearance.mode = mode;
  saveAppearance();
  applyAppearance({ repaintCharts: true });
  syncAppearanceUI();
}

function resetAppearance() {
  appearance = {
    version: 2, mode: appearance.mode, radius: 100,
    light: presetGradient(COLOR_PRESETS[0], "light"), dark: presetGradient(COLOR_PRESETS[0], "dark"),
  };
  saveAppearance();
  applyAppearance({ repaintCharts: true });
  syncAppearanceUI();
  showToast("คืนค่าสีเริ่มต้นแล้ว", "success");
}

/* ---------- wiring ---------- */
applyAppearance();

document.getElementById("appearanceBtn").addEventListener("click", () => {
  syncAppearanceUI();
  openModal("appearanceModalOverlay");
});

document.getElementById("themeToggle").addEventListener("click", () => {
  setMode(activeMode() === "dark" ? "light" : "dark");
});

document.getElementById("modeSegment").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (btn) setMode(btn.dataset.mode);
});

document.getElementById("gradientEditor").addEventListener("input", (e) => {
  const input = e.target.closest("input[type=range]");
  if (!input || !Number.isFinite(Number(input.value))) return;
  const mode = activeMode();
  const gradient = appearance[mode];
  if (input.id === "gradientAngle") gradient.angle = Number(input.value);
  else if (["start", "end"].includes(input.dataset.gradientStop) && Object.hasOwn(PURPLE_CHANNELS, input.dataset.gradientChannel)) {
    gradient[input.dataset.gradientStop][input.dataset.gradientChannel] = Number(input.value);
  } else return;
  appearance[mode] = cleanGradient(gradient, presetGradient(COLOR_PRESETS[0], mode));
  saveAppearance();
  applyAppearance();
  syncGradientUI();
  // Preserve focus while dragging or using the arrow keys on a range control.
  renderPresets();
});
document.getElementById("gradientEditor").addEventListener("change", (e) => {
  if (e.target.closest("input[type=range]")) renderCharts();
});
document.getElementById("reverseGradientBtn").addEventListener("click", () => {
  const gradient = appearance[activeMode()];
  [gradient.start, gradient.end] = [gradient.end, gradient.start];
  saveAppearance();
  applyAppearance({ repaintCharts: true });
  syncAppearanceUI();
});

const radiusRange = document.getElementById("radiusRange");
radiusRange.addEventListener("input", () => {
  appearance.radius = Number(radiusRange.value);
  document.getElementById("radiusValue").textContent = `${appearance.radius}%`;
  saveAppearance();
  applyAppearance();
});

document.getElementById("resetAppearanceBtn").addEventListener("click", resetAppearance);

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (appearance.mode === "system") {
    applyAppearance({ repaintCharts: true });
    syncAppearanceUI();
  }
});

/* =========================================================
   TOASTS
   ========================================================= */
const TOAST_ICON = {
  success: `<path d="M20 6L9 17l-5-5"/>`,
  error: `<path d="M12 8v5m0 3h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>`,
  info: `<path d="M12 16v-5m0-3h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/>`,
};
function showToast(message, type = "info") {
  const stack = document.getElementById("toastStack");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `
    <span class="toast-ico"><svg viewBox="0 0 24 24">${TOAST_ICON[type] || TOAST_ICON.info}</svg></span>
    <span class="toast-text"></span>`;
  el.querySelector(".toast-text").textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 260);
  }, 3800);
}

/* =========================================================
   APP START — single-user setup, no login screen.
   Signs in anonymously in the background so Firestore rules can
   still require request.auth != null without showing any UI for it.
   ========================================================= */
function signInDatabase() {
  if (typeof auth === "undefined" || !auth || typeof db === "undefined" || !db) return Promise.resolve(false);
  return auth.signInAnonymously().then(() => true).catch((err) => {
    showToast("เชื่อมต่อฐานข้อมูลไม่สำเร็จ: " + friendlyError(err), "error");
    return false;
  });
}
let databaseReady = signInDatabase();
let databaseReconnecting = false;
let firestoreUnsubscribes = [];

databaseReady.then(() => {
  if (typeof db !== "undefined" && db) attachFirestoreListeners();
});
if (typeof db === "undefined" || !db) {
  // no status bar to fall back on, so this startup failure has to speak up itself
  showToast("โหลดฐานข้อมูลไม่สำเร็จ กรุณาโหลดหน้าใหม่", "error");
}

window.addEventListener("online", async () => {
  if (databaseReconnecting) return;
  databaseReconnecting = true;
  try {
    // A failed first sign-in must not leave the app without data after the connection returns.
    if (!(await databaseReady)) {
      databaseReady = signInDatabase();
      if (await databaseReady) attachFirestoreListeners();
    }
  } finally {
    databaseReconnecting = false;
  }
});

/* =========================================================
   NAVIGATION
   ========================================================= */
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});
document.querySelectorAll("[data-view-link]").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.viewLink));
});

const VIEW_TITLE = {
  dashboard: "แดชบอร์ด",
  documents: "เอกสารทั้งหมด",
  categories: "หมวดหมู่เอกสาร",
  trash: "รายการที่ลบ",
};

function switchView(view) {
  if (!Object.hasOwn(VIEW_TITLE, view)) return;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${view}`));
  document.getElementById("pageTitle").textContent = VIEW_TITLE[view] || "แดชบอร์ด";
  window.scrollTo({ top: 0, behavior: "smooth" });
  closeSidebarMobile();
  if (view === "dashboard") Object.values(charts).forEach((chart) => chart.resize());
}

const sidebar = document.getElementById("sidebar");
const scrim = document.getElementById("scrim");
document.getElementById("menuToggle").addEventListener("click", () => {
  sidebar.classList.add("is-open");
  scrim.classList.add("is-visible");
  document.getElementById("menuToggle").setAttribute("aria-expanded", "true");
});
scrim.addEventListener("click", closeSidebarMobile);
function closeSidebarMobile() {
  sidebar.classList.remove("is-open");
  scrim.classList.remove("is-visible");
  document.getElementById("menuToggle").setAttribute("aria-expanded", "false");
}

/* =========================================================
   MODAL HELPERS
   ========================================================= */
const modalFocus = new Map();
function openModal(id) {
  const overlay = document.getElementById(id);
  modalFocus.set(id, document.activeElement);
  overlay.hidden = false;
  document.getElementById("app").inert = true;
  document.body.classList.add("modal-open");
  (overlay.querySelector('input:not([type="hidden"]):not([type="file"]), [data-close-modal]') || overlay.querySelector(".modal")).focus();
}
function closeModal(id) {
  const overlay = document.getElementById(id);
  if (overlay.getAttribute("aria-busy") === "true") return;
  overlay.hidden = true;
  if (id === "docModalOverlay") { fileReadVersion++; fileReading = false; }
  if (id === "confirmModalOverlay") confirmCallback = null;
  if (id === "previewModalOverlay") {
    previewRequest++; // ไฟล์ที่ยังโหลดไม่เสร็จจะไม่เปิดหน้าต่างขึ้นมาอีกหลังปิดไปแล้ว
    closePageViewer();
    document.getElementById("previewFrame").removeAttribute("src");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  const anotherOpen = [...document.querySelectorAll(".modal-overlay")].some((m) => !m.hidden);
  document.getElementById("app").inert = anotherOpen;
  document.body.classList.toggle("modal-open", anotherOpen);
  const trigger = modalFocus.get(id);
  if (trigger?.isConnected) trigger.focus();
  modalFocus.delete(id);
}
function setModalBusy(id, busy) {
  const overlay = document.getElementById(id);
  overlay.setAttribute("aria-busy", String(busy));
  // ช่องที่ล็อกไว้ (หมวดหมู่ของฟอร์มคำสั่ง) ยังปิดอยู่หลังบันทึกเสร็จ
  overlay.querySelectorAll("button, input, select, textarea").forEach((el) => { el.disabled = busy || "locked" in el.dataset; });
}
document.querySelectorAll("[data-close-modal]").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.closest(".modal-overlay").id));
});
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(overlay.id); });
});

/* Esc closes the topmost open modal · Ctrl/⌘+K jumps to search */
document.addEventListener("keydown", (e) => {
  const open = [...document.querySelectorAll(".modal-overlay")].filter((m) => !m.hidden).pop();
  if (e.key === "Escape") {
    if (open) closeModal(open.id);
    else closeSidebarMobile();
  }
  if (e.key === "Tab" && open) {
    const focusable = [...open.querySelectorAll('button, input, select, textarea, iframe, [tabindex="0"]')]
      .filter((el) => !el.disabled && el.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (!first) { e.preventDefault(); return; }
    if (e.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) {
      e.preventDefault(); first.focus();
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (open) return;
    document.getElementById("globalSearch").focus();
  }
});

function askConfirm(message, onConfirm) {
  document.getElementById("confirmMessage").textContent = message;
  confirmCallback = onConfirm;
  openModal("confirmModalOverlay");
}
document.getElementById("confirmActionBtn").addEventListener("click", async () => {
  if (!confirmCallback || document.getElementById("confirmActionBtn").disabled) return;
  const action = confirmCallback;
  setModalBusy("confirmModalOverlay", true);
  try { await action(); }
  catch (err) { showToast(friendlyError(err), "error"); }
  finally {
    setModalBusy("confirmModalOverlay", false);
    closeModal("confirmModalOverlay");
  }
});

/* =========================================================
   FIRESTORE LISTENERS
   ========================================================= */
function attachFirestoreListeners() {
  firestoreUnsubscribes.forEach((unsubscribe) => { if (typeof unsubscribe === "function") unsubscribe(); });
  firestoreUnsubscribes = [];
  // การโหลดคือการอ่าน ข้อความไม่มีสิทธิ์จึงต่างจากตอนบันทึก
  const failed = (err) => showToast("โหลดข้อมูลล้มเหลว: "
    + (err?.code === "permission-denied" ? "ไม่มีสิทธิ์อ่านข้อมูลเอกสาร" : friendlyError(err)), "error");

  firestoreUnsubscribes.push(db.collection("documents").where("deleted", "==", false)
    .onSnapshot({ includeMetadataChanges: true }, (snap) => {
      allDocuments = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      renderAll();
    }, failed));

  firestoreUnsubscribes.push(db.collection("documents").where("deleted", "==", true)
    .onSnapshot({ includeMetadataChanges: true }, (snap) => {
      allTrash = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      renderTrash();
      renderStats();
    }, failed));

  firestoreUnsubscribes.push(db.collection("categories").orderBy("name")
    .onSnapshot({ includeMetadataChanges: true }, (snap) => {
      allCategories = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      renderCategoryOptions();
      renderAll();
      ensureDefaultCategories(snap);
    }, failed));
}

/* หมวดหมู่ที่ระบบต้องมีเสมอ สร้างให้อัตโนมัติถ้ายังไม่มีในฐานข้อมูล */
const DEFAULT_CATEGORIES = ["คำสั่ง", "บันทึกข้อความ", "คำร้อง"];
/* ชื่อหมวดหมู่เดิม → ชื่อใหม่ เปลี่ยนชื่อใน doc เดิม (id ไม่เปลี่ยน เอกสารที่อ้างถึงจึงไม่หลุด) */
const RENAMED_CATEGORIES = { "หนังสือคำสั่ง": "คำสั่ง" };
let defaultCategoriesChecked = false;

/* เทียบชื่อหมวดหมู่โดยไม่สนช่องว่างหัวท้ายและตัวพิมพ์ */
const categoryKey = (name) => String(name).trim().normalize().toLocaleLowerCase("th");
const isDefaultCategory = (name) => DEFAULT_CATEGORIES.some((d) => categoryKey(d) === categoryKey(name));

function ensureDefaultCategories(snap) {
  // รอสแนปช็อตจริงจากเซิร์ฟเวอร์ก่อน ไม่งั้นข้อมูลจากแคชอาจทำให้สร้างซ้ำ
  if (defaultCategoriesChecked || snap.metadata.fromCache || snap.metadata.hasPendingWrites) return;
  defaultCategoriesChecked = true;
  const existing = new Set(allCategories.map((c) => categoryKey(c.name)));
  Object.entries(RENAMED_CATEGORIES).forEach(([from, to]) => {
    const old = allCategories.find((c) => categoryKey(c.name) === categoryKey(from));
    if (!old || existing.has(categoryKey(to))) return;
    existing.add(categoryKey(to));
    db.collection("categories").doc(old.id).update({ name: to })
      .catch((err) => console.warn("เปลี่ยนชื่อหมวดหมู่ไม่สำเร็จ:", from, err));
  });
  DEFAULT_CATEGORIES.filter((name) => !existing.has(categoryKey(name))).forEach((name) => {
    db.collection("categories").add({ name, createdAt: Date.now() })
      .catch((err) => console.warn("สร้างหมวดหมู่เริ่มต้นไม่สำเร็จ:", name, err));
  });
}

function renderAll() {
  renderStats();
  renderCharts();
  renderRecentTable();
  renderDocsTable();
  renderCategories();
  // คำสั่งที่เพิ่งเพิ่มหรือแก้ (รวมจากเครื่องอื่น) ขึ้นในผลค้นหาของฟอร์มคำสั่งที่เปิดอยู่ทันที
  if (!document.getElementById("docModalOverlay").hidden && !document.getElementById("orderLookup").hidden) renderOrderLookup();
}

/* =========================================================
   DASHBOARD: STATS + CHARTS
   ========================================================= */
/* Animates a number from its current value to `target` */
function countTo(el, target) {
  if (el.countAnimation) cancelAnimationFrame(el.countAnimation);
  const from = Number(el.textContent.replace(/[^\d]/g, "")) || 0;
  if (from === target) { el.textContent = target; return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 600);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(from + (target - from) * eased);
    if (t < 1) el.countAnimation = requestAnimationFrame(step);
  };
  el.countAnimation = requestAnimationFrame(step);
}

function renderStats() {
  const total = allDocuments.length;
  const counts = {
    Total: total,
    Approved: allDocuments.filter((d) => d.status === "approved").length,
    Pending: allDocuments.filter((d) => d.status === "pending").length,
    Rejected: allDocuments.filter((d) => d.status === "rejected").length,
  };

  Object.entries(counts).forEach(([key, value]) => {
    countTo(document.getElementById(`stat${key}`), value);
    const pct = total ? Math.round((value / total) * 100) : 0;
    const meter = document.getElementById(`meter${key}`);
    if (meter && key !== "Total") {
      meter.style.width = `${pct}%`;
      meter.classList.toggle("is-empty", pct === 0); // แถบว่างไม่ต้องมีแสงเรือง
    }
    const chip = document.getElementById(`chip${key}`);
    if (chip && key !== "Total") chip.textContent = `${pct}%`;
  });

  // sidebar badges
  document.getElementById("navCountDocs").textContent = total;
  document.getElementById("navCountCats").textContent = allCategories.length;
  renderTrashBadge();
}
/* ตัวเลขรายการที่ลบบนเมนู เป็นสีแดงเมื่อมีเอกสารค้างอยู่ในถังขยะ */
function renderTrashBadge() {
  const badge = document.getElementById("navCountTrash");
  badge.textContent = allTrash.length;
  badge.classList.toggle("is-alert", allTrash.length > 0);
}

/* การ์ดสถิติสามมิติ: บนคอมพิวเตอร์ การ์ดเอียงเข้าหาเมาส์และมีแสงสะท้อนตามจุดที่ชี้
   ส่งมุมและตำแหน่งให้ CSS ทาง --rx --ry --mx --my มือถือ (แตะ ไม่มีการชี้ค้าง) และเครื่องที่ตั้งให้ลดการเคลื่อนไหว การ์ดอยู่นิ่ง */
const TILT_DEGREES = 10; // ช่วงเอียงทั้งหมด จากกลางการ์ดถึงขอบจึงเอียงได้ข้างละ 5 องศา
const tiltMedia = window.matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
document.querySelectorAll("[data-tilt]").forEach((card) => {
  card.insertAdjacentHTML("beforeend", '<span class="fx-glare" aria-hidden="true"></span>');
  let frame = 0;
  card.addEventListener("pointermove", (e) => {
    if (!tiltMedia.matches || e.pointerType === "touch" || e.target !== card) return;
    // ส่วนในการ์ดไม่รับเมาส์ (CSS) offsetX/offsetY จึงเป็นพิกัดบนตัวการ์ดเอง ถูกต้องแม้การ์ดกำลังเอียง ลอยอยู่ หรือหน้าเพิ่งเลื่อน
    // ต่างจากกรอบของ getBoundingClientRect ซึ่งเพี้ยนตามมุมที่การ์ดเอียงอยู่
    const x = Math.min(1, Math.max(0, e.offsetX / card.clientWidth));
    const y = Math.min(1, Math.max(0, e.offsetY / card.clientHeight));
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      card.style.setProperty("--rx", `${((0.5 - y) * TILT_DEGREES).toFixed(2)}deg`);
      card.style.setProperty("--ry", `${((x - 0.5) * TILT_DEGREES).toFixed(2)}deg`);
      card.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
      card.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
    });
  });
  card.addEventListener("pointerleave", () => {
    cancelAnimationFrame(frame);
    ["--rx", "--ry", "--mx", "--my"].forEach((name) => card.style.removeProperty(name));
  });
});

/* อ่านสีจากตัวแปร CSS โดยตรง กราฟจึงเปลี่ยนตามธีมและสีที่ผู้ใช้ตั้งเองเสมอ */
function chartColors() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  const primary = v("--primary", dark ? "#BC9AE0" : "#7851A9");
  const primaryRgb = v("--primary-rgb", dark ? "188, 154, 224" : "120, 81, 169");
  return {
    text: v("--text-muted", dark ? "#B7A1C8" : "#77618A"),
    grid: v("--border", dark ? "#4B355E" : "#E4D6EF"),
    fill: `rgba(${primaryRgb}, ${dark ? 0.18 : 0.12})`,
    primaryRgb,
    tooltipBg: dark ? v("--surface-2", "#2C1E3B") : v("--text", "#30203F"),
    tooltipText: dark ? v("--text", "#F3EBFA") : "#FFFFFF",
    palette: [
      primary,
      v("--accent", dark ? "#DFD1F1" : "#D9C9EE"),
      v("--success", "#17805A"),
      v("--danger", "#BE3535"),
      v("--primary-400", primary),
      v("--warning", "#B5771A"),
    ],
  };
}

function chartTooltip(c) {
  return {
    backgroundColor: c.tooltipBg,
    titleColor: c.tooltipText,
    bodyColor: c.tooltipText,
    padding: 12,
    cornerRadius: 10,
    borderColor: c.grid,
    borderWidth: 1,
    displayColors: true,
    boxPadding: 5,
  };
}

/* =========================================================
   3D CHARTS
   Chart.js ไม่มีกราฟ 3 มิติในตัว จึงวาดหน้าตาเองตามตำแหน่งที่ Chart.js คำนวณไว้
   แท่ง = กล่องมีด้านบน/ด้านข้าง, เส้น = พื้นที่ทึบมีความหนา, โดนัท = วงแหวนเอียงมีความหนา
   hover, tooltip และแอนิเมชันยังเป็นของ Chart.js ทั้งหมด
   ========================================================= */
const TAU = Math.PI * 2;
const DEPTH_SLOPE = 0.62; // ความลึกชี้ไปทางขวาบน: ขึ้น 0.62px ต่อการเลื่อนขวา 1px
const DOUGHNUT_TILT = 0.56; // มองโดนัทจากมุมเฉียง: ความสูงเหลือ 56% ของความกว้าง

let colorProbe;
/* แปลงสีรูปแบบใดก็ได้ที่ canvas รู้จัก (hex, rgb, ชื่อสี) เป็น [r, g, b] */
function toRgb(color) {
  if (typeof color !== "string") return [128, 128, 128];
  colorProbe = colorProbe || document.createElement("canvas").getContext("2d");
  colorProbe.fillStyle = "#808080";
  colorProbe.fillStyle = color;
  const s = colorProbe.fillStyle;
  if (s[0] === "#") return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  return (s.match(/[\d.]+/g) || [128, 128, 128]).slice(0, 3).map(Number);
}

/* amount > 0 ผสมขาว, < 0 ผสมดำ (0–1) ใช้ทำด้านสว่าง/ด้านเงาของรูปทรง */
function shade(color, amount, alpha = 1) {
  const target = amount < 0 ? 0 : 255;
  const [r, g, b] = toRgb(color).map((ch) => Math.round(ch + (target - ch) * Math.abs(amount)));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function fillPolygon(ctx, points, fill) {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/* เงานุ่ม ๆ รูปวงรีที่ตกบนพื้นใต้รูปทรง; hollow = สัดส่วนรูตรงกลางที่ไม่มีเงา (ใช้กับโดนัท) */
function floorShadow(ctx, x, y, rx, ry, strength, hollow = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(hollow, `rgba(42, 20, 66, ${hollow ? 0 : strength})`);
  g.addColorStop(hollow ? (hollow + 1) / 2 : 0.35, `rgba(42, 20, 66, ${strength})`);
  g.addColorStop(1, "rgba(42, 20, 66, 0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function barDepth(width) { return Math.min(14, Math.max(6, width * 0.36)); }

function drawBarFloor(chart, opts) {
  const bar = chart.getDatasetMeta(0).data[0];
  if (!bar || !chart.scales.y) return;
  const { ctx, chartArea: a } = chart;
  const dx = barDepth(bar.width), dy = dx * DEPTH_SLOPE;
  const base = chart.scales.y.getPixelForValue(0);
  ctx.save();
  fillPolygon(ctx, [[a.left, base], [a.right, base], [a.right + dx, base - dy], [a.left + dx, base - dy]], opts.floor);
  ctx.beginPath();
  ctx.moveTo(a.left + dx, base - dy);
  ctx.lineTo(a.right + dx, base - dy);
  ctx.strokeStyle = opts.edge;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawBars3d(chart, meta) {
  const { ctx } = chart;
  meta.data.forEach((el) => {
    const { x, y, base, width } = el;
    const top = Math.min(y, base), bottom = Math.max(y, base);
    if (!(width > 0) || bottom - top < 0.5) return;
    const color = el.options.backgroundColor;
    const dx = barDepth(width), dy = dx * DEPTH_SLOPE;
    const left = x - width / 2, right = x + width / 2;

    floorShadow(ctx, x + dx / 2, bottom - dy / 2, width * 0.95, width * 0.3, 0.28);

    const side = ctx.createLinearGradient(0, top, 0, bottom);
    side.addColorStop(0, shade(color, -0.22));
    side.addColorStop(1, shade(color, -0.45));
    fillPolygon(ctx, [[right, top], [right + dx, top - dy], [right + dx, bottom - dy], [right, bottom]], side);
    fillPolygon(ctx, [[left, top], [left + dx, top - dy], [right + dx, top - dy], [right, top]], shade(color, 0.38));

    const front = ctx.createLinearGradient(left, 0, right, 0);
    front.addColorStop(0, shade(color, 0.2));
    front.addColorStop(0.5, shade(color, 0));
    front.addColorStop(1, shade(color, -0.1));
    ctx.fillStyle = front;
    ctx.fillRect(left, top, width, bottom - top);
    // สันขอบบนสว่าง ทำให้กล่องดูคม
    ctx.fillStyle = "rgba(255, 255, 255, .45)";
    ctx.fillRect(left, top, width, 1);
  });
}

/* ไล่สีพื้นที่ใต้เส้น (หน้าตัดด้านหน้าของก้อน 3 มิติ) */
function areaGradient(chart, rgb) {
  const a = chart.chartArea;
  if (!a) return `rgba(${rgb}, .15)`;
  const g = chart.ctx.createLinearGradient(0, a.top, 0, a.bottom);
  g.addColorStop(0, `rgba(${rgb}, .38)`);
  g.addColorStop(1, `rgba(${rgb}, .04)`);
  return g;
}

/* พื้นที่ใต้เส้น (Filler ของ Chart.js วาดไว้แล้ว) เป็นหน้าตัดด้านหน้า
   ตรงนี้เติมผิวด้านบนเป็นริบบอน ด้านข้างปลายขวา และแสงเรืองใต้เส้น
   ตัวเส้นให้ Chart.js วาดเองต่อจากนี้ เพราะมันคำนวณจุดควบคุมเส้นโค้งใหม่ทุกเฟรมระหว่างแอนิเมชัน */
function drawLineDepth(chart, meta) {
  const { ctx, chartArea: a } = chart;
  const pts = meta.data.filter((p) => !p.skip);
  if (!pts.length || !chart.scales.y) return;
  meta.dataset.updateControlPoints(a); // ไม่ทำอะไรถ้าเฟรมนี้คำนวณไว้แล้ว
  const line = meta.dataset.options;
  const color = line.borderColor;
  const dx = 10, dy = dx * DEPTH_SLOPE;
  const base = Math.min(a.bottom, chart.scales.y.getPixelForValue(0));
  // จุดควบคุมเส้นโค้งที่ Chart.js คำนวณไว้ ถ้าไม่มี (tension 0) ใช้ตัวจุดเอง
  const cp = (p, name) => p[name] ?? p[name.slice(-1)];
  const forward = (p, q, ox = 0, oy = 0) => ctx.bezierCurveTo(
    cp(p, "cp2x") + ox, cp(p, "cp2y") + oy, cp(q, "cp1x") + ox, cp(q, "cp1y") + oy, q.x + ox, q.y + oy);
  const backward = (q, p, ox, oy) => ctx.bezierCurveTo(
    cp(q, "cp1x") + ox, cp(q, "cp1y") + oy, cp(p, "cp2x") + ox, cp(p, "cp2y") + oy, p.x + ox, p.y + oy);

  // ผิวด้านบน: ช่วงที่เส้นลงหันเข้าหาผู้ดูจึงสว่างกว่า ช่วงที่ขึ้นจะเข้มกว่า
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    const rise = Math.max(-1, Math.min(1, Math.atan2(p.y - q.y, q.x - p.x) / (Math.PI / 3)));
    const fill = shade(color, 0.42 - 0.32 * rise);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    forward(p, q);
    ctx.lineTo(q.x + dx, q.y - dy);
    backward(q, p, dx, -dy);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x + dx, pts[0].y - dy);
  for (let i = 1; i < pts.length; i++) forward(pts[i - 1], pts[i], dx, -dy);
  ctx.strokeStyle = shade(color, 0.65);
  ctx.lineWidth = 1;
  ctx.stroke();

  const last = pts[pts.length - 1];
  const side = ctx.createLinearGradient(0, last.y, 0, base);
  side.addColorStop(0, shade(color, -0.15, 0.45));
  side.addColorStop(1, shade(color, -0.15, 0.06));
  fillPolygon(ctx, [[last.x, last.y], [last.x + dx, last.y - dy], [last.x + dx, base - dy], [last.x, base]], side);

  ctx.save();
  ctx.shadowColor = shade(color, 0, 0.45);
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 6;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) forward(pts[i - 1], pts[i]);
  ctx.strokeStyle = color;
  ctx.lineWidth = line.borderWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
}

/* จุดข้อมูลเป็นทรงกลมมันวาว วาดทับจุดแบนของ Chart.js ด้วยรัศมีเดียวกัน (รวมตอน hover) */
function drawLineSpheres(chart, meta) {
  const { ctx } = chart;
  meta.data.filter((p) => !p.skip).forEach((p) => {
    const r = p.options.radius;
    if (!(r > 0)) return;
    const tone = p.options.backgroundColor;
    const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.1, p.x, p.y, r);
    g.addColorStop(0, shade(tone, 0.8));
    g.addColorStop(0.45, shade(tone, 0.05));
    g.addColorStop(1, shade(tone, -0.4));
    ctx.save();
    ctx.shadowColor = "rgba(42, 20, 66, .35)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, TAU);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  });
}

/* โดนัทเอียง: วาดชิ้นส่วนเดิมของ Chart.js ผ่านการย่อแนวตั้ง แล้วซ้อนสำเนาที่เข้มกว่าลงด้านล่างเป็นความหนา
   การชี้เมาส์/ตำแหน่ง tooltip ถูกแปลงพิกัดกลับให้ตรงกับรูปที่เอียง */
function drawDoughnut3d(chart, meta) {
  const { ctx, chartArea: a } = chart;
  const arcs = meta.data.filter((el) => el.circumference > 0.0001);
  if (!arcs.length || !(arcs[0].outerRadius > 0)) { chart.$tilt = null; return; }
  const { x: cx, y: cy, outerRadius: R } = arcs[0];
  const depth = Math.max(8, Math.min(18, R * 0.16));
  const sx = Math.max(0.2, Math.min((a.width - 16) / (2 * R), (a.height - depth - 10) / (2 * R * DOUGHNUT_TILT)));
  const t = chart.$tilt = { cx, cy, sx, sy: sx * DOUGHNUT_TILT, oy: -depth / 2 };
  const tilt = (down = 0) => {
    ctx.translate(cx, cy + t.oy + down);
    ctx.scale(t.sx, t.sy);
    ctx.translate(-cx, -cy);
  };
  // วาดชิ้นด้วยสีอื่นโดยไม่แตะ options จริงของ Chart.js
  const paint = (el, fill) => {
    const face = Object.create(el);
    face.options = { ...el.options, backgroundColor: fill, borderWidth: 0 };
    face.draw(ctx);
  };

  meta.data.forEach((el) => {
    if (el.$tilted) return;
    const proto = Object.getPrototypeOf(el);
    const toScreen = (p) => {
      const s = chart.$tilt;
      return s ? { x: s.cx + (p.x - s.cx) * s.sx, y: s.cy + s.oy + (p.y - s.cy) * s.sy } : p;
    };
    el.inRange = (mx, my, useFinal) => {
      const s = chart.$tilt;
      return s
        ? proto.inRange.call(el, s.cx + (mx - s.cx) / s.sx, s.cy + (my - s.cy - s.oy) / s.sy, useFinal)
        : proto.inRange.call(el, mx, my, useFinal);
    };
    el.tooltipPosition = (useFinal) => toScreen(proto.tooltipPosition.call(el, useFinal));
    el.getCenterPoint = (useFinal) => toScreen(proto.getCenterPoint.call(el, useFinal));
    el.$tilted = true;
  });

  floorShadow(ctx, cx, cy + t.oy + depth + 4, R * t.sx * 1.06, R * t.sy * 1.06, 0.24, arcs[0].innerRadius / R);

  // ผนังด้านข้าง: ชิ้นที่อยู่ด้านหลังวาดก่อน ชิ้นด้านหน้าวาดทีหลัง
  const backToFront = [...arcs].sort((p, q) =>
    Math.sin((p.startAngle + p.endAngle) / 2) - Math.sin((q.startAngle + q.endAngle) / 2));
  backToFront.forEach((el) => {
    const color = el.options.backgroundColor;
    for (let k = Math.ceil(depth); k >= 1; k--) {
      ctx.save();
      tilt(k);
      paint(el, shade(color, -0.2 - 0.25 * (k / depth)));
      ctx.restore();
    }
  });

  arcs.forEach((el) => {
    const color = el.options.backgroundColor;
    ctx.save();
    tilt();
    const top = ctx.createLinearGradient(cx, cy - R, cx, cy + R);
    top.addColorStop(0, shade(color, 0.3));
    top.addColorStop(1, shade(color, -0.06));
    paint(el, top);
    ctx.restore();
  });
}

const chart3d = {
  id: "chart3d",
  beforeDatasetsDraw(chart, _args, opts) {
    if (chart.config.type === "bar") drawBarFloor(chart, opts);
  },
  beforeDatasetDraw(chart, { meta }) {
    const type = chart.config.type;
    const draw = { bar: drawBars3d, line: drawLineDepth, doughnut: drawDoughnut3d }[type];
    if (!draw) return;
    chart.ctx.save();
    draw(chart, meta);
    chart.ctx.restore();
    if (type !== "line") return false; // แท่งและโดนัทวาดเองทั้งหมด ไม่ให้ Chart.js วาดแบบ 2 มิติซ้ำ
  },
  afterDatasetDraw(chart, { meta }) {
    if (chart.config.type !== "line") return;
    chart.ctx.save();
    drawLineSpheres(chart, meta);
    chart.ctx.restore();
  },
};

function renderCharts() {
  if (typeof Chart === "undefined") return;
  const c = chartColors();
  Chart.defaults.font.family = "Sarabun";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = c.text;

  // --- by category ---
  const catCounts = Object.create(null);
  allDocuments.forEach((d) => {
    const name = categoryName(d.category) || "ไม่ระบุหมวดหมู่";
    catCounts[name] = (catCounts[name] || 0) + 1;
  });
  paintChart("chartCategory", "bar", {
    labels: Object.keys(catCounts),
    datasets: [{
      data: Object.values(catCounts),
      backgroundColor: Object.keys(catCounts).map((_, i) => c.palette[i % c.palette.length]),
      maxBarThickness: 52,
    }],
  }, {
    // เว้นขอบบน/ขวาให้ด้านบนและด้านข้างของกล่อง 3 มิติ
    layout: { padding: { top: 10, right: 16 } },
    plugins: { legend: { display: false }, tooltip: chartTooltip(c), chart3d: { floor: c.fill, edge: c.grid } },
    scales: {
      x: { grid: { display: false }, border: { display: false } },
      y: { grid: { color: c.grid }, border: { display: false }, beginAtZero: true, grace: "12%", ticks: { precision: 0 } },
    },
  });

  // --- by status ---
  const statusCounts = { approved: 0, pending: 0, rejected: 0 };
  allDocuments.forEach((d) => { if (statusCounts[d.status] !== undefined) statusCounts[d.status]++; });
  paintChart("chartStatus", "doughnut", {
    labels: [STATUS_LABEL.approved, STATUS_LABEL.pending, STATUS_LABEL.rejected],
    datasets: [{
      data: [statusCounts.approved, statusCounts.pending, statusCounts.rejected],
      backgroundColor: [c.palette[2], c.palette[5], c.palette[3]],
      borderWidth: 0, spacing: 2, hoverOffset: 10,
    }],
  }, {
    // วงหนาขึ้นให้เห็นความเป็นก้อน 3 มิติ; คำอธิบายไว้ด้านขวา โดนัทเอียงจึงกว้างได้เต็มที่
    cutout: "58%",
    plugins: {
      tooltip: chartTooltip(c),
      legend: { position: "right", labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: "circle", padding: 16 } },
    },
  });

  // --- monthly trend (last 6 months) ---
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${dt.getFullYear()}-${dt.getMonth()}`, label: dt.toLocaleDateString("th-TH", { month: "short", year: "2-digit" }) });
  }
  const trendData = months.map((m) => allDocuments.filter((d) => {
    const dt = new Date(createdAtMillis(d));
    return `${dt.getFullYear()}-${dt.getMonth()}` === m.key;
  }).length);
  paintChart("chartTrend", "line", {
    labels: months.map((m) => m.label),
    datasets: [{
      data: trendData,
      borderColor: c.palette[0],
      backgroundColor: (context) => areaGradient(context.chart, c.primaryRgb),
      borderWidth: 2.5,
      fill: true,
      tension: 0.4,
      pointRadius: 5,
      pointHoverRadius: 8,
      pointHitRadius: 12,
      pointBorderWidth: 0,
      pointBackgroundColor: c.palette[0],
    }],
  }, {
    layout: { padding: { top: 10, right: 14 } },
    plugins: { legend: { display: false }, tooltip: chartTooltip(c) },
    interaction: { mode: "index", intersect: false },
    scales: {
      x: { grid: { display: false }, border: { display: false } },
      y: { grid: { color: c.grid }, border: { display: false }, beginAtZero: true, grace: "12%", ticks: { precision: 0 } },
    },
  });
}

function paintChart(canvasId, type, data, extraOptions) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart(ctx, {
    type, data, plugins: [chart3d],
    options: { responsive: true, maintainAspectRatio: false, ...extraOptions },
  });
}

function renderRecentTable() {
  const tbody = document.querySelector("#recentTable tbody");
  const recent = [...allDocuments].sort((a, b) => byEntry(b, a)).slice(0, 5);
  tbody.innerHTML = recent.map((d) => `
    <tr>
      <td class="mono">${escapeHtml(d.docNumber || "-")}</td>
      <td class="doc-title-cell">${docTitle(d)}</td>
      <td>${escapeHtml(categoryName(d.category) || "-")}</td>
      <td class="mono">${formatDate(d.date)}</td>
      <td>${statusStamp(d.status)}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="doc-sub">ยังไม่มีเอกสาร</td></tr>`;
  bindRowActions(tbody); // ชื่อเอกสารที่แนบ PDF กดเปิดดูได้จากแดชบอร์ดเหมือนในหน้าเอกสาร
}

/* =========================================================
   CATEGORIES
   ========================================================= */
function categoryName(id) {
  const cat = allCategories.find((c) => c.id === id);
  return cat ? cat.name : "";
}
/* คำสั่งคือรายการในหมวดคำสั่ง เรียกช่องต่าง ๆ แบบคำสั่ง ทั้งในฟอร์มและหัวตารางที่กรองดูเฉพาะคำสั่ง
   แต่ยังเก็บใน title, docNumber, date และ agency เหมือนเอกสาร */
const ORDER_CATEGORY = "คำสั่ง";
const FIELD_LABELS = {
  document: { title: "ชื่อเอกสาร", docNumber: "เลขที่หนังสือ", date: "วันที่ออกเอกสาร", agency: "หน่วยงาน" },
  order: { title: "ชื่อคำสั่ง", docNumber: "เลขที่คำสั่ง", date: "วันที่ออกคำสั่ง", agency: "ผู้สั่ง" },
};
/* บางหมวดเป็นเอกสาร แต่เรียกช่องหน่วยงานตามเรื่องของหมวด ทั้งในฟอร์มและหัวคอลัมน์
   (หนังสือส่งถึงใคร หนังสือรับมาจากใคร คำร้องใครยื่น) ค่ายังเก็บใน agency เหมือนเดิม */
const AGENCY_LABELS = { "หนังสือส่ง": "ถึง", "หนังสือรับ": "จาก", "คำร้อง": "ผู้ยื่นคำร้อง" };
function documentAgencyLabel(id) {
  const key = categoryKey(categoryName(id));
  const name = Object.keys(AGENCY_LABELS).find((n) => categoryKey(n) === key);
  return name ? AGENCY_LABELS[name] : FIELD_LABELS.document.agency;
}
/* หนังสือรับมีเลขที่รับ (เลขทะเบียนรับของ อบต.) แยกจากเลขที่หนังสือของผู้ส่ง เก็บใน receiveNumber
   มีช่องเฉพาะในฟอร์มหนังสือรับ และมีคอลัมน์เฉพาะในตารางที่กรองดูเฉพาะหนังสือรับ */
const RECEIVE_CATEGORY = "หนังสือรับ";
function isReceiveCategory(id) {
  return !!id && categoryKey(categoryName(id)) === categoryKey(RECEIVE_CATEGORY);
}
function isOrderCategory(id) {
  return !!id && categoryKey(categoryName(id)) === categoryKey(ORDER_CATEGORY);
}
function orderCategoryId() {
  return allCategories.find((c) => categoryKey(c.name) === categoryKey(ORDER_CATEGORY))?.id || "";
}
/* ฟอร์มคำสั่ง: เปิดจากปุ่มเพิ่มคำสั่งในกล่องคำสั่งหรือแก้ไขคำสั่ง (หมวดหมู่ล็อกไว้ที่คำสั่ง) หรือเลือกหมวดคำสั่งในฟอร์มเพิ่มเอกสาร */
function docFormIsOrder() {
  const category = document.getElementById("docCategory");
  return "locked" in category.dataset || isOrderCategory(category.value);
}
/* รายการสถานะของฟอร์ม ตัวเลือกว่างของเอกสารเขียนว่าไม่ระบุสถานะ ของคำสั่งเว้นว่างไว้เลย
   สถานะเดิมที่ฟอร์มนี้ไม่มีให้เลือก (เช่น คำสั่งเก่าที่บันทึกไว้ว่าอนุมัติแล้ว) ใส่ไว้เป็นตัวเลือกแรก
   แก้ช่องอื่นแล้วบันทึก สถานะจึงไม่เปลี่ยนไปเอง */
function renderStatusOptions(order, value) {
  const select = document.getElementById("docStatus");
  const choices = order ? ORDER_STATUSES : DOC_STATUSES;
  const blank = order ? "" : "ไม่ระบุสถานะ";
  select.innerHTML = (choices.includes(value) ? choices : [value, ...choices])
    .map((s) => `<option value="${s}">${s ? STATUS_LABEL[s] : blank}</option>`).join("");
  select.value = value;
  select.dataset.mode = order ? "order" : "document";
}
function syncOrderFields() {
  const category = document.getElementById("docCategory");
  // หมวดคำสั่งอาจโหลดเสร็จ หรือเพิ่งเปลี่ยนชื่อจาก "หนังสือคำสั่ง" ระหว่างที่ฟอร์มเปิดอยู่
  if ("locked" in category.dataset) category.value = orderCategoryId();
  const order = docFormIsOrder();
  const editing = Boolean(document.getElementById("docId").value);
  const labels = FIELD_LABELS[order ? "order" : "document"];
  document.getElementById("docModalTitle").textContent = order
    ? (editing ? "แก้ไขคำสั่ง" : "เพิ่มคำสั่งใหม่")
    : (editing ? "แก้ไขเอกสาร" : "เพิ่มเอกสารใหม่");
  document.getElementById("docModalSubtitle").textContent =
    order ? "กรอกรายละเอียดคำสั่งและแนบไฟล์ PDF" : "กรอกรายละเอียดหนังสือราชการและแนบไฟล์ PDF";
  document.getElementById("docTitleLabel").textContent = labels.title;
  document.getElementById("docTitle").placeholder = order ? "เช่น แต่งตั้งคณะกรรมการตรวจรับพัสดุ" : "เช่น ขอเชิญประชุมคณะกรรมการ";
  document.getElementById("docNumberLabel").textContent = labels.docNumber;
  document.getElementById("docNumber").placeholder = order ? "เช่น 123/2569" : "เช่น ศธ 0001/2569";
  document.getElementById("docDateLabel").textContent = labels.date;
  document.getElementById("docAgencyLabel").textContent = order ? labels.agency : documentAgencyLabel(category.value);
  document.getElementById("docAgency").placeholder = order ? "เช่น นายก อบต." : "เช่น กรมการปกครอง";
  document.getElementById("docDescription").placeholder = `รายละเอียดเพิ่มเติมของ${order ? "คำสั่ง" : "เอกสาร"}`;
  // คำสั่งไม่มีชั้นความเร็ว แต่มีตัวเลือกปี พ.ศ. ไว้ลงคำสั่งย้อนหลัง และกล่องค้นหาคำสั่งที่บันทึกไว้แล้ว
  document.getElementById("docUrgencyField").hidden = order;
  document.getElementById("docYear").hidden = !order;
  document.getElementById("orderLookup").hidden = !order;
  if (order) renderOrderLookup();
  // ช่องเลขที่รับที่ซ่อนไว้ยังเก็บค่าที่พิมพ์ไว้ เลือกหนังสือรับกลับมาก่อนบันทึกจึงไม่ต้องพิมพ์ใหม่
  document.getElementById("docReceiveField").hidden = !isReceiveCategory(category.value);
  // เปลี่ยนรายการสถานะเฉพาะตอนสลับระหว่างเอกสารกับคำสั่ง ค่าที่มีในทั้งสองแบบ (ว่าง, รอดำเนินการ) คงไว้
  const status = document.getElementById("docStatus");
  if (status.dataset.mode !== (order ? "order" : "document")) {
    renderStatusOptions(order, (order ? ORDER_STATUSES : DOC_STATUSES).includes(status.value) ? status.value : "");
  }
  if (document.getElementById("docModalOverlay").getAttribute("aria-busy") !== "true") {
    document.getElementById("docSaveBtn").textContent = order ? "บันทึกคำสั่ง" : "บันทึกเอกสาร";
  }
}
document.getElementById("docCategory").addEventListener("change", syncOrderFields);

/* ลงคำสั่งย้อนหลัง: ช่องวันที่ของเบราว์เซอร์แสดงปีเป็น ค.ศ. จึงมีตัวเลือกปี พ.ศ. ต่อท้าย
   เลือกปีแล้ววันที่ย้ายไปปีนั้นโดยคงวันและเดือนเดิม ค่าที่บันทึกยังเป็นช่องวันที่ช่องเดียว */
const BE_OFFSET = 543;
const YEARS_BACK = 30;
function renderYearOptions() {
  const select = document.getElementById("docYear");
  const date = document.getElementById("docDate").value;
  const year = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Number(date.slice(0, 4)) : 0;
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: YEARS_BACK + 1 }, (_, i) => thisYear - i);
  // คำสั่งที่เก่ากว่าช่วงนี้ หรือปีที่พิมพ์เองในช่องวันที่ ก็ยังแสดงปีของมัน
  if (year && !years.includes(year)) years.push(year), years.sort((a, b) => b - a);
  select.innerHTML = (year ? "" : `<option value="">ปี พ.ศ.</option>`)
    + years.map((y) => `<option value="${y + BE_OFFSET}">พ.ศ. ${y + BE_OFFSET}</option>`).join("");
  select.value = year ? String(year + BE_OFFSET) : "";
}
document.getElementById("docDate").addEventListener("change", renderYearOptions);
document.getElementById("docYear").addEventListener("change", (e) => {
  const year = Number(e.target.value) - BE_OFFSET;
  if (!(year > 0)) return;
  const input = document.getElementById("docDate");
  const current = /^\d{4}-\d{2}-\d{2}$/.test(input.value) ? input.value : localIsoDate();
  const [, month, day] = current.split("-").map(Number);
  // 29 ก.พ. ย้ายไปปีที่ไม่มีวันนั้น ใช้วันสุดท้ายของเดือนแทน
  const lastDay = new Date(year, month, 0).getDate();
  input.value = [String(year).padStart(4, "0"), String(month).padStart(2, "0"), String(Math.min(day, lastDay)).padStart(2, "0")].join("-");
  renderYearOptions();
});

/* ปี พ.ศ. ของวันที่แบบ YYYY-MM-DD ไม่มีวันที่คืน 0 */
function buddhistYear(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso || "") ? Number(iso.slice(0, 4)) + BE_OFFSET : 0;
}
/* ฟอร์มคำสั่ง: ค้นหาคำสั่งที่บันทึกไว้แล้ว เลือกปี พ.ศ. ได้ (นับตามวันที่ออกคำสั่ง)
   ไว้ดูก่อนบันทึกว่าเคยลงคำสั่งนี้แล้วหรือยัง และเลขที่ล่าสุดของปีนั้นถึงไหน */
function renderOrderLookup() {
  const yearSelect = document.getElementById("orderSearchYear");
  const note = document.getElementById("orderSearchNote");
  const results = document.getElementById("orderSearchResults");
  const orders = allDocuments.filter((d) => isOrderCategory(d.category));
  // ปีชุดเดียวกับตัวเลือกข้างช่องวันที่ บวกปีของคำสั่งที่เก่ากว่านั้น
  const thisYear = new Date().getFullYear() + BE_OFFSET;
  const years = new Set(Array.from({ length: YEARS_BACK + 1 }, (_, i) => thisYear - i));
  orders.forEach((d) => { if (buddhistYear(d.date)) years.add(buddhistYear(d.date)); });
  const chosen = Number(yearSelect.value);
  yearSelect.innerHTML = `<option value="">ทุกปี</option>`
    + [...years].sort((a, b) => b - a).map((y) => `<option value="${y}">พ.ศ. ${y}</option>`).join("");
  const year = years.has(chosen) ? chosen : 0;
  yearSelect.value = year ? String(year) : "";

  const q = document.getElementById("orderSearch").value.trim().toLowerCase();
  if (!q && !year) {
    results.hidden = true;
    results.innerHTML = "";
    note.textContent = orders.length
      ? `มีคำสั่งที่บันทึกไว้แล้ว ${orders.length} รายการ พิมพ์คำค้นหรือเลือกปี พ.ศ. เพื่อดูรายการ`
      : "ยังไม่มีคำสั่งที่บันทึกไว้";
    return;
  }
  // วันที่ออกคำสั่งล่าสุดอยู่บน วันเดียวกันเรียงเลขที่จากมากไปน้อย
  const hits = orders.filter((d) => matchesSearch(d, q) && (!year || buddhistYear(d.date) === year))
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))
      || String(b.docNumber || "").localeCompare(String(a.docNumber || ""), "th", { numeric: true })
      || byEntry(b, a));
  const inYear = year ? `ในปี พ.ศ. ${year}` : "";
  note.textContent = hits.length ? `พบ ${hits.length} คำสั่ง${inYear}` : `ไม่พบคำสั่งที่ตรงกัน${inYear}`;
  results.hidden = !hits.length;
  results.innerHTML = hits.map((d) => {
    const details = [d.agency, Object.hasOwn(STATUS_LABEL, d.status) ? STATUS_LABEL[d.status] : ""].filter(Boolean).join(" · ");
    return `
    <li class="order-hit">
      <span class="order-hit-number mono">${escapeHtml(d.docNumber || "-")}</span>
      <span class="order-hit-main">
        <span class="order-hit-title">${escapeHtml(d.title || "-")}</span>
        ${details ? `<span class="order-hit-sub">${escapeHtml(details)}</span>` : ""}
      </span>
      <span class="order-hit-date mono">${formatDate(d.date)}</span>
    </li>`;
  }).join("");
}
document.getElementById("orderSearch").addEventListener("input", renderOrderLookup);
document.getElementById("orderSearchYear").addEventListener("change", renderOrderLookup);
document.getElementById("orderSearch").addEventListener("keydown", (e) => {
  // Enter ในช่องค้นหาจะส่งฟอร์ม (กลายเป็นบันทึกคำสั่ง) และ Esc จะปิดหน้าต่างทิ้งข้อมูลที่กรอกไว้
  // จึงกัน Enter ไว้ และให้ Esc ล้างคำค้นก่อน
  if (e.key === "Enter") e.preventDefault();
  if (e.key === "Escape" && e.target.value) {
    e.preventDefault();
    e.stopPropagation();
    e.target.value = "";
    renderOrderLookup();
  }
});

function renderCategoryOptions() {
  const docSelect = document.getElementById("docCategory");
  const filterSelect = document.getElementById("filterCategory");
  const selected = docSelect.value, filtered = filterSelect.value;
  const opts = allCategories.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join("");
  docSelect.innerHTML = `<option value="">ไม่ระบุหมวดหมู่</option>${opts}`;
  filterSelect.innerHTML = `<option value="">หมวดหมู่ทั้งหมด</option>${opts}`;
  docSelect.value = allCategories.some((c) => c.id === selected) ? selected : "";
  filterSelect.value = allCategories.some((c) => c.id === filtered) ? filtered : "";
  // ชื่อหมวดหมู่อาจเปลี่ยนระหว่างที่ฟอร์มเปิดอยู่ (เช่น หนังสือคำสั่ง → คำสั่ง)
  syncOrderFields();
}
function renderCategories() {
  const grid = document.getElementById("categoryGrid");
  if (!allCategories.length) {
    grid.innerHTML = `
      <div class="empty-state cat-empty">
        <span class="empty-art"><svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg></span>
        <p>ยังไม่มีหมวดหมู่</p>
        <span class="doc-sub">กดปุ่ม “เพิ่มหมวดหมู่” เพื่อเริ่มจัดกลุ่มเอกสาร</span>
      </div>`;
    return;
  }
  const max = Math.max(1, ...allCategories.map((c) => allDocuments.filter((d) => d.category === c.id).length));
  grid.innerHTML = allCategories.map((c) => {
    const count = allDocuments.filter((d) => d.category === c.id).length;
    const share = allDocuments.length ? Math.round((count / allDocuments.length) * 100) : 0;
    // หมวดหมู่หลักลบไม่ได้: ensureDefaultCategories จะสร้างกลับมาเป็น id ใหม่ เอกสารเดิมจึงหลุดหมวดหมู่
    const deleteAttrs = isDefaultCategory(c.name)
      ? `disabled title="หมวดหมู่หลักของระบบ ลบไม่ได้" aria-label="หมวดหมู่หลักของระบบ ${escapeHtml(c.name)} ลบไม่ได้"`
      : `data-del-cat="${escapeHtml(c.id)}" title="ลบหมวดหมู่" aria-label="ลบหมวดหมู่ ${escapeHtml(c.name)}"`;
    return `
      <div class="category-card" data-open-cat="${escapeHtml(c.id)}">
        <span class="cat-back" aria-hidden="true"></span>
        <span class="cat-paper" aria-hidden="true"></span>
        <span class="cat-paper cat-paper-front" aria-hidden="true"></span>
        <div class="cat-front">
          <div class="cat-top">
            <span class="cat-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6V3zM14 3v5h4M9 12h6M9 16h4"/></svg></span>
            <span class="stat-chip mono" title="สัดส่วนของเอกสารทั้งหมด">${share}%</span>
          </div>
          <button type="button" class="cat-name" aria-label="ดูเอกสารในหมวดหมู่ ${escapeHtml(c.name)}">${escapeHtml(c.name)}</button>
          <span class="cat-count">${count} เอกสาร</span>
          <div class="meter" aria-hidden="true"><span style="width:${(count / max) * 100}%"></span></div>
          <div class="cat-actions">
            <button class="icon-btn" ${deleteAttrs}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg>
            </button>
          </div>
        </div>
      </div>`;
  }).join("");
  grid.querySelectorAll("[data-del-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      askConfirm("ลบหมวดหมู่นี้? เอกสารที่เกี่ยวข้องจะไม่ถูกลบ แต่จะไม่มีหมวดหมู่", async () => {
        try {
          await db.collection("categories").doc(btn.dataset.delCat).delete();
          showToast("ลบหมวดหมู่แล้ว", "success");
        } catch (err) { showToast(friendlyError(err), "error"); }
      });
    });
  });
  // กดตรงไหนของแฟ้มก็เปิดดูเอกสารในหมวดนั้น ยกเว้นปุ่มลบ (ชื่อหมวดหมู่เป็นปุ่ม จึงเปิดจากคีย์บอร์ดได้ด้วย)
  grid.querySelectorAll("[data-open-cat]").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".cat-actions button")) return;
      resetDocFilters(card.dataset.openCat);
      switchView("documents");
    });
  });
}

document.getElementById("addCategoryBtn").addEventListener("click", () => {
  document.getElementById("categoryForm").reset();
  openModal("categoryModalOverlay");
});
document.getElementById("categoryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("categoryName").value.trim();
  if (document.getElementById("categoryModalOverlay").getAttribute("aria-busy") === "true") return;
  // ช่องว่างล้วนผ่าน required ของเบราว์เซอร์ได้ จึงต้องบอกเอง ไม่ใช่กดแล้วเงียบ
  if (!name) {
    showToast("กรุณากรอกชื่อหมวดหมู่", "error");
    return;
  }
  if (allCategories.some((c) => categoryKey(c.name) === categoryKey(name))) {
    showToast("มีหมวดหมู่นี้แล้ว กรุณาใช้ชื่ออื่น", "error");
    return;
  }
  setModalBusy("categoryModalOverlay", true);
  try {
    await db.collection("categories").add({ name, createdAt: Date.now() });
    showToast("เพิ่มหมวดหมู่แล้ว", "success");
    setModalBusy("categoryModalOverlay", false);
    closeModal("categoryModalOverlay");
  } catch (err) { showToast(friendlyError(err), "error"); }
  finally { setModalBusy("categoryModalOverlay", false); }
});

/* =========================================================
   PDF STORAGE API (Cloudflare Worker → R2)
   เอกสารใหม่: ไฟล์ PDF อยู่ใน R2, Firestore เก็บแค่ storageKey และรายละเอียด
   ทุกคำขอแนบ Firebase ID token ให้ Worker ตรวจก่อนเสมอ ไม่มี key/secret ของ R2 ในเว็บ
   ========================================================= */
class PdfApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
const PDF_API_MESSAGES = {
  "not-configured": "ยังไม่ได้ตั้งค่าระบบจัดเก็บไฟล์ PDF (PDF_API_URL) กรุณาติดต่อผู้ดูแลระบบ",
  network: "เชื่อมต่อระบบจัดเก็บไฟล์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่",
  unauthenticated: "ยืนยันตัวตนไม่สำเร็จ กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง",
  forbidden: "ไม่มีสิทธิ์ดำเนินการกับไฟล์นี้",
  "file-too-large": "ไฟล์มีขนาดเกิน 20 MB",
  "not-pdf": "ไฟล์นี้ไม่ใช่ PDF",
  "empty-file": "ไฟล์ว่างเปล่า",
  "document-not-found": "ไม่พบเอกสารนี้ในระบบ",
  "file-not-found": "ไม่พบไฟล์ PDF ของเอกสารนี้ในที่จัดเก็บ",
  "no-stored-file": "เอกสารนี้ไม่มีไฟล์ในที่จัดเก็บ",
  "not-in-trash": "ต้องย้ายเอกสารไปถังขยะก่อนลบถาวร",
  "file-in-use": "ไฟล์นี้ยังถูกใช้งานโดยเอกสารอื่น",
  "storage-error": "ที่จัดเก็บไฟล์ขัดข้อง กรุณาลองใหม่ภายหลัง",
  "firestore-unavailable": "ระบบจัดเก็บไฟล์ติดต่อฐานข้อมูลไม่ได้ กรุณาลองใหม่ภายหลัง",
};
function pdfApiError(status, code) {
  const key = status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : code;
  return new PdfApiError(PDF_API_MESSAGES[key] || `ระบบจัดเก็บไฟล์ขัดข้อง (รหัส ${status}) กรุณาลองใหม่`, key || `http-${status}`);
}
/* ข้อความภาษาไทยของรหัสข้อผิดพลาดจาก Firestore และ Firebase Auth ที่ผู้ใช้เจอได้จริง */
const FIREBASE_MESSAGES = {
  "permission-denied": "ไม่มีสิทธิ์บันทึกหรือแก้ไขข้อมูลเอกสาร",
  unavailable: "เชื่อมต่อฐานข้อมูลไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่",
  // แก้ไข/กู้คืนรายการที่มีคนลบถาวรไปแล้วระหว่างที่หน้านี้เปิดอยู่
  "not-found": "ไม่พบข้อมูลนี้แล้ว อาจถูกลบไปแล้ว",
  unauthenticated: PDF_API_MESSAGES.unauthenticated,
  "resource-exhausted": "มีการใช้งานฐานข้อมูลเกินโควตา กรุณาลองใหม่ภายหลัง",
  // ตอนเปิดหน้า: เน็ตกลับมาเมื่อไร listener "online" จะเชื่อมต่อใหม่ให้เอง
  "auth/network-request-failed": "อินเทอร์เน็ตขัดข้อง ระบบจะเชื่อมต่อใหม่เองเมื่อกลับมาออนไลน์",
  "auth/too-many-requests": "มีการเชื่อมต่อถี่เกินไป กรุณารอสักครู่แล้วโหลดหน้าใหม่",
  "auth/operation-not-allowed": "ระบบปิดการเข้าใช้งานอยู่ กรุณาติดต่อผู้ดูแลระบบ",
  "auth/admin-restricted-operation": "ระบบปิดการเข้าใช้งานอยู่ กรุณาติดต่อผู้ดูแลระบบ",
};
/* ข้อความภาษาไทยสำหรับข้อผิดพลาดทั้งจากระบบไฟล์และจาก Firestore */
function friendlyError(err) {
  if (err instanceof PdfApiError) return err.message;
  if (typeof err?.code === "string" && Object.hasOwn(FIREBASE_MESSAGES, err.code)) return FIREBASE_MESSAGES[err.code];
  return err?.message || String(err);
}

function pdfApiUrl(path) {
  const base = typeof PDF_API_URL === "string" ? PDF_API_URL.trim().replace(/\/+$/, "") : "";
  if (!base) throw new PdfApiError(PDF_API_MESSAGES["not-configured"], "not-configured");
  return base + path;
}
/* ผู้ใช้ที่ sign-in แบบ anonymous เสร็จแล้ว ถ้ายังไม่สำเร็จ (เช่น เน็ตหลุดตอนเปิดหน้า) แจ้งเป็นข้อความภาษาไทย */
async function signedInUser() {
  const user = (await databaseReady) && typeof auth !== "undefined" && auth ? auth.currentUser : null;
  if (!user) throw new PdfApiError(PDF_API_MESSAGES.unauthenticated, "unauthenticated");
  return user;
}
async function currentIdToken() {
  const user = await signedInUser();
  try { return await user.getIdToken(); }
  catch { throw new PdfApiError(PDF_API_MESSAGES.network, "network"); }
}
async function pdfApiFetch(path, init = {}) {
  const url = pdfApiUrl(path);
  const token = await currentIdToken();
  let res;
  try { res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } }); }
  catch { throw new PdfApiError(PDF_API_MESSAGES.network, "network"); }
  if (!res.ok) throw pdfApiError(res.status, (await res.json().catch(() => null))?.error);
  return res;
}
const documentFilePath = (docId) => `/api/documents/${encodeURIComponent(docId)}/file`;

/* ส่งไฟล์ไป R2 ผ่าน Worker (ใช้ XHR เพราะ fetch รายงานความคืบหน้าการอัปโหลดไม่ได้) → { storageKey, size } */
async function uploadPdf(file, onProgress) {
  const url = pdfApiUrl("/api/files");
  const token = await currentIdToken();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", PDF_MIME);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* ตอบกลับไม่ใช่ JSON */ }
      if (xhr.status === 201 && typeof body?.storageKey === "string") resolve(body);
      else reject(pdfApiError(xhr.status, body?.error));
    };
    xhr.onerror = () => reject(new PdfApiError(PDF_API_MESSAGES.network, "network"));
    xhr.send(file);
  });
}
async function fetchStoredPdf(doc) {
  const res = await pdfApiFetch(documentFilePath(doc.id));
  let blob;
  try { blob = await res.blob(); }
  catch { throw new PdfApiError(PDF_API_MESSAGES.network, "network"); }
  return blob.type === PDF_MIME ? blob : new Blob([blob], { type: PDF_MIME });
}
/* ลบไฟล์ของเอกสารในถังขยะ: Worker อ่าน storageKey จาก Firestore เอง เว็บส่งแค่ id เอกสาร */
function deleteStoredPdf(docId) {
  return pdfApiFetch(documentFilePath(docId), { method: "DELETE" });
}
/* ลบไฟล์ที่ไม่มีเอกสารใดอ้างถึงแล้ว (Worker ตรวจซ้ำก่อนลบ) */
function discardStoredPdf(storageKey) {
  return pdfApiFetch(`/api/files/${storageKey.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" });
}

function formatFileSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/* =========================================================
   DOCUMENT FILE HANDLING (เลือกไฟล์ PDF → ส่งไป R2 ตอนบันทึก)
   ========================================================= */
const fileDrop = document.getElementById("fileDrop");
const fileInput = document.getElementById("docFile");
const fileDropText = document.getElementById("fileDropText");

fileDrop.addEventListener("click", (e) => { if (e.target !== fileInput && !fileInput.disabled) fileInput.click(); });
fileDrop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (!fileInput.disabled) fileInput.click(); }
});
fileDrop.addEventListener("dragover", (e) => { e.preventDefault(); fileDrop.classList.add("has-file"); });
fileDrop.addEventListener("dragleave", () => { if (!pendingFileData) fileDrop.classList.remove("has-file"); });
fileDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

async function handleFile(file) {
  if (fileInput.disabled) return;
  const version = ++fileReadVersion;
  const errEl = document.getElementById("docFormError");
  const saveBtn = document.getElementById("docSaveBtn");
  pendingFileData = null;
  fileReading = false;
  fileInvalid = true;
  saveBtn.disabled = false;
  fileDrop.classList.remove("has-file");
  fileDropText.textContent = `เลือกไฟล์ PDF ใหม่ (สูงสุด ${formatFileSize(MAX_FILE_BYTES)})`;
  fileInput.value = "";
  errEl.hidden = true;
  // PDF ที่โหลดลงมือถือจากเว็บที่ไม่บอกชนิดไฟล์ มักได้ชนิดเป็น application/octet-stream
  // ชื่อลงท้าย .pdf จึงรับไว้ก่อน แล้วให้หัวไฟล์ %PDF- ด้านล่างเป็นตัวตัดสิน (Worker ตรวจซ้ำอีกชั้น)
  if (file.type !== PDF_MIME && !/\.pdf$/i.test(file.name)) {
    errEl.textContent = "รองรับเฉพาะไฟล์ PDF เท่านั้น";
    errEl.hidden = false;
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    errEl.textContent = `ไฟล์นี้มีขนาด ${formatFileSize(file.size)} เกินขนาดสูงสุด ${formatFileSize(MAX_FILE_BYTES)} กรุณาลดขนาดไฟล์ก่อนแนบ`;
    errEl.hidden = false;
    return;
  }
  fileReading = true;
  saveBtn.disabled = true;
  fileDropText.textContent = `กำลังอ่านไฟล์ ${file.name}…`;
  try {
    // อ่านแค่ 5 ไบต์แรกเพื่อยืนยันว่าเป็น PDF จริง ไม่ต้องโหลดทั้งไฟล์เข้าหน่วยความจำ
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (version !== fileReadVersion) return;
    if (String.fromCharCode(...head) !== "%PDF-") throw new Error("ไฟล์นี้ไม่ใช่ PDF ที่ถูกต้อง");
    pendingFileData = { file, name: file.name, size: file.size };
    fileInvalid = false;
    fileDrop.classList.add("has-file");
    fileDropText.textContent = `${file.name} (${formatFileSize(file.size)}) — คลิกเพื่อเปลี่ยนไฟล์`;
  } catch (err) {
    if (version !== fileReadVersion) return;
    errEl.textContent = "อ่านไฟล์ไม่สำเร็จ: " + err.message;
    errEl.hidden = false;
    fileDropText.textContent = "อ่านไฟล์ไม่สำเร็จ — คลิกเพื่อเลือกไฟล์ใหม่";
  } finally {
    if (version === fileReadVersion) { fileReading = false; saveBtn.disabled = false; }
  }
}
/* =========================================================
   DOCUMENT CRUD
   ========================================================= */
document.getElementById("addDocBtn").addEventListener("click", () => openDocModal());
document.querySelectorAll("[data-open='addDocBtn']").forEach((b) => b.addEventListener("click", () => openDocModal()));

/* ฟอร์มเดียวใช้ทั้งเอกสารและคำสั่ง ปุ่มเพิ่มคำสั่งในกล่องคำสั่ง ({ order: true }) และการแก้ไขรายการในหมวดคำสั่ง
   เปิดเป็นฟอร์มคำสั่งที่ล็อกหมวดหมู่ไว้ที่คำสั่ง ปุ่มเพิ่มในกล่องหมวด ({ categoryId }) เลือกหมวดนั้นไว้ให้ แต่ยังเปลี่ยนได้ */
function openDocModal(doc = null, { order = false, categoryId = "" } = {}) {
  fileReadVersion++;
  fileReading = false;
  fileInvalid = false;
  const category = document.getElementById("docCategory");
  const locked = doc ? isOrderCategory(doc.category) : order;
  // ตั้งก่อน setModalBusy ซึ่งเปิดใช้ทุกช่องยกเว้นช่องที่ล็อกไว้
  if (locked) category.dataset.locked = "";
  else delete category.dataset.locked;
  setModalBusy("docModalOverlay", false);
  document.getElementById("docForm").reset();
  // ช่องค้นหาคำสั่งเริ่มว่างทุกครั้งที่เปิดฟอร์ม
  document.getElementById("orderSearch").value = "";
  document.getElementById("orderSearchYear").value = "";
  document.getElementById("docFormError").hidden = true;
  fileInput.value = "";
  pendingFileData = null;
  fileDrop.classList.remove("has-file");
  fileDropText.textContent = `ลากไฟล์ PDF มาวาง หรือคลิกเพื่อเลือกไฟล์ (สูงสุด ${formatFileSize(MAX_FILE_BYTES)})`;

  if (doc) {
    document.getElementById("docId").value = doc.id;
    document.getElementById("docTitle").value = doc.title || "";
    document.getElementById("docNumber").value = doc.docNumber || "";
    document.getElementById("docReceiveNumber").value = doc.receiveNumber || "";
    document.getElementById("docDate").value = doc.date || "";
    document.getElementById("docAgency").value = doc.agency || "";
    category.value = allCategories.some((c) => c.id === doc.category) ? doc.category : "";
    document.getElementById("docUrgency").value = Object.hasOwn(URGENCY_LABEL, doc.urgency) ? doc.urgency : "";
    document.getElementById("docDescription").value = doc.description || "";
    if (doc.fileName) fileDropText.textContent = `ไฟล์ปัจจุบัน: ${doc.fileName} — คลิกเพื่อแทนที่`;
  } else {
    document.getElementById("docId").value = "";
    category.value = allCategories.some((c) => c.id === categoryId) ? categoryId : "";
    document.getElementById("docDate").value = localIsoDate();
  }
  renderYearOptions();
  // ฟอร์มที่ไม่ล็อกเปิดขึ้นมาเป็นเอกสารเสมอ จึงใช้ locked บอกชนิดของฟอร์มได้ รายการใหม่เริ่มแบบยังไม่ระบุสถานะ
  renderStatusOptions(locked, doc && Object.hasOwn(STATUS_LABEL, doc.status) ? doc.status : "");
  syncOrderFields();
  openModal("docModalOverlay");
}

document.getElementById("docForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (document.getElementById("docModalOverlay").getAttribute("aria-busy") === "true") return;
  const id = document.getElementById("docId").value;
  const errEl = document.getElementById("docFormError");
  errEl.hidden = true;
  if (fileReading || fileInvalid) {
    errEl.textContent = fileReading ? "กรุณารออ่านไฟล์ให้เสร็จ" : "กรุณาเลือกไฟล์ PDF ที่ถูกต้องก่อนบันทึก";
    errEl.hidden = false;
    return;
  }
  const order = docFormIsOrder();
  const category = document.getElementById("docCategory").value;
  // ถ้าหมวดคำสั่งยังโหลดไม่เสร็จ บันทึกไปจะกลายเป็นเอกสารไม่ระบุหมวดหมู่ ไม่ใช่คำสั่ง
  if (order && !category) {
    errEl.textContent = "ยังโหลดหมวดหมู่คำสั่งไม่เสร็จ กรุณารอสักครู่แล้วบันทึกอีกครั้ง";
    errEl.hidden = false;
    return;
  }
  const payload = {
    title: document.getElementById("docTitle").value.trim(),
    docNumber: document.getElementById("docNumber").value.trim(),
    date: document.getElementById("docDate").value,
    agency: document.getElementById("docAgency").value.trim(),
    category,
    status: document.getElementById("docStatus").value,
    description: document.getElementById("docDescription").value.trim(),
    deleted: false,
    updatedAt: Date.now(),
  };
  // ทุกช่องเป็นตัวเลือก — ไม่บังคับกรอกครบหรือแนบไฟล์ PDF (firestore.rules ต้องยอมรับแบบเดียวกัน)
  const upload = pendingFileData;
  const existing = id ? findDoc(id) : null;
  // เขียนชั้นความเร็วเฉพาะเมื่อเลือกไว้ หรือเมื่อต้องล้างค่าเดิมกลับเป็นปกติ
  // เอกสารปกติจึงยังบันทึกได้ แม้ firestore.rules บนเซิร์ฟเวอร์ยังเป็นรุ่นที่ไม่รู้จักช่องนี้
  // คำสั่งไม่มีชั้นความเร็ว จึงนับเป็นปกติ
  const urgency = order ? "" : document.getElementById("docUrgency").value;
  if (urgency || existing?.urgency) payload.urgency = urgency;
  // เลขที่รับก็เขียนแบบเดียวกัน: เฉพาะหนังสือรับที่กรอกไว้ หรือเมื่อต้องล้างค่าเดิม (เช่น ย้ายไปหมวดอื่น)
  const receiveNumber = isReceiveCategory(category) ? document.getElementById("docReceiveNumber").value.trim() : "";
  if (receiveNumber || existing?.receiveNumber) payload.receiveNumber = receiveNumber;

  const saveBtn = document.getElementById("docSaveBtn");
  setModalBusy("docModalOverlay", true);
  saveBtn.textContent = "กำลังบันทึก...";
  let stored = null;
  let saved = false;
  try {
    // 1) ส่งไฟล์ไป R2 ก่อน ถ้าไม่สำเร็จจะไม่มีการเขียน Firestore เลย
    if (upload) {
      saveBtn.textContent = "กำลังอัปโหลด 0%";
      stored = await uploadPdf(upload.file, (ratio) => {
        const percent = Math.round(ratio * 100);
        saveBtn.textContent = `กำลังอัปโหลด ${percent}%`;
        fileDropText.textContent = `กำลังอัปโหลด ${upload.name} — ${percent}%`;
      });
      payload.fileName = upload.name;
      payload.fileSize = stored.size;
      payload.mimeType = PDF_MIME;
      payload.storageKey = stored.storageKey;
      // เอกสารแบบเดิมที่ผู้ใช้เลือกแนบไฟล์ใหม่: เอา base64 เดิมออก ไฟล์ใหม่อยู่ใน R2 แทน
      if (existing && "fileData" in existing) payload.fileData = firebase.firestore.FieldValue.delete();
      saveBtn.textContent = "กำลังบันทึก...";
    }
    // 2) บันทึกรายละเอียดลง Firestore
    if (id) {
      await db.collection("documents").doc(id).update(payload);
    } else {
      payload.createdAt = Date.now();
      payload.createdAtMs = Date.now();
      payload.createdBy = (await signedInUser()).uid;
      await db.collection("documents").add(payload);
    }
    saved = true;
    const noun = order ? "คำสั่ง" : "เอกสาร";
    showToast(id ? `แก้ไข${noun}สำเร็จ` : `เพิ่ม${noun}สำเร็จ`, "success");
    // ไฟล์เดิมใน R2 ถูกแทนที่แล้ว ลบทิ้ง (ถ้าไม่สำเร็จ เอกสารยังถูกต้อง แค่มีไฟล์เก่าค้าง)
    if (stored && existing?.storageKey && existing.storageKey !== stored.storageKey) {
      discardStoredPdf(existing.storageKey).catch((err) => console.warn("ลบไฟล์ PDF เดิมใน R2 ไม่สำเร็จ:", existing.storageKey, err));
    }
    setModalBusy("docModalOverlay", false);
    closeModal("docModalOverlay");
  } catch (err) {
    // อัปโหลดสำเร็จแต่บันทึก Firestore ไม่สำเร็จ: ลบไฟล์ที่เพิ่งอัปโหลด ไม่ให้ค้างใน R2
    if (stored && !saved) {
      discardStoredPdf(stored.storageKey).catch((e) => console.warn("ลบไฟล์ที่อัปโหลดค้างไม่สำเร็จ:", stored.storageKey, e));
    }
    errEl.textContent = (upload && !stored ? "อัปโหลดไฟล์ไม่สำเร็จ: " : "บันทึกข้อมูลไม่สำเร็จ: ") + friendlyError(err);
    errEl.hidden = false;
    if (upload && !saved) fileDropText.textContent = `${upload.name} (${formatFileSize(upload.size)}) — กดบันทึกเพื่อลองใหม่`;
  } finally {
    setModalBusy("docModalOverlay", false);
    saveBtn.textContent = order ? "บันทึกคำสั่ง" : "บันทึกเอกสาร";
  }
});

function softDeleteDoc(id) {
  askConfirm("ย้ายเอกสารนี้ไปยังถังขยะ?", async () => {
    try {
      await db.collection("documents").doc(id).update({ deleted: true, deletedAt: Date.now() });
      showToast("ย้ายไปถังขยะแล้ว", "success");
    } catch (err) { showToast(friendlyError(err), "error"); }
  });
}
function restoreDoc(id) {
  db.collection("documents").doc(id).update({ deleted: false, deletedAt: null })
    .then(() => showToast("กู้คืนเอกสารแล้ว", "success"))
    .catch((err) => showToast(friendlyError(err), "error"));
}
function permanentlyDeleteDoc(id) {
  askConfirm("ลบเอกสารนี้ถาวร? ไม่สามารถกู้คืนได้", async () => {
    const hasStoredFile = Boolean(findDoc(id)?.storageKey);
    // 1) ลบไฟล์ใน R2 ก่อน ถ้าไม่สำเร็จ เอกสารยังอยู่ในถังขยะให้ลองใหม่ได้ (ไม่มีไฟล์กำพร้า)
    if (hasStoredFile) {
      try { await deleteStoredPdf(id); }
      catch (err) {
        showToast("ลบไฟล์ PDF ไม่สำเร็จ เอกสารยังอยู่ในถังขยะ: " + friendlyError(err), "error");
        return;
      }
    }
    // 2) ลบข้อมูลใน Firestore (ถ้าพลาด กดลบถาวรซ้ำได้ การลบไฟล์ที่ไม่มีแล้วถือว่าสำเร็จ)
    try {
      await db.collection("documents").doc(id).delete();
      showToast("ลบเอกสารถาวรแล้ว", "success");
    } catch (err) {
      showToast((hasStoredFile ? "ลบไฟล์แล้ว แต่ลบข้อมูลเอกสารไม่สำเร็จ กรุณากดลบถาวรอีกครั้ง: " : "") + friendlyError(err), "error");
    }
  });
}

/* ไฟล์ของเอกสาร: แบบใหม่ (มี storageKey) โหลดจาก R2 ผ่าน Worker
   แบบเดิม (fileData base64 ใน Firestore) ใช้วิธีเดิม และทำงานทันทีไม่ต้องรอเครือข่าย */
async function downloadDoc(doc) {
  let blob;
  try { blob = doc?.storageKey ? await fetchStoredPdf(doc) : attachmentBlob(doc); }
  catch (err) { showToast("ดาวน์โหลดไม่สำเร็จ: " + friendlyError(err), "error"); return; }
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = doc.fileName || `${doc.title || "เอกสาร"}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* =========================================================
   PDF VIEWER
   เดสก์ท็อป: ใช้ตัวแสดง PDF ของเบราว์เซอร์ใน iframe เหมือนเดิม (ซูม ค้นหา พิมพ์ได้)
   มือถือ: iOS Safari แสดง PDF ใน iframe ได้แค่หน้าแรกเป็นภาพนิ่ง และ Chrome บน Android ไม่มีตัวแสดง PDF ใน iframe
   จึงวาดทุกหน้าเองด้วย PDF.js เรียงต่อกันให้เลื่อนดูได้ครบ โดยวาดเฉพาะหน้าที่อยู่ใกล้จอ
   และคืนหน่วยความจำของหน้าที่เลื่อนผ่านไปแล้ว เอกสารหลายสิบหน้าจึงไม่ทำให้มือถือค้าง
   ========================================================= */
const PDFJS_BASE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/";
const PAGE_MAX_PIXELS = 4_000_000; // iOS ไม่ยอมวาด canvas ที่ใหญ่เกินไป จึงจำกัดความละเอียดต่อหน้า
let pdfjsLoading = null;
let pageViewer = null; // { loadingTask, tasks, observer } ของเอกสารที่เปิดอยู่

function needsPageViewer() {
  const ua = navigator.userAgent || "";
  // iPadOS แจ้งตัวเป็น Mac จึงดูจากจอสัมผัสร่วมด้วย
  const appleMobile = /iP(hone|ad|od)/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return appleMobile || /Android/i.test(ua) || navigator.pdfViewerEnabled === false;
}

function loadPdfJs() {
  if (!pdfjsLoading) {
    pdfjsLoading = import(PDFJS_BASE + "pdf.min.mjs").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + "pdf.worker.min.mjs";
      return lib;
    });
    pdfjsLoading.catch(() => { pdfjsLoading = null; }); // โหลดไม่สำเร็จ (เช่น เน็ตหลุด) ครั้งหน้าลองใหม่
  }
  return pdfjsLoading;
}

function closePageViewer() {
  if (!pageViewer) return;
  pageViewer.observer?.disconnect();
  pageViewer.tasks.forEach((task) => task.cancel());
  pageViewer.loadingTask.destroy();
  pageViewer = null;
  document.getElementById("previewPages").replaceChildren();
}

async function showPdfPages(blob, request) {
  closePageViewer();
  const container = document.getElementById("previewPages");
  const status = document.createElement("p");
  status.className = "preview-status";
  status.textContent = "กำลังเปิดเอกสาร…";
  container.replaceChildren(status);

  const lib = await loadPdfJs();
  const data = new Uint8Array(await blob.arrayBuffer());
  if (request !== previewRequest) return;
  const viewer = pageViewer = {
    loadingTask: lib.getDocument({ data, isEvalSupported: false }),
    tasks: new Map(),
    observer: null,
  };
  const pdf = await viewer.loadingTask.promise;
  const pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
  if (viewer !== pageViewer) return;

  const pageOf = new Map();
  const holders = pages.map((page, i) => {
    const { width, height } = page.getViewport({ scale: 1 });
    const holder = document.createElement("div");
    holder.className = "preview-page";
    holder.style.aspectRatio = `${width} / ${height}`;
    holder.dataset.label = `หน้า ${i + 1} / ${pages.length}`;
    pageOf.set(holder, page);
    return holder;
  });
  container.replaceChildren(...holders);

  const draw = async (holder) => {
    if (viewer.tasks.has(holder)) return;
    const page = pageOf.get(holder);
    const base = page.getViewport({ scale: 1 });
    // คมชัดตามความละเอียดจอ (ไม่เกิน 2 เท่า) และไม่เกิน PAGE_MAX_PIXELS ต่อหน้า
    let scale = ((holder.clientWidth || container.clientWidth) / base.width) * Math.min(window.devicePixelRatio || 1, 2);
    const pixels = base.width * base.height * scale * scale;
    if (pixels > PAGE_MAX_PIXELS) scale *= Math.sqrt(PAGE_MAX_PIXELS / pixels);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
    viewer.tasks.set(holder, task);
    try {
      await task.promise;
      if (viewer.tasks.get(holder) === task) holder.replaceChildren(canvas);
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") console.warn("วาดหน้า PDF ไม่สำเร็จ", err);
    }
  };
  const release = (holder) => {
    const task = viewer.tasks.get(holder);
    if (!task) return;
    viewer.tasks.delete(holder);
    task.cancel();
    const canvas = holder.querySelector("canvas");
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    holder.replaceChildren();
  };

  if (typeof IntersectionObserver === "undefined") { holders.forEach(draw); return; }
  // วาดหน้าที่อยู่ในจอและห่างออกไปไม่เกินหนึ่งจอ ขึ้นหรือลง
  viewer.observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => (entry.isIntersecting ? draw(entry.target) : release(entry.target)));
  }, { root: container, rootMargin: "100% 0px" });
  holders.forEach((holder) => viewer.observer.observe(holder));
}

/* PDF.js โหลดหรือเปิดไฟล์ไม่ได้ (เช่น iOS รุ่นเก่ามาก): กลับไปใช้ตัวแสดงของเบราว์เซอร์ อย่างน้อยยังเห็นเอกสาร */
function showPdfFallback(err) {
  console.warn("แสดง PDF แบบหลายหน้าไม่สำเร็จ ใช้ตัวแสดงของเบราว์เซอร์แทน", err);
  closePageViewer();
  document.getElementById("previewPages").hidden = true;
  const frame = document.getElementById("previewFrame");
  frame.hidden = false;
  frame.src = previewUrl;
  showToast("อุปกรณ์นี้อาจแสดงตัวอย่างได้ไม่ครบทุกหน้า กดดาวน์โหลดเพื่อดูเอกสารฉบับเต็ม", "info");
}

async function previewDoc(doc) {
  const request = ++previewRequest;
  let blob;
  try { blob = doc?.storageKey ? await fetchStoredPdf(doc) : attachmentBlob(doc); }
  catch (err) { showToast("เปิดเอกสารไม่สำเร็จ: " + friendlyError(err), "error"); return; }
  if (!blob || request !== previewRequest) return;
  // A selection in the host page can tint the entire embedded PDF viewer blue.
  // Clear only the host selection; the PDF document keeps its own text selection.
  window.getSelection()?.removeAllRanges();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  // หัวข้อนี้เป็นชื่อของหน้าต่างสำหรับโปรแกรมอ่านหน้าจอด้วย จึงห้ามว่างเมื่อเอกสารไม่มีชื่อ
  document.getElementById("previewTitle").textContent = doc.title || doc.fileName || "ดูตัวอย่างเอกสาร";
  const frame = document.getElementById("previewFrame");
  const pageMode = needsPageViewer();
  frame.hidden = pageMode;
  document.getElementById("previewPages").hidden = !pageMode;
  if (pageMode) {
    frame.removeAttribute("src");
    showPdfPages(blob, request).catch((err) => { if (request === previewRequest) showPdfFallback(err); });
  } else {
    frame.src = previewUrl;
  }
  openModal("previewModalOverlay");
}

/* =========================================================
   DOCUMENTS VIEW: search and filter, then one box per category,
   each with its own table, sort order and pages
   ========================================================= */
document.getElementById("globalSearch").addEventListener("input", () => {
  if (!document.getElementById("view-documents").classList.contains("is-active")) switchView("documents");
  resetGroupPages();
  renderDocsTable();
});
document.getElementById("filterCategory").addEventListener("change", () => { resetGroupPages(); renderDocsTable(); });
document.getElementById("filterStatus").addEventListener("change", () => { resetGroupPages(); renderDocsTable(); });
document.getElementById("filterDate").addEventListener("change", () => { resetGroupPages(); renderDocsTable(); });
/* ล้างตัวกรองทั้งหมด หรือเหลือไว้แค่หมวดหมู่เดียวตอนเปิดแฟ้ม (ตารางจึงมีเอกสารครบตามจำนวนบนแฟ้ม) */
function resetDocFilters(category = "") {
  document.getElementById("globalSearch").value = "";
  document.getElementById("filterCategory").value = category;
  document.getElementById("filterStatus").value = "";
  document.getElementById("filterDate").value = "";
  resetGroupPages();
  renderDocsTable();
}
document.getElementById("clearFilters").addEventListener("click", () => resetDocFilters());

/* คำค้น (พิมพ์เล็กแล้ว) ตรงกับชื่อ เลขที่ เลขที่รับ หน่วยงาน หมวดหมู่ หรือชั้นความเร็ว
   ใช้ทั้งช่องค้นหาด้านบนและช่องค้นหาในฟอร์มคำสั่ง */
function matchesSearch(d, q) {
  return !q || [d.title, d.docNumber, d.receiveNumber, d.agency, categoryName(d.category), URGENCY_LABEL[d.urgency]]
    .some((f) => String(f ?? "").toLowerCase().includes(q));
}
function getFilteredDocs() {
  const q = document.getElementById("globalSearch").value.trim().toLowerCase();
  const catFilter = document.getElementById("filterCategory").value;
  const statusFilter = document.getElementById("filterStatus").value;
  const dateFilter = document.getElementById("filterDate").value;

  return allDocuments.filter((d) => {
    const matchesQuery = matchesSearch(d, q);
    const matchesCat = !catFilter || d.category === catFilter;
    const matchesStatus = !statusFilter
      || (statusFilter === "none" ? !Object.hasOwn(STATUS_LABEL, d.status) : d.status === statusFilter);
    const matchesDate = !dateFilter || d.date === dateFilter;
    return matchesQuery && matchesCat && matchesStatus && matchesDate;
  });
}

/* กล่องหมวดเรียงตามงานสารบรรณ หมวดที่สร้างเพิ่มต่อท้ายตามชื่อ และไม่ระบุหมวดหมู่อยู่ท้ายสุด */
const CATEGORY_ORDER = ["หนังสือรับ", "หนังสือส่ง", "หนังสือเวียน", "คำสั่ง", "บันทึกข้อความ", "คำร้อง"];
function categoryRank(name) {
  const rank = CATEGORY_ORDER.findIndex((n) => categoryKey(n) === categoryKey(name));
  return rank === -1 ? CATEGORY_ORDER.length : rank;
}
/* แต่ละกล่องเรียงและแบ่งหน้าของตัวเอง (คีย์คือ id หมวด, "" คือไม่ระบุหมวดหมู่)
   เริ่มที่ลำดับการบันทึก ฉบับที่เพิ่งบันทึกอยู่บนสุด */
const groupViews = new Map();
function groupView(id) {
  if (!groupViews.has(id)) groupViews.set(id, { sortKey: "entry", sortDir: "desc", page: 1 });
  return groupViews.get(id);
}
function resetGroupPages() { groupViews.forEach((view) => { view.page = 1; }); }

function sortDocs(list, { sortKey, sortDir }) {
  const dir = sortDir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    if (sortKey !== "entry") {
      let av = a[sortKey] ?? "", bv = b[sortKey] ?? "";
      if (sortKey === "size") { av = a.fileSize || 0; bv = b.fileSize || 0; }
      const order = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv, "th", { numeric: true }) : (av > bv) - (av < bv);
      if (order) return order * dir;
    }
    // ค่าเริ่มต้น และแถวที่ค่าเท่ากัน (เช่น ออกเอกสารวันเดียวกัน) เรียงตามลำดับที่บันทึก
    return byEntry(a, b) * dir;
  });
}

/* คอลัมน์ของกล่องหมวด ไม่มีคอลัมน์หมวดหมู่เพราะหัวกล่องบอกอยู่แล้ว
   กล่องคำสั่งเรียกหัวคอลัมน์แบบคำสั่ง หมวดที่มีชื่อช่องหน่วยงานของตัวเอง (AGENCY_LABELS) ใช้ชื่อเดียวกับในฟอร์ม
   และกล่องหนังสือรับมีเลขที่รับเป็นคอลัมน์แรก เหมือนสมุดทะเบียนรับ */
function groupColumns(id) {
  const order = isOrderCategory(id);
  const labels = FIELD_LABELS[order ? "order" : "document"];
  return [
    ...(isReceiveCategory(id) ? [["receiveNumber", "เลขที่รับ"]] : []),
    ["docNumber", labels.docNumber], ["title", labels.title],
    ["agency", order ? labels.agency : documentAgencyLabel(id)],
    ["date", labels.date], ["size", "ขนาดไฟล์"], ["status", "สถานะ"],
  ];
}
function docRow(d, receive) {
  // เอกสารที่บันทึกโดยไม่แนบ PDF ไม่มีอะไรให้ดูหรือดาวน์โหลด ปิดปุ่มไว้แทนการกดแล้วแจ้งว่าไฟล์เสีย
  const fileButton = (label) => hasAttachment(d) ? `title="${label}"` : `title="${label} (ไม่มีไฟล์ PDF)" disabled`;
  return `
    <tr>
      ${receive ? `<td class="mono">${escapeHtml(d.receiveNumber || "-")}</td>` : ""}
      <td class="mono">${escapeHtml(d.docNumber || "-")}</td>
      <td class="doc-title-cell">${docTitle(d)}</td>
      <td>${escapeHtml(d.agency || "-")}</td>
      <td class="mono">${formatDate(d.date)}</td>
      <td class="mono">${d.fileSize ? formatFileSize(d.fileSize) : "-"}</td>
      <td>${statusStamp(d.status)}</td>
      <td class="col-actions">
        <div class="row-actions">
          <button class="icon-btn" data-preview="${escapeHtml(d.id)}" ${fileButton("ดูตัวอย่าง")}><svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg></button>
          <button class="icon-btn" data-download="${escapeHtml(d.id)}" ${fileButton("ดาวน์โหลด")}><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg></button>
          <button class="icon-btn" data-edit="${escapeHtml(d.id)}" title="แก้ไข"><svg viewBox="0 0 24 24"><path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg></button>
          <button class="icon-btn" data-delete="${escapeHtml(d.id)}" title="ลบ"><svg viewBox="0 0 24 24"><path d="M6 7h12l-1 13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7z"/></svg></button>
        </div>
      </td>
    </tr>`;
}
/* กล่องของหมวดเดียว: หัวกล่อง (ชื่อ จำนวน ปุ่มเพิ่ม) ตาราง และหน้า หมวดที่ยังไม่มีเอกสารเหลือแค่หัวกล่อง */
function renderDocGroup(group, docs, index, narrowed) {
  const view = groupView(group.id);
  const columns = groupColumns(group.id);
  // หมวดที่เปลี่ยนชื่อจนคอลัมน์ที่กำลังเรียงอยู่หายไป (เช่น เลขที่รับ) กลับไปเรียงตามลำดับการบันทึก
  if (view.sortKey !== "entry" && !columns.some(([key]) => key === view.sortKey)) Object.assign(view, { sortKey: "entry", sortDir: "desc" });
  const totalPages = Math.max(1, Math.ceil(docs.length / PAGE_SIZE));
  view.page = Math.min(Math.max(1, view.page), totalPages);
  const rows = sortDocs(docs, view).slice((view.page - 1) * PAGE_SIZE, view.page * PAGE_SIZE);
  const heads = columns.map(([key, label]) => {
    const dir = view.sortKey === key ? view.sortDir : "";
    const sorted = dir ? ` class="is-sorted-${dir}" aria-sort="${dir === "asc" ? "ascending" : "descending"}"` : ` aria-sort="none"`;
    return `<th data-sort="${key}" tabindex="0"${sorted}>${escapeHtml(label)}</th>`;
  }).join("");
  const name = escapeHtml(group.name);
  const add = group.id
    ? `<button class="btn btn-ghost btn-sm" data-add-to="${escapeHtml(group.id)}" title="เพิ่ม${name}"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>เพิ่ม${name}</span></button>`
    : "";
  let body = "";
  if (docs.length) {
    body = `
      <div class="table-scroll">
        <table class="doc-table">
          <thead><tr>${heads}<th class="col-actions">การดำเนินการ</th></tr></thead>
          <tbody>${rows.map((d) => docRow(d, columns[0][0] === "receiveNumber")).join("")}</tbody>
        </table>
      </div>
      ${totalPages > 1 ? `<nav class="pagination" aria-label="หน้าของ${name}">${paginationHtml(view.page, totalPages)}</nav>` : ""}`;
  } else if (narrowed) {
    body = `<p class="doc-group-empty">ไม่พบเอกสารที่ตรงกับตัวกรองในหมวดนี้</p>`;
  }
  return `
    <section class="panel panel-flush doc-group" data-group="${escapeHtml(group.id)}" aria-labelledby="docGroupTitle${index}">
      <div class="doc-group-head">
        <div class="doc-group-name">
          <span class="doc-group-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg></span>
          <h3 id="docGroupTitle${index}">${name}</h3>
        </div>
        <span class="panel-tag">${docs.length || narrowed ? `${docs.length} รายการ` : "ยังไม่มีเอกสาร"}</span>
        ${add}
      </div>${body}
    </section>`;
}
function renderDocsTable() {
  const list = getFilteredDocs();
  const filterCategory = document.getElementById("filterCategory").value;
  // ค้นหา หรือกรองสถานะ/วันที่อยู่ แสดงเฉพาะหมวดที่มีเอกสารตรงกัน ไม่งั้นแสดงทุกหมวด แม้หมวดที่ยังไม่มีเอกสาร
  const narrowed = Boolean(document.getElementById("globalSearch").value.trim()
    || document.getElementById("filterStatus").value || document.getElementById("filterDate").value);
  // เอกสารของหมวดที่ถูกลบไปแล้วอยู่ในกล่องไม่ระบุหมวดหมู่ เหมือนที่ฟอร์มแก้ไขแสดง
  const known = new Set(allCategories.map((c) => c.id));
  const byGroup = new Map();
  list.forEach((d) => {
    const id = known.has(d.category) ? d.category : "";
    if (!byGroup.has(id)) byGroup.set(id, []);
    byGroup.get(id).push(d);
  });
  const groups = [...allCategories].sort((a, b) => categoryRank(a.name) - categoryRank(b.name))
    .map((c) => ({ id: c.id, name: c.name }))
    .concat({ id: "", name: "ไม่ระบุหมวดหมู่" })
    .filter((g) => (filterCategory ? g.id === filterCategory : byGroup.has(g.id) || (g.id !== "" && !narrowed)));

  const hasDocuments = allDocuments.length > 0;
  document.getElementById("resultCount").textContent =
    hasDocuments ? `พบ ${list.length} จาก ${allDocuments.length} รายการ` : "";
  document.getElementById("docsEmpty").hidden = groups.length > 0;
  document.getElementById("docsEmptyMessage").textContent = hasDocuments ? "ไม่พบเอกสารที่ตรงกับตัวกรอง" : "ยังไม่มีเอกสารในระบบ";
  document.getElementById("docsEmptyAddBtn").hidden = hasDocuments;

  const container = document.getElementById("docGroups");
  const focused = focusedGroupControl(container);
  container.innerHTML = groups.map((g, i) => renderDocGroup(g, byGroup.get(g.id) || [], i, narrowed)).join("");
  bindRowActions(container);
  restoreGroupControl(container, focused);
}

/* กล่องถูกสร้างใหม่ทุกครั้งที่ข้อมูล การเรียง หรือหน้าเปลี่ยน จึงจำปุ่มที่โฟกัสอยู่ แล้วโฟกัสปุ่มเดียวกันในกล่องใหม่
   คนที่ใช้คีย์บอร์ดกดเรียงหรือเปลี่ยนหน้าแล้วจะไม่หลุดกลับไปต้นหน้า */
const GROUP_CONTROLS = ["data-sort", "data-add-to", "data-view-file", "data-preview", "data-download", "data-edit", "data-delete"];
function focusedGroupControl(container) {
  const el = document.activeElement;
  const group = el?.closest?.("[data-group]");
  if (!group || !container.contains(group)) return null;
  // ปุ่มเปลี่ยนหน้าเปลี่ยนเลขหน้าในตัวทุกครั้ง จึงจำจากชื่อปุ่ม (หน้าก่อนหน้า หน้าถัดไป หน้า 3)
  const attr = el.closest(".pagination") ? "aria-label" : GROUP_CONTROLS.find((name) => el.hasAttribute(name));
  return attr ? { group: group.dataset.group, attr, value: el.getAttribute(attr) } : null;
}
function restoreGroupControl(container, saved) {
  const group = saved && [...container.querySelectorAll("[data-group]")].find((g) => g.dataset.group === saved.group);
  if (!group) return;
  const pager = saved.attr === "aria-label";
  let target = [...group.querySelectorAll(pager ? ".pagination button" : `[${saved.attr}]`)]
    .find((el) => el.getAttribute(saved.attr) === saved.value);
  // ถึงหน้าสุดท้ายแล้ว ปุ่มหน้าถัดไปถูกปิด จึงโฟกัสเลขหน้าปัจจุบันแทน
  if (pager && (!target || target.disabled)) target = group.querySelector('.pagination [aria-current="page"]');
  target?.focus({ preventScroll: true });
}

function sortGroup(id, key) {
  const view = groupView(id);
  if (view.sortKey === key) view.sortDir = view.sortDir === "asc" ? "desc" : "asc";
  else Object.assign(view, { sortKey: key, sortDir: "asc" });
  view.page = 1;
  renderDocsTable();
}
function showGroupPage(id, page) {
  groupView(id).page = page;
  renderDocsTable();
}
/* ปุ่มเพิ่มในกล่องหมวด เปิดฟอร์มที่เลือกหมวดนั้นไว้ให้ ส่วนกล่องคำสั่งเปิดฟอร์มคำสั่ง */
function addToCategory(id) {
  openDocModal(null, isOrderCategory(id) ? { order: true } : { categoryId: id });
}
/* ฟังคลิกที่กล่องนอกสุดที่เดียว เพราะหัวคอลัมน์ ปุ่มเปลี่ยนหน้า และปุ่มเพิ่ม ถูกสร้างใหม่ทุกครั้ง */
document.getElementById("docGroups").addEventListener("click", (e) => {
  const group = e.target.closest("[data-group]");
  if (!group) return;
  const sort = e.target.closest("th[data-sort]");
  const page = e.target.closest("[data-page]");
  const add = e.target.closest("[data-add-to]");
  if (sort) sortGroup(group.dataset.group, sort.dataset.sort);
  else if (page) showGroupPage(group.dataset.group, Number(page.dataset.page));
  else if (add) addToCategory(add.dataset.addTo);
});
document.getElementById("docGroups").addEventListener("keydown", (e) => {
  const sort = e.target.closest("th[data-sort]");
  if (sort && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); sort.click(); }
});

function bindRowActions(scope) {
  scope.querySelectorAll("[data-preview]").forEach((b) => b.addEventListener("click", () => previewDoc(findDoc(b.dataset.preview))));
  scope.querySelectorAll("[data-view-file]").forEach((b) => b.addEventListener("click", () => previewDoc(findDoc(b.dataset.viewFile))));
  scope.querySelectorAll("[data-download]").forEach((b) => b.addEventListener("click", () => downloadDoc(findDoc(b.dataset.download))));
  scope.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openDocModal(findDoc(b.dataset.edit))));
  scope.querySelectorAll("[data-delete]").forEach((b) => b.addEventListener("click", () => softDeleteDoc(b.dataset.delete)));
}
function findDoc(id) { return allDocuments.find((d) => d.id === id) || allTrash.find((d) => d.id === id); }

function paginationHtml(page, totalPages) {
  let html = `<button data-page="${page - 1}" ${page === 1 ? "disabled" : ""} aria-label="หน้าก่อนหน้า">‹</button>`;
  const pages = [...new Set([1, totalPages, page - 1, page, page + 1])].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  let previous = 0;
  for (const i of pages) {
    if (i - previous > 1) html += `<span aria-hidden="true">…</span>`;
    html += `<button class="${i === page ? "is-active" : ""}" data-page="${i}" aria-label="หน้า ${i}" ${i === page ? 'aria-current="page"' : ""}>${i}</button>`;
    previous = i;
  }
  return html + `<button data-page="${page + 1}" ${page === totalPages ? "disabled" : ""} aria-label="หน้าถัดไป">›</button>`;
}

/* =========================================================
   TRASH VIEW
   ========================================================= */
function renderTrash() {
  const tbody = document.getElementById("trashTableBody");
  const emptyEl = document.getElementById("trashEmpty");
  emptyEl.hidden = allTrash.length !== 0;
  document.getElementById("trashTable").style.display = allTrash.length === 0 ? "none" : "table";
  renderTrashBadge();

  // ที่เพิ่งลบอยู่บนสุด (Firestore ส่งมาเรียงตาม id ซึ่งเท่ากับไม่เรียงเลย)
  const byDeletedAt = [...allTrash].sort((a, b) => (Number(b.deletedAt) || 0) - (Number(a.deletedAt) || 0));
  tbody.innerHTML = byDeletedAt.map((d) => `
    <tr>
      <td class="mono">${escapeHtml(d.docNumber || "-")}</td>
      <td class="doc-title-cell">${escapeHtml(d.title || "-")}</td>
      <td class="mono">${d.deletedAt ? new Date(d.deletedAt).toLocaleDateString("th-TH") : "-"}</td>
      <td class="col-actions">
        <div class="row-actions">
          <button class="icon-btn" data-restore="${escapeHtml(d.id)}" title="กู้คืน"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/></svg></button>
          <button class="icon-btn" data-purge="${escapeHtml(d.id)}" title="ลบถาวร"><svg viewBox="0 0 24 24"><path d="M6 7h12l-1 13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7z"/></svg></button>
        </div>
      </td>
    </tr>`).join("");

  tbody.querySelectorAll("[data-restore]").forEach((b) => b.addEventListener("click", () => restoreDoc(b.dataset.restore)));
  tbody.querySelectorAll("[data-purge]").forEach((b) => b.addEventListener("click", () => permanentlyDeleteDoc(b.dataset.purge)));
}

/* =========================================================
   HELPERS
   ========================================================= */
/* สถานะไม่บังคับเลือก เอกสารที่ไม่ระบุสถานะแสดงเป็นขีดเหมือนช่องว่างอื่นในตาราง */
function statusStamp(status) {
  if (!Object.hasOwn(STATUS_LABEL, status)) return "-";
  return `<span class="stamp stamp-${status}">${STATUS_LABEL[status]}</span>`;
}
/* ป้ายชั้นความเร็วหน้าชื่อเอกสาร เอกสารปกติไม่มีป้าย */
function urgencyBadge(urgency) {
  if (!Object.hasOwn(URGENCY_LABEL, urgency)) return "";
  return `<span class="urgency urgency-${urgency}">${URGENCY_LABEL[urgency]}</span>`;
}
/* ไอคอนไฟล์หน้าชื่อเอกสาร: แผ่น PDF สีแดง ฉบับที่ยังไม่แนบไฟล์เป็นแผ่นสีเทามีเส้นแทนตัวหนังสือ */
function fileIcon(hasFile) {
  const sheet = `<path class="sheet" d="M5.5 1H19l10 10v20a4 4 0 0 1-4 4H5.5a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4z"/><path class="fold" d="M19 1l10 10h-6a4 4 0 0 1-4-4V1z"/>`;
  return hasFile
    ? `<svg class="doc-ico is-pdf" viewBox="0 0 30 36" aria-hidden="true">${sheet}<text x="15.25" y="28.5" text-anchor="middle">PDF</text></svg>`
    : `<svg class="doc-ico is-none" viewBox="0 0 30 36" aria-hidden="true">${sheet}<path class="lines" d="M7.5 20h12M7.5 25.5h8"/></svg>`;
}
/* เอกสารมีไฟล์ให้เปิดดูไหม: ไฟล์ใน R2 (storageKey) หรือ PDF แบบเดิมที่เก็บเป็น base64 (fileData) */
function hasAttachment(d) {
  return Boolean(d?.storageKey || d?.fileData);
}
/* ชื่อเอกสารมีไอคอนไฟล์อยู่หน้า และบรรทัดเล็กใต้ชื่อเป็นหมายเหตุกับชื่อไฟล์ (ยาวเกินตัดด้วย … ชี้ค้างเห็นข้อความเต็ม)
   ฉบับที่แนบ PDF ทั้งไอคอนและชื่อเป็นปุ่มเปิดดูไฟล์ (ทำงานเหมือนปุ่มรูปตา) ฉบับที่ไม่มีไฟล์กดไม่ได้ */
function docTitle(d) {
  const hasFile = hasAttachment(d);
  const fileName = hasFile ? d.fileName : "";
  const sub = [d.description ? truncate(d.description, 60) : "", fileName].filter(Boolean).join(" · ");
  const full = [d.description ? truncate(d.description, 300) : "", fileName].filter(Boolean).join(" · ");
  const inner = `${fileIcon(hasFile)}<span class="doc-open-text"><span class="doc-open-title">${urgencyBadge(d.urgency)}${escapeHtml(d.title || "-")}</span>${sub ? `<span class="doc-sub" title="${escapeHtml(full)}">${escapeHtml(sub)}</span>` : ""}</span>`;
  return hasFile
    ? `<button class="doc-open" data-view-file="${escapeHtml(d.id)}">${inner}</button>`
    : `<div class="doc-open">${inner}</div>`;
}
/* วันที่ตามเวลาเครื่อง (YYYY-MM-DD) ไม่ใช่ตามเวลา UTC ที่อาจยังเป็นเมื่อวาน */
function localIsoDate(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function formatDate(iso) {
  if (!iso) return "-";
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso);
  if (isNaN(d)) return "-";
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}
function createdAtMillis(doc) {
  const value = doc.createdAtMs ?? doc.createdAt;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (Number.isFinite(value)) return value;
  if (Number.isFinite(value?.seconds)) return value.seconds * 1000;
  return 0;
}
/* ลำดับการบันทึก: ตามเวลาที่เพิ่มเข้าระบบ ไม่ใช่วันที่ออกเอกสาร เวลาเท่ากันใช้ id ตัดสินให้ลำดับไม่สลับไปมา */
function byEntry(a, b) {
  return createdAtMillis(a) - createdAtMillis(b) || String(a.id).localeCompare(String(b.id));
}
/* เอกสารแบบเดิมเท่านั้น: PDF เก็บเป็น base64 ในช่อง fileData ของ Firestore (ไม่มีการเขียนแบบนี้อีกแล้ว) */
function attachmentBlob(doc) {
  try {
    if (!doc?.fileData || !/^data:application\/pdf;base64,/i.test(doc.fileData)) throw new Error("ไม่พบไฟล์แนบ PDF ที่ถูกต้อง");
    const binary = atob(doc.fileData.slice(doc.fileData.indexOf(",") + 1));
    if (!binary.startsWith("%PDF-")) throw new Error("ไฟล์แนบ PDF เสียหาย");
    return new Blob([Uint8Array.from(binary, (c) => c.charCodeAt(0))], { type: "application/pdf" });
  } catch (err) { showToast(err.message, "error"); return null; }
}
function truncate(str, n) { str = String(str ?? ""); return str.length > n ? str.slice(0, n) + "…" : str; }
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
