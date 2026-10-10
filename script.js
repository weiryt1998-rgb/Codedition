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
// ชั้นความเร็วของหนังสือ — ค่าว่าง (หรือเอกสารเดิมที่ไม่มีช่องนี้) คือปกติ ต้องตรงกับ firestore.rules
const URGENCY_LABEL = { urgent: "ด่วน", "very-urgent": "ด่วนมาก", "most-urgent": "ด่วนที่สุด" };
// งานที่รับผิดชอบของเอกสาร เรียงตามที่แสดงในฟอร์ม — ค่าว่าง (หรือเอกสารเดิมที่ไม่มีช่องนี้) คือยังไม่ระบุงาน
// คำสั่งไม่มีช่องนี้ ต้องตรงกับตัวเลือกในฟอร์มและตัวกรองใน index.html และรายการใน firestore.rules
const SECTION_LABEL = {
  palat: "สำนักปลัด", finance: "กองคลัง", engineering: "กองช่าง", education: "กองการศึกษาฯ", health: "กองสาธารณสุขฯ",
  clerk: "จพง.ธุรการฯ", disaster: "จพง.ป้องกันฯ", "general-affairs": "นักจัดการงานทั่วไปฯ",
  "human-resources": "นักทรัพยากรบุคคลฯ", "policy-planning": "นักวิเคราะห์นโยบายและแผนฯ",
};
const SECTION_KEYS = Object.keys(SECTION_LABEL);
const NO_SECTION = "none"; // ค่าของตัวกรองและแถวในแดชบอร์ด: เอกสารที่ยังไม่ระบุงาน

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
  renderRecentList();
  renderCategoryBreakdown();
  renderSectionBreakdown();
  renderDocsTable();
  renderCategories();
  // คำสั่งที่เพิ่งเพิ่มหรือแก้ (รวมจากเครื่องอื่น) ขึ้นในผลค้นหาของฟอร์มคำสั่งที่เปิดอยู่ทันที
  if (!document.getElementById("docModalOverlay").hidden && !document.getElementById("orderLookup").hidden) renderOrderLookup();
}

/* =========================================================
   DASHBOARD: การ์ดสรุป กราฟรายเดือน เอกสารล่าสุด และแยกตามหมวดหมู่
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

const ARROW_ICON = {
  up: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>`,
  down: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 9v8H9"/></svg>`,
};
/* วันแรกของเดือน ห่างจากเดือนนี้ offset เดือน (ติดลบคือย้อนหลัง) ตามเวลาเครื่อง */
function monthStart(offset = 0, now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() + offset, 1);
}
/* จำนวนเอกสารที่เพิ่มเข้าระบบตั้งแต่ from ถึงก่อน until (มิลลิวินาที) */
function countAdded(from, until = Infinity) {
  return allDocuments.filter((d) => createdAtMillis(d) >= from && createdAtMillis(d) < until).length;
}
/* ร้อยละที่ไม่ปัดจนเข้าใจผิด: ยังขาดอยู่ฉบับเดียวก็ไม่ขึ้น 100% และมีอยู่ฉบับเดียวก็ไม่ขึ้น 0% */
function sharePercent(part, total) {
  if (!total || !part) return 0;
  if (part >= total) return 100;
  return Math.min(99, Math.max(1, Math.round((part / total) * 100)));
}

function renderStats() {
  const total = allDocuments.length;
  countTo(document.getElementById("statTotal"), total);
  document.getElementById("statTotalNote").textContent = `ใน ${allCategories.length} หมวดหมู่`;

  // เดือนนี้นับถึงวันนี้ เทียบกับวันเดียวกันของเดือนก่อน ไม่ใช่ทั้งเดือน ต้นเดือนจะได้ไม่ดูลดลงทุกครั้ง
  const now = new Date();
  const lastMonth = monthStart(-1, now);
  const lastDays = Math.min(now.getDate(), new Date(now.getFullYear(), now.getMonth(), 0).getDate());
  const added = countAdded(monthStart(0, now).getTime());
  const before = countAdded(lastMonth.getTime(), new Date(lastMonth.getFullYear(), lastMonth.getMonth(), lastDays + 1).getTime());
  countTo(document.getElementById("statMonth"), added);
  const since = `วันที่ ${lastDays === 1 ? "1" : `1–${lastDays}`} ${lastMonth.toLocaleDateString("th-TH", { month: "short" })}`;
  const diff = added - before;
  document.getElementById("statMonthNote").innerHTML = diff
    ? `<span class="delta">${ARROW_ICON[diff > 0 ? "up" : "down"]}${diff > 0 ? "+" : "−"}${Math.abs(diff)}</span><span>เทียบ${since}</span>`
    : `<span>เท่ากับ${since}</span>`;

  // ด่วน ด่วนมาก ด่วนที่สุด บนแถบเดียว สียิ่งเข้มยิ่งด่วน ตัวเลขของแต่ละชั้นอยู่ในคำอธิบายใต้แถบ
  const urgent = Object.keys(URGENCY_LABEL).map((level) => ({ level, count: allDocuments.filter((d) => d.urgency === level).length }));
  const urgentTotal = urgent.reduce((sum, u) => sum + u.count, 0);
  countTo(document.getElementById("statUrgent"), urgentTotal);
  document.getElementById("statUrgentNote").innerHTML = urgentTotal
    ? `<span class="urg-bar" role="img" aria-label="${urgent.map((u) => `${URGENCY_LABEL[u.level]} ${u.count} ฉบับ`).join(", ")}">${
      urgent.filter((u) => u.count).map((u) => `<i class="urg-key-${u.level}" style="flex-grow:${u.count}"></i>`).join("")}</span>
      <span class="urg-legend">${urgent.map((u) => `<span><i class="urg-key-${u.level}"></i>${URGENCY_LABEL[u.level]} <b class="mono">${u.count}</b></span>`).join("")}</span>`
    : `<span>ไม่มีเอกสารด่วน</span>`;

  const withFile = allDocuments.filter(hasAttachment).length;
  const filePercent = sharePercent(withFile, total);
  countTo(document.getElementById("statFiles"), filePercent);
  const meter = document.getElementById("meterFiles");
  meter.style.width = `${filePercent}%`;
  meter.classList.toggle("is-empty", filePercent === 0); // แถบว่างไม่ต้องมีแสงเรือง
  document.getElementById("statFilesNote").textContent = `${withFile} จาก ${total} ฉบับ`;

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
/* การ์ดเอกสารทั้งหมดเปิดรายการครบทุกฉบับ ตรงกับตัวเลขบนการ์ด จึงล้างตัวกรองที่ค้างไว้ก่อน */
document.getElementById("statTotalCard").addEventListener("click", () => {
  resetDocFilters();
  switchView("documents");
});

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
    ink: v("--text", dark ? "#F3EBFA" : "#30203F"),
    grid: v("--border", dark ? "#4B355E" : "#E4D6EF"),
    primary,
    primaryRgb,
    tooltipBg: dark ? v("--surface-2", "#2C1E3B") : v("--text", "#30203F"),
    tooltipText: dark ? v("--text", "#F3EBFA") : "#FFFFFF",
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
   3D CHART
   Chart.js ไม่มีกราฟ 3 มิติในตัว จึงวาดหน้าตาเองตามตำแหน่งที่ Chart.js คำนวณไว้
   เส้น = พื้นที่ทึบมีความหนา จุดข้อมูลเป็นทรงกลม และมีตัวเลขเหนือจุดที่เลือกไว้
   hover, tooltip และแอนิเมชันยังเป็นของ Chart.js ทั้งหมด
   ========================================================= */
const TAU = Math.PI * 2;
const DEPTH_SLOPE = 0.62; // ความลึกชี้ไปทางขวาบน: ขึ้น 0.62px ต่อการเลื่อนขวา 1px
const LINE_DEPTH = 10; // ระยะที่ผิวบนของเส้นยื่นไปทางขวา (px)

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
  const dx = LINE_DEPTH, dy = dx * DEPTH_SLOPE;
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

/* ตัวเลขเหนือจุดของเดือนที่เลือกไว้ (opts.labels เป็นลำดับเดือน) ยกขึ้นพ้นผิวบนของเส้นที่ยื่นไปทางขวาบน */
function drawPointLabels(chart, meta, opts) {
  const { ctx } = chart;
  const values = chart.data.datasets[meta.index].data;
  ctx.font = `600 12.5px ${Chart.defaults.font.family}`;
  ctx.fillStyle = opts.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  (opts.labels || []).forEach((i) => {
    const p = meta.data[i];
    if (!p || p.skip) return;
    ctx.fillText(String(values[i]), p.x + LINE_DEPTH / 2, p.y - LINE_DEPTH * DEPTH_SLOPE - p.options.radius - 3);
  });
}

const chart3d = {
  id: "chart3d",
  beforeDatasetDraw(chart, { meta }) {
    if (chart.config.type !== "line") return;
    chart.ctx.save();
    drawLineDepth(chart, meta);
    chart.ctx.restore();
  },
  afterDatasetDraw(chart, { meta }, opts) {
    if (chart.config.type !== "line") return;
    chart.ctx.save();
    drawLineSpheres(chart, meta);
    drawPointLabels(chart, meta, opts);
    chart.ctx.restore();
  },
};

const MONTH_LABEL_SPACE = 50; // ที่ที่ชื่อเดือนแบบย่อ (เช่น พ.ย. 68) ต้องใช้รวมช่องไฟ (px)
/* 12 เดือนล่าสุด เดือนเก่าสุดก่อน นับตามวันที่เพิ่มเข้าระบบ (createdAt) เดือนนี้จึงนับถึงวันนี้ */
function trendMonths(now = new Date()) {
  return Array.from({ length: 12 }, (_, i) => {
    const from = monthStart(i - 11, now);
    return {
      label: from.toLocaleDateString("th-TH", { month: "short", year: "2-digit" }),
      long: from.toLocaleDateString("th-TH", { month: "long", year: "numeric" }),
      count: countAdded(from.getTime(), monthStart(i - 10, now).getTime()),
    };
  });
}

function renderCharts() {
  const months = trendMonths();
  renderTrendTable(months);
  if (typeof Chart === "undefined") return;
  const c = chartColors();
  // ถ้าฟอนต์ Sarabun ยังโหลดไม่เสร็จหรือโหลดไม่ได้ ตัวหนังสือบนกราฟใช้ฟอนต์ไม่มีเชิงของเครื่องแทนฟอนต์มีเชิง
  Chart.defaults.font.family = "Sarabun, system-ui, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = c.text;

  // ตัวเลขเหนือจุดเฉพาะเดือนล่าสุด กับเดือนที่มากที่สุดถ้าเป็นคนละเดือน ช่วงที่ยังไม่มีเอกสารเลยไม่ต้องมีตัวเลข
  const counts = months.map((m) => m.count);
  const peak = Math.max(...counts);
  const labels = peak ? [...new Set([counts.indexOf(peak), counts.length - 1])] : [];
  paintChart("chartTrend", "line", {
    labels: months.map((m) => m.label),
    datasets: [{
      data: counts,
      borderColor: c.primary,
      backgroundColor: (context) => areaGradient(context.chart, c.primaryRgb),
      borderWidth: 2.5,
      fill: true,
      // เส้นโค้งที่ไม่เลยจุดข้อมูล จึงไม่จมใต้ศูนย์ระหว่างเดือนที่ไม่มีเอกสาร และไม่โด่งเกินเดือนที่มากที่สุด
      cubicInterpolationMode: "monotone",
      pointRadius: 5,
      pointHoverRadius: 8,
      pointHitRadius: 12,
      pointBorderWidth: 0,
      pointBackgroundColor: c.primary,
    }],
  }, {
    // เว้นขอบบนให้ตัวเลขเหนือจุด และขอบขวาให้ผิวบนของเส้นที่ยื่นออกไป
    layout: { padding: { top: 22, right: 14 } },
    plugins: {
      legend: { display: false },
      tooltip: { ...chartTooltip(c), callbacks: { title: (items) => months[items[0].dataIndex].long, label: (item) => ` ${item.raw} ฉบับ` } },
      chart3d: { labels, color: c.ink },
    },
    interaction: { mode: "index", intersect: false },
    scales: {
      x: {
        grid: { display: false }, border: { display: false },
        // ชื่อเดือนไม่เอียง จอแคบจึงเว้นบางเดือน โดยนับถอยจากเดือนล่าสุด เดือนนี้จึงมีชื่อเสมอ
        ticks: {
          maxRotation: 0, autoSkip: false,
          callback(value, index) {
            const every = Math.max(1, Math.ceil(MONTH_LABEL_SPACE / (this.width / (months.length - 1))));
            return (months.length - 1 - index) % every ? "" : months[index].label;
          },
        },
      },
      y: { grid: { color: c.grid }, border: { display: false }, beginAtZero: true, grace: "12%", ticks: { precision: 0 } },
    },
  });
}

/* ตารางของกราฟรายเดือน อ่านตัวเลขทุกเดือนได้ตรง ๆ และโปรแกรมอ่านหน้าจออ่านได้ (ปุ่มดูแบบตาราง) */
function renderTrendTable(months) {
  const total = months.reduce((sum, m) => sum + m.count, 0);
  document.getElementById("trendTable").innerHTML = `
    <table class="doc-table trend-table">
      <thead><tr><th scope="col">เดือน</th><th scope="col" class="num">จำนวน (ฉบับ)</th></tr></thead>
      <tbody>${months.map((m) => `<tr><td>${m.long}</td><td class="mono num">${m.count}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>รวม 12 เดือน</td><td class="mono num">${total}</td></tr></tfoot>
    </table>`;
}
/* ข้อความบนปุ่มบอกสิ่งที่จะได้เห็นเมื่อกด */
const TREND_TOGGLE = {
  chart: { label: "ดูแบบตาราง", icon: `<path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 10h18M3 14.5h18M9 10v9"/>` },
  table: { label: "ดูแบบกราฟ", icon: `<path d="M3 3v18h18M7 15l4-4 3 3 5-6"/>` },
};
function showTrendAsTable(asTable) {
  document.getElementById("trendChartBox").hidden = asTable;
  document.getElementById("trendTable").hidden = !asTable;
  const toggle = TREND_TOGGLE[asTable ? "table" : "chart"];
  const button = document.getElementById("trendViewToggle");
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${toggle.icon}</svg><span>${toggle.label}</span>`;
  // บนมือถือปุ่มเหลือแค่ไอคอน ชื่อปุ่มจึงอยู่ใน aria-label และ title ด้วย
  button.setAttribute("aria-label", toggle.label);
  button.title = toggle.label;
  // กราฟที่ถูกซ่อนอยู่วัดขนาดกล่องไม่ได้ จึงให้วัดใหม่ตอนกลับมาแสดง
  if (!asTable) charts.chartTrend?.resize();
}
document.getElementById("trendViewToggle").addEventListener("click", () => {
  showTrendAsTable(document.getElementById("trendTable").hidden);
});

function paintChart(canvasId, type, data, extraOptions) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart(ctx, {
    type, data, plugins: [chart3d],
    options: { responsive: true, maintainAspectRatio: false, ...extraOptions },
  });
}

/* สีและไอคอนที่ป๊อบอัปหมวดหมู่ให้เลือก เรียงตามในป๊อบอัป (firestore.rules ต้องมีรายการเดียวกัน) */
const CATEGORY_COLORS = ["#2A78D6", "#EB6834", "#1BAF7A", "#E09A00", "#6B5BD2", "#D55181", "#0E9AA7", "#5E6A85"];
const CATEGORY_ICONS = {
  chat: `<path d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-9l-5 4v-4H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/>`,
  inbox: `<path d="M3 13h5l1.5 3h5l1.5-3h5M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>`,
  clipboard: `<path d="M9 3h6v3H9zM15 4.5h3a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h3M9 11h6M9 15h4"/>`,
  stamp: `<path d="M12 3a3 3 0 0 0-3 3c0 1.3.8 2 1.3 3L10 13H6a2 2 0 0 0-2 2v2h16v-2a2 2 0 0 0-2-2h-4l-.3-4c.5-1 1.3-1.7 1.3-3a3 3 0 0 0-3-3zM5 21h14"/>`,
  send: `<path d="M21 3L10 14M21 3l-7 18-4-7-7-4z"/>`,
  folder: `<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/>`,
  building: `<path d="M4 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17M14 9h5a1 1 0 0 1 1 1v11M2 21h20M7.5 7.5h3M7.5 11.5h3M7.5 15.5h3M16.5 13h1M16.5 17h1"/>`,
  tag: `<path d="M3 4a1 1 0 0 1 1-1h7.6a1 1 0 0 1 .7.3l8.4 8.4a1 1 0 0 1 0 1.4l-7.6 7.6a1 1 0 0 1-1.4 0l-8.4-8.4a1 1 0 0 1-.3-.7z"/><circle cx="7.5" cy="7.5" r="1.5"/>`,
  archive: `<path d="M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>`,
  copy: `<path d="M9 7h8l3 3v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM16 7V4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h3"/>`,
};
/* สีและไอคอนตั้งต้นของหมวดหลัก (จุดสีในกล่องแยกตามหมวดหมู่ ไอคอนในรายการเอกสารล่าสุดและการ์ดหน้าหมวดหมู่) เทียบชื่อด้วย categoryKey
   หมวดที่สร้างเพิ่มเองได้สีถัดไปตามลำดับกับไอคอนแฟ้ม เอกสารที่ไม่มีหมวดเป็นสีเทา (CSS)
   desc คือคำอธิบายใต้ชื่อบนการ์ด สี ไอคอน และคำอธิบายที่บันทึกไว้จากป๊อบอัปหมวดหมู่จะใช้แทนค่าเหล่านี้ */
const CATEGORY_LOOK = {
  "หนังสือรับ": { color: "#2A78D6", desc: "หนังสือราชการที่รับเข้าจากหน่วยงานภายนอก", icon: "inbox" },
  "หนังสือส่ง": { color: "#1BAF7A", desc: "หนังสือราชการที่ส่งออกไปยังหน่วยงานอื่น", icon: "send" },
  "หนังสือเวียน": { color: "#0E9AA7", desc: "หนังสือที่แจ้งเวียนให้บุคลากรรับทราบ", icon: "copy" },
  "คำสั่ง": { color: "#E09A00", desc: "คำสั่งองค์การบริหารส่วนตำบลวังใหญ่", icon: "stamp" },
  "บันทึกข้อความ": { color: "#6B5BD2", desc: "บันทึกข้อความและหนังสือภายในสำนักงาน", icon: "clipboard" },
  "คำร้อง": { color: "#EB6834", desc: "คำร้องทั่วไปจากประชาชนและหน่วยงานในพื้นที่", icon: "chat" },
};
const EXTRA_CATEGORY_COLORS = ["#D55181", "#5E6A85"];
const CUSTOM_CATEGORY_DESC = "หมวดหมู่ที่เพิ่มเอง";
const PAGE_ICON = `<path d="M6 2h9l5 5v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/>`;
const lookName = (name) => Object.keys(CATEGORY_LOOK).find((n) => categoryKey(n) === categoryKey(name));
/* หน้าตาของหมวด: { color, iconKey, icon (path ของ svg), desc } */
function categoryLook(id) {
  const category = allCategories.find((c) => c.id === id);
  if (!category) return { color: "", icon: PAGE_ICON };
  const known = lookName(category.name);
  const extra = allCategories.filter((c) => !lookName(c.name)).indexOf(category);
  const base = known ? CATEGORY_LOOK[known]
    : { color: EXTRA_CATEGORY_COLORS[extra % EXTRA_CATEGORY_COLORS.length], desc: CUSTOM_CATEGORY_DESC, icon: "folder" };
  const iconKey = Object.hasOwn(CATEGORY_ICONS, category.icon) ? category.icon : base.icon;
  return {
    color: CATEGORY_COLORS.includes(category.color) ? category.color : base.color,
    iconKey, icon: CATEGORY_ICONS[iconKey],
    desc: typeof category.description === "string" && category.description.trim() ? category.description.trim() : base.desc,
  };
}
const lookStyle = (look) => (look.color ? ` style="--c:${look.color}"` : "");

/* เอกสาร 5 ฉบับที่เพิ่มเข้าระบบล่าสุด: ไอคอนบอกหมวด ชื่อ เลขที่ · หน่วยงาน และวันที่ของเอกสาร
   ฉบับที่แนบ PDF กดได้ทั้งแถวเพื่อเปิดดูไฟล์ เหมือนกดชื่อเอกสารในหน้าเอกสาร */
function renderRecentList() {
  const list = document.getElementById("recentList");
  const recent = [...allDocuments].sort((a, b) => byEntry(b, a)).slice(0, 5);
  list.innerHTML = recent.map((d) => {
    const look = categoryLook(d.category);
    const category = categoryName(d.category) || "ไม่ระบุหมวดหมู่";
    const meta = [d.docNumber, d.agency].map((v) => String(v ?? "").trim()).filter(Boolean).join(" · ");
    const inner = `
      <span class="recent-ico"${lookStyle(look)} role="img" aria-label="${escapeHtml(category)}" title="${escapeHtml(category)}"><svg viewBox="0 0 24 24">${look.icon}</svg></span>
      <span class="recent-main">
        <span class="recent-title">${urgencyBadge(d.urgency)}${escapeHtml(d.title || "-")}</span>
        <span class="recent-meta">${escapeHtml(meta || "-")}</span>
      </span>
      <span class="recent-date">${formatDate(d.date)}</span>`;
    return `<li>${hasAttachment(d)
      ? `<button type="button" class="recent-item" data-view-file="${escapeHtml(d.id)}">${inner}</button>`
      : `<div class="recent-item">${inner}</div>`}</li>`;
  }).join("") || `<li class="dash-empty">ยังไม่มีเอกสาร</li>`;
  bindRowActions(list);
}

/* แถวของกล่องแยกตามหมวดหมู่และแยกตามงาน: ชื่อ (มีจุดสีถ้ามี dot) แท่งยาวเทียบกับแถวที่มากที่สุด จำนวน และร้อยละของ total
   แถวที่มี attrs เป็นปุ่มเปิดหน้าเอกสารที่กรองไว้ตรงกับแถวนั้น แถว none (ยังไม่ระบุ) เป็นสีเทาปิดท้าย */
function breakdownRows(rows, total) {
  const max = Math.max(0, ...rows.map((r) => r.count));
  return rows.map((r) => {
    const percent = sharePercent(r.count, total);
    const inner = `
      <span class="bd-name">${r.dot === undefined ? "" : `<i class="bd-dot"${r.dot}></i>`}<span>${escapeHtml(r.name)}</span></span>
      <span class="bd-track"><span class="bd-fill" style="width:${max ? (r.count / max) * 100 : 0}%"></span></span>
      <span class="bd-val"><b class="mono">${r.count}</b><small class="mono">${percent}%</small></span>`;
    const cls = `bd-row${r.none ? " is-none" : ""}`;
    return r.attrs
      ? `<li><button type="button" class="${cls}" ${r.attrs} aria-label="${escapeHtml(r.name)} ${r.count} ฉบับ (${percent}%) กดเพื่อดูเอกสาร">${inner}</button></li>`
      : `<li><div class="${cls}">${inner}</div></li>`;
  }).join("");
}

/* แยกตามหมวดหมู่: เรียงแบบเดียวกับกล่องในหน้าเอกสาร ร้อยละเทียบกับเอกสารทั้งหมด
   กดแถวแล้วเปิดหน้าเอกสารที่กรองเหลือหมวดนั้น จำนวนในหน้านั้นจึงตรงกับตัวเลขในแถว */
function renderCategoryBreakdown() {
  const known = new Set(allCategories.map((c) => c.id));
  const rows = [...allCategories].sort((a, b) => categoryRank(a.name) - categoryRank(b.name)).map((c) => ({
    name: c.name, count: allDocuments.filter((d) => d.category === c.id).length,
    dot: lookStyle(categoryLook(c.id)), attrs: `data-show-cat="${escapeHtml(c.id)}"`,
  }));
  // เอกสารที่ไม่มีหมวด (หรือหมวดถูกลบไปแล้ว) ปิดท้ายเป็นสีเทา ตัวกรองหมวดหมู่เลือกกลุ่มนี้ไม่ได้ จึงไม่เป็นปุ่ม
  const none = allDocuments.filter((d) => !known.has(d.category)).length;
  if (none) rows.push({ name: "ไม่ระบุหมวดหมู่", count: none, dot: "", none: true });
  document.getElementById("categoryBreakdown").innerHTML = breakdownRows(rows, allDocuments.length)
    || `<li class="dash-empty">ยังไม่มีหมวดหมู่</li>`;
}
document.getElementById("categoryBreakdown").addEventListener("click", (e) => {
  const row = e.target.closest("[data-show-cat]");
  if (!row) return;
  resetDocFilters(row.dataset.showCat);
  switchView("documents");
});

/* แยกตามงานที่รับผิดชอบ: ทุกงานตามลำดับในฟอร์ม แล้วยังไม่ระบุงาน ไม่นับคำสั่งเพราะคำสั่งไม่มีช่องงาน
   ร้อยละจึงเทียบกับเอกสารที่ไม่ใช่คำสั่ง กดแถวแล้วเปิดหน้าเอกสารที่กรองเหลืองานนั้น (รวมแถวยังไม่ระบุงาน) */
function renderSectionBreakdown() {
  const sections = allDocuments.map(sectionOf).filter((section) => section !== null);
  const rows = [...SECTION_KEYS, ""].map((key) => ({
    name: SECTION_LABEL[key] || "ยังไม่ระบุงาน", count: sections.filter((section) => section === key).length,
    attrs: `data-show-section="${key || NO_SECTION}"`, none: !key,
  }));
  document.getElementById("sectionBreakdown").innerHTML = breakdownRows(rows, sections.length);
}
document.getElementById("sectionBreakdown").addEventListener("click", (e) => {
  const row = e.target.closest("[data-show-section]");
  if (!row) return;
  resetDocFilters("", row.dataset.showSection);
  switchView("documents");
});

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
/* งานที่รับผิดชอบของรายการ: "" คือยังไม่ระบุงาน (รวมค่าที่ไม่รู้จัก) และ null คือคำสั่ง ซึ่งไม่มีช่องนี้ */
function sectionOf(d) {
  if (isOrderCategory(d?.category)) return null;
  return Object.hasOwn(SECTION_LABEL, d?.section) ? d.section : "";
}
function orderCategoryId() {
  return allCategories.find((c) => categoryKey(c.name) === categoryKey(ORDER_CATEGORY))?.id || "";
}
/* ฟอร์มคำสั่ง: เปิดจากปุ่มเพิ่มคำสั่งในกล่องคำสั่งหรือแก้ไขคำสั่ง (หมวดหมู่ล็อกไว้ที่คำสั่ง) หรือเลือกหมวดคำสั่งในฟอร์มเพิ่มเอกสาร */
function docFormIsOrder() {
  const category = document.getElementById("docCategory");
  return "locked" in category.dataset || isOrderCategory(category.value);
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
  // คำสั่งไม่มีชั้นความเร็วและงานที่รับผิดชอบ แต่มีตัวเลือกปี พ.ศ. ไว้ลงคำสั่งย้อนหลัง และกล่องค้นหาคำสั่งที่บันทึกไว้แล้ว
  document.getElementById("docUrgencyField").hidden = order;
  document.getElementById("docSectionField").hidden = order;
  document.getElementById("docYear").hidden = !order;
  document.getElementById("orderLookup").hidden = !order;
  if (order) renderOrderLookup();
  // ช่องเลขที่รับที่ซ่อนไว้ยังเก็บค่าที่พิมพ์ไว้ เลือกหนังสือรับกลับมาก่อนบันทึกจึงไม่ต้องพิมพ์ใหม่
  document.getElementById("docReceiveField").hidden = !isReceiveCategory(category.value);
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
    const details = String(d.agency ?? "").trim();
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
/* หมวดที่ระบบอ้างถึงด้วยชื่อ (หน้าตาตั้งต้น ช่องเฉพาะของหนังสือรับ คำสั่ง ฯลฯ) เปลี่ยนชื่อแล้วจะหลุดจากสิ่งเหล่านั้น
   จึงเปลี่ยนได้แค่คำอธิบาย สี และไอคอน */
const isSystemCategory = (name) => !!lookName(name);

/* การ์ดหมวดหมู่: ไอคอนสีประจำหมวด ปุ่มแก้ไข/ลบ ชื่อ คำอธิบาย จำนวนเอกสาร และวันที่มีเอกสารเพิ่มหรือแก้ไขล่าสุด */
function categoryCard(c) {
  const docs = allDocuments.filter((d) => d.category === c.id);
  const look = categoryLook(c.id);
  const last = Math.max(0, ...docs.map((d) => Math.max(timeMillis(d.updatedAt), createdAtMillis(d))));
  const status = !docs.length ? "ยังไม่มีเอกสาร" : last ? `อัปเดต ${formatDate(new Date(last).toISOString())}` : "";
  const name = escapeHtml(c.name);
  const editAttrs = `data-edit-cat="${escapeHtml(c.id)}" title="แก้ไขหมวดหมู่" aria-label="แก้ไขหมวดหมู่ ${name}"`;
  // หมวดหมู่หลักลบไม่ได้: ensureDefaultCategories จะสร้างกลับมาเป็น id ใหม่ เอกสารเดิมจึงหลุดหมวดหมู่
  const deleteAttrs = isDefaultCategory(c.name)
    ? `disabled title="หมวดหมู่หลักของระบบ ลบไม่ได้" aria-label="หมวดหมู่หลักของระบบ ${name} ลบไม่ได้"`
    : `data-del-cat="${escapeHtml(c.id)}" title="ลบหมวดหมู่" aria-label="ลบหมวดหมู่ ${name}"`;
  return `
    <div class="category-card" data-open-cat="${escapeHtml(c.id)}"${lookStyle(look)}>
      <div class="cat-top">
        <span class="cat-ico" aria-hidden="true"><svg viewBox="0 0 24 24">${look.icon}</svg></span>
        <div class="cat-actions">
          <button type="button" class="cat-tool cat-edit" ${editAttrs}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
          </button>
          <button type="button" class="cat-tool cat-del" ${deleteAttrs}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg>
          </button>
        </div>
      </div>
      <button type="button" class="cat-name" aria-label="ดูเอกสารในหมวดหมู่ ${name}">${name}</button>
      <p class="cat-desc">${escapeHtml(look.desc || "")}</p>
      <p class="cat-count"><b>${docs.length}</b> เอกสาร</p>
      <div class="cat-foot">
        <span>${status}</span>
        <span class="cat-open" aria-hidden="true">ดูเอกสาร <svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>
      </div>
    </div>`;
}

/* หน้าหมวดหมู่: การ์ดเรียงเป็นสามคอลัมน์ไล่ลงทีละคอลัมน์ตามลำดับชื่อ คอลัมน์กลางเริ่มด้วยกล่องสรุป
   และปิดท้ายด้วยการ์ดเพิ่มหมวดหมู่ใหม่ (สองกล่องนี้สูงรวมกันราวการ์ดหนึ่งใบ จึงได้หมวดน้อยกว่าหนึ่งใบ)
   จอแคบคอลัมน์หายไป (display: contents) การ์ดไหลต่อกันตามลำดับเดิม โดยกล่องสรุปขึ้นก่อนและการ์ดเพิ่มอยู่ท้าย */
function renderCategories() {
  const grid = document.getElementById("categoryGrid");
  const n = allCategories.length;
  const left = Math.min(n, Math.ceil((n + 1) / 3));
  const right = Math.min(n - left, Math.ceil((n + 1 - left) / 2));
  const cards = allCategories.map(categoryCard);
  const summary = `
    <div class="cat-summary">
      <div class="cat-summary-nums">
        <span><b>${n}</b><small>หมวดหมู่</small></span>
        <span><b>${allDocuments.length}</b><small>เอกสาร</small></span>
      </div>
      <p>คลิกที่การ์ดเพื่อดูเอกสารในหมวดหมู่</p>
    </div>`;
  const addCard = `
    <button type="button" class="cat-add" data-add-cat>
      <span class="cat-add-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span>
      เพิ่มหมวดหมู่ใหม่
    </button>`;
  grid.innerHTML = [
    cards.slice(0, left).join(""),
    summary + cards.slice(left, n - right).join("") + addCard,
    cards.slice(n - right).join(""),
  ].map((col) => `<div class="cat-col">${col}</div>`).join("");
  grid.querySelector("[data-add-cat]").addEventListener("click", openAddCategory);
  grid.querySelectorAll("[data-edit-cat]").forEach((btn) => {
    btn.addEventListener("click", () => openEditCategory(btn.dataset.editCat));
  });
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
  // กดตรงไหนของการ์ดก็เปิดดูเอกสารในหมวดนั้น ยกเว้นปุ่มแก้ไข/ลบ (ชื่อหมวดหมู่เป็นปุ่ม จึงเปิดจากคีย์บอร์ดได้ด้วย)
  grid.querySelectorAll("[data-open-cat]").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".cat-actions button")) return;
      resetDocFilters(card.dataset.openCat);
      switchView("documents");
    });
  });
}

/* ป๊อบอัปหมวดหมู่ใช้ทั้งเพิ่มและแก้ไข: editingCategoryId ว่างคือเพิ่มใหม่
   ปุ่มสีและไอคอนสร้างครั้งเดียว แล้วสลับ aria-pressed ตาม categoryPick (ไม่วาดใหม่ โฟกัสจากคีย์บอร์ดจึงไม่หลุด) */
const CATEGORY_COLOR_NAMES = ["น้ำเงิน", "ส้ม", "เขียว", "เหลืองทอง", "ม่วง", "ชมพู", "เขียวน้ำทะเล", "เทา"];
const CATEGORY_ICON_NAMES = {
  chat: "ข้อความ", inbox: "ถาดรับเข้า", clipboard: "คลิปบอร์ด", stamp: "ตราประทับ", send: "ส่งออก",
  folder: "แฟ้ม", building: "อาคาร", tag: "ป้าย", archive: "กล่องเก็บเอกสาร", copy: "สำเนา",
};
let editingCategoryId = "";
const categoryPick = { color: "", icon: "" };
document.getElementById("categoryColorPicks").innerHTML = CATEGORY_COLORS.map((color, i) => `
  <button type="button" class="color-pick" data-pick-color="${color}" style="--c:${color}" aria-pressed="false" aria-label="สี${CATEGORY_COLOR_NAMES[i]}" title="สี${CATEGORY_COLOR_NAMES[i]}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
  </button>`).join("");
document.getElementById("categoryIconPicks").innerHTML = Object.entries(CATEGORY_ICONS).map(([key, path]) => `
  <button type="button" class="icon-pick" data-pick-icon="${key}" aria-pressed="false" aria-label="ไอคอน${CATEGORY_ICON_NAMES[key]}" title="${CATEGORY_ICON_NAMES[key]}">
    <svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>
  </button>`).join("");
function pickCategoryLook(change) {
  Object.assign(categoryPick, change);
  document.querySelectorAll("#categoryColorPicks [data-pick-color]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.pickColor === categoryPick.color));
  });
  document.querySelectorAll("#categoryIconPicks [data-pick-icon]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.pickIcon === categoryPick.icon));
  });
}
document.getElementById("categoryColorPicks").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-pick-color]");
  if (btn) pickCategoryLook({ color: btn.dataset.pickColor });
});
document.getElementById("categoryIconPicks").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-pick-icon]");
  if (btn) pickCategoryLook({ icon: btn.dataset.pickIcon });
});
/* หมวดใหม่เริ่มที่สีแรกที่ยังไม่มีหมวดไหนใช้ (หมวดหลักครบห้าหมวดจะได้สีชมพู) กับไอคอนแฟ้ม */
function nextCategoryColor() {
  const used = allCategories.map((c) => categoryLook(c.id).color);
  return CATEGORY_COLORS.find((color) => !used.includes(color)) || CATEGORY_COLORS[allCategories.length % CATEGORY_COLORS.length];
}
function openCategoryModal(category) {
  editingCategoryId = category ? category.id : "";
  const look = category ? categoryLook(category.id) : { color: nextCategoryColor(), iconKey: "folder", desc: "" };
  const locked = !!category && isSystemCategory(category.name);
  const nameInput = document.getElementById("categoryName");
  document.getElementById("categoryForm").reset();
  nameInput.value = category ? category.name : "";
  nameInput.readOnly = locked;
  document.getElementById("categoryNameHint").hidden = !locked;
  document.getElementById("categoryDescription").value = look.desc || "";
  document.getElementById("categoryModalTitle").textContent = category ? "แก้ไขหมวดหมู่" : "เพิ่มหมวดหมู่";
  pickCategoryLook({ color: look.color, icon: look.iconKey });
  openModal("categoryModalOverlay");
}
const openAddCategory = () => openCategoryModal(null);
function openEditCategory(id) {
  const category = allCategories.find((c) => c.id === id);
  if (category) openCategoryModal(category);
}
document.getElementById("addCategoryBtn").addEventListener("click", openAddCategory);
document.getElementById("categoryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("categoryName").value.trim();
  const description = document.getElementById("categoryDescription").value.trim();
  const { color, icon } = categoryPick;
  if (document.getElementById("categoryModalOverlay").getAttribute("aria-busy") === "true") return;
  // ช่องว่างล้วนผ่าน required ของเบราว์เซอร์ได้ จึงต้องบอกเอง ไม่ใช่กดแล้วเงียบ
  if (!name) {
    showToast("กรุณากรอกชื่อหมวดหมู่", "error");
    return;
  }
  const editing = editingCategoryId && allCategories.find((c) => c.id === editingCategoryId);
  if (editingCategoryId && !editing) {
    showToast("ไม่พบหมวดหมู่นี้แล้ว อาจถูกลบไปก่อน", "error");
    closeModal("categoryModalOverlay");
    return;
  }
  if (allCategories.some((c) => c !== editing && categoryKey(c.name) === categoryKey(name))) {
    showToast("มีหมวดหมู่นี้แล้ว กรุณาใช้ชื่ออื่น", "error");
    return;
  }
  // แก้ไข: เขียนเฉพาะช่องที่ต่างจากที่แสดงอยู่ ช่องที่ยังเป็นค่าตั้งต้นจึงตามค่าตั้งต้นต่อไป
  // คำอธิบายที่ลบจนว่างจะกลับไปใช้คำอธิบายตั้งต้น ชื่อหมวดที่ระบบใช้เปลี่ยนไม่ได้
  let changes = null;
  if (editing) {
    const look = categoryLook(editing.id);
    changes = {};
    if (name !== editing.name && !isSystemCategory(editing.name)) changes.name = name;
    if (description !== look.desc) changes.description = description;
    if (color !== look.color) changes.color = color;
    if (icon !== look.iconKey) changes.icon = icon;
    if (!Object.keys(changes).length) {
      closeModal("categoryModalOverlay");
      return;
    }
  }
  setModalBusy("categoryModalOverlay", true);
  try {
    if (editing) {
      // id เดิมไม่เปลี่ยน เอกสารที่อ้างถึงจึงไม่หลุด
      await db.collection("categories").doc(editing.id).update(changes);
      showToast("บันทึกหมวดหมู่แล้ว", "success");
    } else {
      await db.collection("categories").add({ name, ...(description && { description }), color, icon, createdAt: Date.now() });
      showToast("เพิ่มหมวดหมู่แล้ว", "success");
    }
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

/* ช่องงานที่รับผิดชอบ: ปุ่มเลือกได้อันเดียว กดอันที่เลือกอยู่ซ้ำเพื่อยกเลิก ค่าที่บันทึกคือปุ่มที่ถูกเลือกอยู่
   sectionChoice จำงานที่เลือกไว้ก่อนกด เพราะตอน click มาถึง เบราว์เซอร์เลือกปุ่มที่ถูกกดไปแล้ว */
let sectionChoice = "";
const sectionPicks = () => [...document.querySelectorAll('#docSectionPicks input[name="docSection"]')];
function setSectionChoice(value) {
  sectionChoice = Object.hasOwn(SECTION_LABEL, value) ? value : "";
  sectionPicks().forEach((input) => { input.checked = input.value === sectionChoice; });
}
function chosenSection() {
  return sectionPicks().find((input) => input.checked)?.value || "";
}
// กดที่ตัวหนังสือของปุ่ม เบราว์เซอร์ส่ง click ต่อให้ตัวเลือกข้างในอีกครั้ง จึงทำงานเฉพาะ click ของตัวเลือก
document.getElementById("docSectionPicks").addEventListener("click", (e) => {
  if (e.target.name !== "docSection") return;
  if (e.target.value === sectionChoice) setSectionChoice("");
  else sectionChoice = e.target.value;
});
// ปุ่มลูกศรบนคีย์บอร์ดเปลี่ยนงานที่เลือกได้โดยไม่ผ่าน click
document.getElementById("docSectionPicks").addEventListener("change", (e) => {
  if (e.target.name === "docSection" && e.target.checked) sectionChoice = e.target.value;
});
// เว้นวรรคบนงานที่เลือกอยู่: Chrome ไม่ส่ง click ให้ตัวเลือกที่เลือกอยู่แล้ว จึงยกเลิกเองตั้งแต่ตอนกดลง
// และกันตอนปล่อยไว้ด้วย ไม่ให้เบราว์เซอร์ที่คลิกตอนปล่อยปุ่มเลือกงานเดิมกลับมา
let sectionClearedByKey = null;
document.getElementById("docSectionPicks").addEventListener("keydown", (e) => {
  if (e.key !== " " || e.target.name !== "docSection" || !e.target.checked) return;
  e.preventDefault();
  sectionClearedByKey = e.target;
  setSectionChoice("");
});
document.getElementById("docSectionPicks").addEventListener("keyup", (e) => {
  if (e.key !== " " || e.target !== sectionClearedByKey) return;
  e.preventDefault();
  sectionClearedByKey = null;
});

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
  setSectionChoice(doc?.section);
  renderYearOptions();
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
    description: document.getElementById("docDescription").value.trim(),
    deleted: false,
    updatedAt: Date.now(),
  };
  // ทุกช่องเป็นตัวเลือก — ไม่บังคับกรอกครบหรือแนบไฟล์ PDF (firestore.rules ต้องยอมรับแบบเดียวกัน)
  const upload = pendingFileData;
  const existing = id ? findDoc(id) : null;
  // สถานะเลิกใช้แล้ว แต่ firestore.rules บนเซิร์ฟเวอร์ยังบังคับให้ทุกฉบับมีช่อง status
  // ฉบับใหม่ (และฉบับเก่าที่ไม่มีช่องนี้) จึงเขียนค่าว่างไว้ ฉบับที่มีอยู่แล้วไม่แตะ ค่าที่เคยเลือกไว้จึงไม่หาย
  if (typeof existing?.status !== "string") payload.status = "";
  // เขียนชั้นความเร็วเฉพาะเมื่อเลือกไว้ หรือเมื่อต้องล้างค่าเดิมกลับเป็นปกติ
  // เอกสารปกติจึงยังบันทึกได้ แม้ firestore.rules บนเซิร์ฟเวอร์ยังเป็นรุ่นที่ไม่รู้จักช่องนี้
  // คำสั่งไม่มีชั้นความเร็ว จึงนับเป็นปกติ
  const urgency = order ? "" : document.getElementById("docUrgency").value;
  if (urgency || existing?.urgency) payload.urgency = urgency;
  // เลขที่รับก็เขียนแบบเดียวกัน: เฉพาะหนังสือรับที่กรอกไว้ หรือเมื่อต้องล้างค่าเดิม (เช่น ย้ายไปหมวดอื่น)
  const receiveNumber = isReceiveCategory(category) ? document.getElementById("docReceiveNumber").value.trim() : "";
  if (receiveNumber || existing?.receiveNumber) payload.receiveNumber = receiveNumber;
  // งานที่รับผิดชอบก็เขียนแบบเดียวกัน: เฉพาะเมื่อเลือกไว้ หรือเมื่อต้องล้างค่าเดิม คำสั่งไม่มีงาน (เช่น ย้ายเอกสารไปหมวดคำสั่ง)
  const section = order ? "" : chosenSection();
  if (section || existing?.section) payload.section = section;

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
document.getElementById("filterSection").addEventListener("change", () => { resetGroupPages(); renderDocsTable(); });
document.getElementById("filterDate").addEventListener("change", () => { resetGroupPages(); renderDocsTable(); });
/* ล้างตัวกรองทั้งหมด หรือเหลือไว้แค่หมวดหมู่หรืองานเดียว ตอนเปิดแฟ้มหรือกดแถวในแดชบอร์ด
   (ตารางจึงมีเอกสารครบตามจำนวนบนแฟ้มหรือในแถวนั้น) */
function resetDocFilters(category = "", section = "") {
  document.getElementById("globalSearch").value = "";
  document.getElementById("filterCategory").value = category;
  document.getElementById("filterSection").value = section;
  document.getElementById("filterDate").value = "";
  resetGroupPages();
  renderDocsTable();
}
document.getElementById("clearFilters").addEventListener("click", () => resetDocFilters());

/* คำค้น (พิมพ์เล็กแล้ว) ตรงกับชื่อ เลขที่ เลขที่รับ หน่วยงาน หมวดหมู่ ชั้นความเร็ว หรืองานที่รับผิดชอบ
   ใช้ทั้งช่องค้นหาด้านบนและช่องค้นหาในฟอร์มคำสั่ง */
function matchesSearch(d, q) {
  return !q || [d.title, d.docNumber, d.receiveNumber, d.agency, categoryName(d.category), URGENCY_LABEL[d.urgency], SECTION_LABEL[sectionOf(d)]]
    .some((f) => String(f ?? "").toLowerCase().includes(q));
}
function getFilteredDocs() {
  const q = document.getElementById("globalSearch").value.trim().toLowerCase();
  const catFilter = document.getElementById("filterCategory").value;
  const sectionFilter = document.getElementById("filterSection").value;
  const dateFilter = document.getElementById("filterDate").value;

  return allDocuments.filter((d) => {
    const matchesQuery = matchesSearch(d, q);
    const matchesCat = !catFilter || d.category === catFilter;
    // คำสั่งไม่มีงาน จึงไม่อยู่ทั้งในงานใดและในยังไม่ระบุงาน
    const matchesSection = !sectionFilter || sectionOf(d) === (sectionFilter === NO_SECTION ? "" : sectionFilter);
    const matchesDate = !dateFilter || d.date === dateFilter;
    return matchesQuery && matchesCat && matchesSection && matchesDate;
  });
}

/* กล่องหมวดเรียงตามงานสารบรรณ หมวดที่สร้างเพิ่มต่อท้ายตามชื่อ และไม่ระบุหมวดหมู่อยู่ท้ายสุด */
const CATEGORY_ORDER = ["หนังสือรับ", "หนังสือส่ง", "หนังสือเวียน", "คำสั่ง", "บันทึกข้อความ", "คำร้อง"];
function categoryRank(name) {
  const rank = CATEGORY_ORDER.findIndex((n) => categoryKey(n) === categoryKey(name));
  return rank === -1 ? CATEGORY_ORDER.length : rank;
}
/* แต่ละกล่องเรียงและแบ่งหน้าของตัวเอง (คีย์คือ id หมวด, "" คือไม่ระบุหมวดหมู่)
   เริ่มที่ลำดับการบันทึก ฉบับที่เพิ่งบันทึกอยู่บนสุด ยกเว้นหนังสือรับเริ่มที่เลขที่รับมากสุดอยู่บนสุด */
const groupViews = new Map();
function defaultGroupSort(id) {
  return { sortKey: isReceiveCategory(id) ? "receiveNumber" : "entry", sortDir: "desc" };
}
function groupView(id) {
  if (!groupViews.has(id)) groupViews.set(id, { ...defaultGroupSort(id), page: 1 });
  return groupViews.get(id);
}
function resetGroupPages() { groupViews.forEach((view) => { view.page = 1; }); }

function sortDocs(list, { sortKey, sortDir }) {
  const dir = sortDir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    if (sortKey !== "entry") {
      let av = a[sortKey] ?? "", bv = b[sortKey] ?? "";
      if (sortKey === "size") { av = a.fileSize || 0; bv = b.fileSize || 0; }
      // งานเรียงตามลำดับในฟอร์ม ยังไม่ระบุงานมาก่อน เหมือนช่องว่างของคอลัมน์อื่น
      if (sortKey === "section") { av = SECTION_KEYS.indexOf(sectionOf(a)); bv = SECTION_KEYS.indexOf(sectionOf(b)); }
      const order = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv, "th", { numeric: true }) : (av > bv) - (av < bv);
      if (order) return order * dir;
    }
    // ค่าเริ่มต้น และแถวที่ค่าเท่ากัน (เช่น ออกเอกสารวันเดียวกัน) เรียงตามลำดับที่บันทึก
    return byEntry(a, b) * dir;
  });
}

/* คอลัมน์ของกล่องหมวด ไม่มีคอลัมน์หมวดหมู่เพราะหัวกล่องบอกอยู่แล้ว
   กล่องคำสั่งเรียกหัวคอลัมน์แบบคำสั่ง หมวดที่มีชื่อช่องหน่วยงานของตัวเอง (AGENCY_LABELS) ใช้ชื่อเดียวกับในฟอร์ม
   กล่องหนังสือรับมีเลขที่รับเป็นคอลัมน์แรก เหมือนสมุดทะเบียนรับ และทุกกล่องยกเว้นคำสั่งมีงานที่รับผิดชอบต่อท้าย */
function groupColumns(id) {
  const order = isOrderCategory(id);
  const labels = FIELD_LABELS[order ? "order" : "document"];
  return [
    ...(isReceiveCategory(id) ? [["receiveNumber", "เลขที่รับ"]] : []),
    ["docNumber", labels.docNumber], ["title", labels.title],
    ["agency", order ? labels.agency : documentAgencyLabel(id)],
    ["date", labels.date], ["size", "ขนาดไฟล์"],
    ...(order ? [] : [["section", "งานที่รับผิดชอบ"]]),
  ];
}
/* ช่องในแถวของแต่ละคอลัมน์ (คีย์เดียวกับ groupColumns) */
const DOC_CELLS = {
  receiveNumber: (d) => `<td class="mono">${escapeHtml(d.receiveNumber || "-")}</td>`,
  docNumber: (d) => `<td class="mono">${escapeHtml(d.docNumber || "-")}</td>`,
  title: (d) => `<td class="doc-title-cell">${docTitle(d)}</td>`,
  agency: (d) => `<td>${escapeHtml(d.agency || "-")}</td>`,
  date: (d) => `<td class="mono">${formatDate(d.date)}</td>`,
  size: (d) => `<td class="mono">${d.fileSize ? formatFileSize(d.fileSize) : "-"}</td>`,
  section: (d) => `<td class="col-section">${SECTION_LABEL[sectionOf(d)] || "-"}</td>`,
};
function docRow(d, columns) {
  // เอกสารที่บันทึกโดยไม่แนบ PDF ไม่มีอะไรให้ดูหรือดาวน์โหลด ปิดปุ่มไว้แทนการกดแล้วแจ้งว่าไฟล์เสีย
  const fileButton = (label) => hasAttachment(d) ? `title="${label}"` : `title="${label} (ไม่มีไฟล์ PDF)" disabled`;
  return `
    <tr>
      ${columns.map(([key]) => DOC_CELLS[key](d)).join("\n      ")}
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
  // หมวดที่เปลี่ยนชื่อจนคอลัมน์ที่กำลังเรียงอยู่หายไป (เช่น เลขที่รับ) กลับไปเรียงแบบเริ่มต้นของหมวด
  if (view.sortKey !== "entry" && !columns.some(([key]) => key === view.sortKey)) Object.assign(view, defaultGroupSort(group.id));
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
          <tbody>${rows.map((d) => docRow(d, columns)).join("")}</tbody>
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
  // ค้นหา หรือกรองงานหรือวันที่อยู่ แสดงเฉพาะหมวดที่มีเอกสารตรงกัน ไม่งั้นแสดงทุกหมวด แม้หมวดที่ยังไม่มีเอกสาร
  const narrowed = Boolean(document.getElementById("globalSearch").value.trim()
    || document.getElementById("filterSection").value || document.getElementById("filterDate").value);
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
  return timeMillis(doc.createdAtMs ?? doc.createdAt);
}
/* เวลาที่เก็บไว้ได้หลายแบบ (Timestamp ของ Firestore, ตัวเลข ms, หรือ { seconds }) → ms, 0 ถ้าไม่รู้ */
function timeMillis(value) {
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
