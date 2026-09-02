"use strict";

/* =========================================================
   CONSTANTS
   ========================================================= */
const MAX_FILE_BYTES = 700 * 1024; // ~700KB — keeps base64 doc under Firestore's 1MiB limit
const PAGE_SIZE = 8;
const STATUS_LABEL = { approved: "อนุมัติแล้ว", pending: "รอดำเนินการ", rejected: "ไม่อนุมัติ" };

/* =========================================================
   STATE
   ========================================================= */
let allDocuments = [];   // live, non-deleted
let allTrash = [];       // soft-deleted
let allCategories = [];

let sortKey = "date";
let sortDir = "desc";
let currentPage = 1;
let pendingFileData = null; // { name, size, dataUrl }
let confirmCallback = null;
let charts = {};

/* =========================================================
   THEME & APPEARANCE
   ผู้ใช้เลือกโหมดสี ชุดสีสำเร็จรูป และกำหนดสีของแต่ละส่วนเองได้
   ค่าที่ตั้งไว้ถูกเขียนทับลงบนตัวแปร CSS ของ :root แล้วบันทึกใน localStorage
   ========================================================= */
const APPEARANCE_KEY = "govdocs-appearance";
const RADIUS_BASE = { "--radius-xs": 8, "--radius-sm": 12, "--radius": 18, "--radius-lg": 24 };

/* ค่าเริ่มต้น — ต้องตรงกับ :root และ [data-theme="dark"] ใน style.css */
const APPEARANCE_DEFAULTS = {
  light: { bg: "#EEF4FC", surface: "#FFFFFF", text: "#10233A", primary: "#0B3D91", accent: "#C9A227", success: "#17805A", warning: "#B5771A", danger: "#BE3535" },
  dark:  { bg: "#060D18", surface: "#0F1B2D", text: "#E8F1FB", primary: "#5B93DD", accent: "#E9CB6B", success: "#46C68D", warning: "#E7B953", danger: "#EB7A7A" },
};

const COLOR_FIELDS = [
  { key: "bg",      label: "พื้นหลังหน้าจอ" },
  { key: "surface", label: "พื้นการ์ด / แผง" },
  { key: "text",    label: "สีตัวอักษร" },
  { key: "primary", label: "สีหลัก / ปุ่มหลัก" },
  { key: "accent",  label: "สีเน้น" },
  { key: "success", label: "สถานะอนุมัติแล้ว" },
  { key: "warning", label: "สถานะรอดำเนินการ" },
  { key: "danger",  label: "สถานะไม่อนุมัติ" },
];

const COLOR_PRESETS = [
  { id: "default", name: "ราชการน้ำเงิน", primary: "#0B3D91", accent: "#C9A227" },
  { id: "emerald", name: "เขียวมรกต",     primary: "#0F6B4F", accent: "#D2A02F" },
  { id: "royal",   name: "ม่วงราชสำนัก",  primary: "#4B2E83", accent: "#CFA23C" },
  { id: "crimson", name: "แดงชาด",        primary: "#A32330", accent: "#D8A13A" },
  { id: "ocean",   name: "ฟ้าคราม",       primary: "#0F6C9E", accent: "#EFA93B" },
  { id: "slate",   name: "เทาสุขุม",       primary: "#37485C", accent: "#8C9BAC" },
];

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

/** สร้างตัวแปร CSS ทั้งชุดจากสีหลัก 8 สีที่ผู้ใช้เลือก */
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
    "--warning": b.warning,
    "--warning-bg": tint(b.warning, dark ? 0.86 : 0.84),
    "--danger": b.danger,
    "--danger-bg": tint(b.danger, dark ? 0.86 : 0.84),
    "--grad-primary": `linear-gradient(135deg, ${mixHex(b.primary, W, dark ? 0.06 : 0.1)} 0%, ${b.primary} 45%, ${mixHex(b.primary, K, dark ? 0.35 : 0.28)} 100%)`,
    "--grad-gold": `linear-gradient(135deg, ${mixHex(b.accent, W, 0.22)}, ${b.accent})`,
  };
}

const MANAGED_VARS = [...Object.keys(deriveVars(APPEARANCE_DEFAULTS.light, false)), ...Object.keys(RADIUS_BASE)];

/* ---------- state ---------- */
let appearance = loadAppearance();

function loadAppearance() {
  const fallbackMode = localStorage.getItem("govdocs-theme") || "system";
  const blank = { mode: fallbackMode, preset: null, radius: 100, light: {}, dark: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || "null");
    if (!saved || typeof saved !== "object") return blank;
    const clean = (obj) => {
      const out = {};
      COLOR_FIELDS.forEach(({ key }) => { if (isHex(obj?.[key])) out[key] = obj[key].toUpperCase(); });
      return out;
    };
    return {
      mode: ["light", "dark", "system"].includes(saved.mode) ? saved.mode : fallbackMode,
      preset: typeof saved.preset === "string" ? saved.preset : null,
      radius: Number.isFinite(saved.radius) ? Math.min(200, Math.max(0, saved.radius)) : 100,
      light: clean(saved.light),
      dark: clean(saved.dark),
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
const baseColors = (mode) => ({ ...APPEARANCE_DEFAULTS[mode], ...appearance[mode] });

/** ใส่ค่าสีทั้งหมดลง :root ตามโหมดปัจจุบัน */
function applyAppearance({ repaintCharts = false } = {}) {
  const mode = activeMode();
  const root = document.documentElement;
  root.setAttribute("data-theme", mode);

  MANAGED_VARS.forEach((prop) => root.style.removeProperty(prop));

  if (Object.keys(appearance[mode]).length) {
    const vars = deriveVars(baseColors(mode), mode === "dark");
    Object.entries(vars).forEach(([prop, value]) => root.style.setProperty(prop, value));
  }
  if (appearance.radius !== 100) {
    Object.entries(RADIUS_BASE).forEach(([prop, px]) => root.style.setProperty(prop, `${Math.round((px * appearance.radius) / 100)}px`));
  }
  if (repaintCharts) renderCharts();
}

/* ---------- UI ---------- */
function renderPresets() {
  const grid = document.getElementById("presetGrid");
  grid.innerHTML = "";
  COLOR_PRESETS.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `preset-btn${appearance.preset === p.id || (!appearance.preset && p.id === "default" && !Object.keys(appearance[activeMode()]).length) ? " is-active" : ""}`;
    btn.innerHTML = `<span class="preset-dots"><i style="background:${p.primary}"></i><i style="background:${p.accent}"></i></span><span></span>`;
    btn.lastElementChild.textContent = p.name;
    btn.addEventListener("click", () => applyPreset(p));
    grid.appendChild(btn);
  });
}

function presetColors(p, mode) {
  const dark = mode === "dark";
  const primary = dark ? mixHex(p.primary, "#FFFFFF", 0.34) : p.primary;
  return {
    ...APPEARANCE_DEFAULTS[mode],
    primary,
    accent: dark ? mixHex(p.accent, "#FFFFFF", 0.28) : p.accent,
    bg: dark ? mixHex(p.primary, "#03060B", 0.9) : mixHex(p.primary, "#FFFFFF", 0.93),
    surface: dark ? mixHex(p.primary, "#0A1119", 0.86) : "#FFFFFF",
    text: dark ? APPEARANCE_DEFAULTS.dark.text : mixHex(p.primary, "#0A121C", 0.72),
  };
}

function applyPreset(p) {
  if (p.id === "default") {
    appearance.light = {};
    appearance.dark = {};
  } else {
    appearance.light = presetColors(p, "light");
    appearance.dark = presetColors(p, "dark");
  }
  appearance.preset = p.id;
  saveAppearance();
  applyAppearance({ repaintCharts: true });
  syncAppearanceUI();
  showToast(`ใช้ชุดสี “${p.name}” แล้ว`, "success");
}

function renderSwatches() {
  const grid = document.getElementById("swatchGrid");
  const mode = activeMode();
  const colors = baseColors(mode);
  grid.innerHTML = "";
  COLOR_FIELDS.forEach(({ key, label }) => {
    const item = document.createElement("div");
    item.className = "swatch";
    item.innerHTML = `
      <span class="swatch-chip"><input type="color" data-color-key="${key}" aria-label="${label}"></span>
      <span class="swatch-text"><strong></strong><span class="mono" data-hex-for="${key}"></span></span>
      <button type="button" class="swatch-reset" data-reset-key="${key}" aria-label="คืนค่าเดิมของ${label}" title="คืนค่าเดิม">
        <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/></svg>
      </button>`;
    item.querySelector("strong").textContent = label;
    item.querySelector("input").value = colors[key].toLowerCase();
    item.querySelector("[data-hex-for]").textContent = colors[key];
    grid.appendChild(item);
  });
}

function syncAppearanceUI() {
  const mode = activeMode();
  const colors = baseColors(mode);

  document.querySelectorAll("#modeSegment button").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.mode === appearance.mode);
  });
  document.getElementById("tuneModeNote").textContent =
    `กำลังแก้ไขสีของโหมด${mode === "dark" ? "มืด" : "สว่าง"}`;

  document.querySelectorAll("#swatchGrid input[type=color]").forEach((input) => {
    const key = input.dataset.colorKey;
    input.value = colors[key].toLowerCase();
    const hex = document.querySelector(`[data-hex-for="${key}"]`);
    if (hex) hex.textContent = colors[key];
  });

  document.getElementById("radiusRange").value = appearance.radius;
  document.getElementById("radiusValue").textContent = `${appearance.radius}%`;
  renderPresets();
}

function setColor(key, value) {
  const mode = activeMode();
  appearance[mode] = { ...appearance[mode], [key]: value.toUpperCase() };
  appearance.preset = null;
  saveAppearance();
  applyAppearance();
}

function setMode(mode) {
  appearance.mode = mode;
  saveAppearance();
  applyAppearance({ repaintCharts: true });
  syncAppearanceUI();
}

function resetAppearance() {
  appearance = { mode: appearance.mode, preset: "default", radius: 100, light: {}, dark: {} };
  saveAppearance();
  applyAppearance({ repaintCharts: true });
  syncAppearanceUI();
  showToast("คืนค่าสีเริ่มต้นแล้ว", "success");
}

/* ---------- wiring ---------- */
applyAppearance();

document.getElementById("appearanceBtn").addEventListener("click", () => {
  renderSwatches();
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

document.getElementById("swatchGrid").addEventListener("input", (e) => {
  const input = e.target.closest("input[data-color-key]");
  if (!input) return;
  setColor(input.dataset.colorKey, input.value);
  const hex = document.querySelector(`[data-hex-for="${input.dataset.colorKey}"]`);
  if (hex) hex.textContent = input.value.toUpperCase();
});
document.getElementById("swatchGrid").addEventListener("change", (e) => {
  if (e.target.closest("input[data-color-key]")) { renderCharts(); renderPresets(); }
});
document.getElementById("swatchGrid").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-reset-key]");
  if (!btn) return;
  const mode = activeMode();
  delete appearance[mode][btn.dataset.resetKey];
  appearance.preset = null;
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
function setConnection(state, text) {
  const dot = document.getElementById("connDot");
  const label = document.getElementById("connText");
  if (!dot || !label) return;
  dot.className = `dot-live ${state}`;
  label.textContent = text;
}

auth.signInAnonymously()
  .then(() => {
    setConnection("is-online", "เชื่อมต่อแล้ว · ซิงก์เรียลไทม์");
    attachFirestoreListeners();
  })
  .catch((err) => {
    setConnection("is-error", "เชื่อมต่อไม่สำเร็จ");
    showToast("เชื่อมต่อฐานข้อมูลไม่สำเร็จ: " + err.message, "error");
    attachFirestoreListeners(); // still try, in case rules are open
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
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${view}`));
  document.getElementById("pageTitle").textContent = VIEW_TITLE[view] || "แดชบอร์ด";
  window.scrollTo({ top: 0, behavior: "smooth" });
  closeSidebarMobile();
}

const sidebar = document.getElementById("sidebar");
const scrim = document.getElementById("scrim");
document.getElementById("menuToggle").addEventListener("click", () => {
  sidebar.classList.add("is-open");
  scrim.classList.add("is-visible");
});
scrim.addEventListener("click", closeSidebarMobile);
function closeSidebarMobile() {
  sidebar.classList.remove("is-open");
  scrim.classList.remove("is-visible");
}

/* =========================================================
   MODAL HELPERS
   ========================================================= */
function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }
document.querySelectorAll("[data-close-modal]").forEach((btn) => {
  btn.addEventListener("click", () => btn.closest(".modal-overlay").hidden = true);
});
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.hidden = true; });
});

/* Esc closes the topmost open modal · Ctrl/⌘+K jumps to search */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const open = [...document.querySelectorAll(".modal-overlay")].filter((m) => !m.hidden).pop();
    if (open) open.hidden = true;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    document.getElementById("globalSearch").focus();
  }
});

function askConfirm(message, onConfirm) {
  document.getElementById("confirmMessage").textContent = message;
  confirmCallback = onConfirm;
  openModal("confirmModalOverlay");
}
document.getElementById("confirmActionBtn").addEventListener("click", () => {
  if (confirmCallback) confirmCallback();
  closeModal("confirmModalOverlay");
});

/* =========================================================
   FIRESTORE LISTENERS
   ========================================================= */
function attachFirestoreListeners() {
  db.collection("documents").where("deleted", "==", false)
    .onSnapshot((snap) => {
      allDocuments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }, (err) => showToast("โหลดเอกสารล้มเหลว: " + err.message, "error"));

  db.collection("documents").where("deleted", "==", true)
    .onSnapshot((snap) => {
      allTrash = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderTrash();
    }, (err) => showToast("โหลดถังขยะล้มเหลว: " + err.message, "error"));

  db.collection("categories").orderBy("name")
    .onSnapshot((snap) => {
      allCategories = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderCategoryOptions();
      renderCategories();
      renderAll();
    }, (err) => showToast("โหลดหมวดหมู่ล้มเหลว: " + err.message, "error"));
}

function renderAll() {
  renderStats();
  renderCharts();
  renderRecentTable();
  renderDocsTable();
  }

/* =========================================================
   DASHBOARD: STATS + CHARTS
   ========================================================= */
/* Animates a number from its current value to `target` */
function countTo(el, target) {
  const from = Number(el.textContent.replace(/[^\d]/g, "")) || 0;
  if (from === target) { el.textContent = target; return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 600);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(from + (target - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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
    if (meter && key !== "Total") meter.style.width = `${pct}%`;
    const chip = document.getElementById(`chip${key}`);
    if (chip && key !== "Total") chip.textContent = `${pct}%`;
  });

  // sidebar badges + attachment storage meter
  document.getElementById("navCountDocs").textContent = total;
  document.getElementById("navCountCats").textContent = allCategories.length;
  document.getElementById("navCountTrash").textContent = allTrash.length;

  const bytes = allDocuments.reduce((sum, d) => sum + (d.fileSize || 0), 0);
  document.getElementById("storageText").textContent =
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
  // meter fills relative to a 20MB soft reference so it stays readable
  document.getElementById("storageBar").style.width = `${Math.min(100, (bytes / (20 * 1024 * 1024)) * 100)}%`;
}

/* อ่านสีจากตัวแปร CSS โดยตรง กราฟจึงเปลี่ยนตามธีมและสีที่ผู้ใช้ตั้งเองเสมอ */
function chartColors() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  const primary = v("--primary", dark ? "#5B93DD" : "#0B3D91");
  return {
    text: v("--text-muted", dark ? "#93A9C4" : "#5B7089"),
    grid: v("--border", dark ? "#223B59" : "#D5E3F4"),
    fill: `rgba(${v("--primary-rgb", dark ? "91, 147, 221" : "11, 61, 145")}, ${dark ? 0.18 : 0.12})`,
    tooltipBg: dark ? v("--surface-2", "#14243A") : v("--text", "#10233A"),
    tooltipText: dark ? v("--text", "#E8F1FB") : "#FFFFFF",
    palette: [
      primary,
      v("--accent", "#C9A227"),
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

function renderCharts() {
  if (typeof Chart === "undefined") return;
  const c = chartColors();
  Chart.defaults.font.family = "Sarabun";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = c.text;

  // --- by category ---
  const catCounts = {};
  allDocuments.forEach((d) => {
    const name = categoryName(d.category) || "ไม่ระบุหมวดหมู่";
    catCounts[name] = (catCounts[name] || 0) + 1;
  });
  paintChart("chartCategory", "bar", {
    labels: Object.keys(catCounts),
    datasets: [{
      data: Object.values(catCounts),
      backgroundColor: Object.keys(catCounts).map((_, i) => c.palette[i % c.palette.length]),
      borderRadius: 8, borderSkipped: false, maxBarThickness: 32, hoverOffset: 4,
    }],
  }, {
    plugins: { legend: { display: false }, tooltip: chartTooltip(c) },
    scales: {
      x: { grid: { display: false }, border: { display: false } },
      y: { grid: { color: c.grid }, border: { display: false }, beginAtZero: true, ticks: { precision: 0 } },
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
      borderWidth: 0, spacing: 3, hoverOffset: 8,
    }],
  }, {
    cutout: "72%",
    plugins: {
      tooltip: chartTooltip(c),
      legend: { position: "bottom", labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: "circle", padding: 16 } },
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
    if (!d.date) return false;
    const dt = new Date(d.date);
    return `${dt.getFullYear()}-${dt.getMonth()}` === m.key;
  }).length);
  paintChart("chartTrend", "line", {
    labels: months.map((m) => m.label),
    datasets: [{
      data: trendData,
      borderColor: c.palette[0],
      backgroundColor: c.fill,
      borderWidth: 2.5,
      fill: true,
      tension: 0.4,
      pointRadius: 4,
      pointHoverRadius: 7,
      pointBackgroundColor: c.palette[0],
      pointBorderColor: "rgba(255,255,255,.85)",
      pointBorderWidth: 2,
    }],
  }, {
    plugins: { legend: { display: false }, tooltip: chartTooltip(c) },
    interaction: { mode: "index", intersect: false },
    scales: {
      x: { grid: { display: false }, border: { display: false } },
      y: { grid: { color: c.grid }, border: { display: false }, beginAtZero: true, ticks: { precision: 0 } },
    },
  });
}

function paintChart(canvasId, type, data, extraOptions) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart(ctx, { type, data, options: { responsive: true, maintainAspectRatio: false, ...extraOptions } });
}

function renderRecentTable() {
  const tbody = document.querySelector("#recentTable tbody");
  const recent = [...allDocuments].sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0)).slice(0, 5);
  tbody.innerHTML = recent.map((d) => `
    <tr>
      <td class="mono">${escapeHtml(d.docNumber || "-")}</td>
      <td class="doc-title-cell">${escapeHtml(d.title)}</td>
      <td>${escapeHtml(categoryName(d.category) || "-")}</td>
      <td class="mono">${formatDate(d.date)}</td>
      <td>${statusStamp(d.status)}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="doc-sub">ยังไม่มีเอกสาร</td></tr>`;
}

/* =========================================================
   CATEGORIES
   ========================================================= */
function categoryName(id) {
  const cat = allCategories.find((c) => c.id === id);
  return cat ? cat.name : "";
}
function renderCategoryOptions() {
  const opts = allCategories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  document.getElementById("docCategory").innerHTML = opts || `<option value="">— ยังไม่มีหมวดหมู่ —</option>`;
  document.getElementById("filterCategory").innerHTML = `<option value="">หมวดหมู่ทั้งหมด</option>${opts}`;
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
    return `
      <div class="category-card">
        <div class="cat-top">
          <span class="cat-ico"><svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg></span>
          <span class="stat-chip mono">${share}%</span>
        </div>
        <span class="cat-name">${escapeHtml(c.name)}</span>
        <span class="cat-count">${count} เอกสาร</span>
        <div class="meter"><span style="width:${(count / max) * 100}%"></span></div>
        <div class="cat-actions">
          <button class="icon-btn" data-del-cat="${c.id}" title="ลบหมวดหมู่">
            <svg viewBox="0 0 24 24"><path d="M6 7h12l-1 13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7z"/></svg>
          </button>
        </div>
      </div>`;
  }).join("");
  grid.querySelectorAll("[data-del-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      askConfirm("ลบหมวดหมู่นี้? เอกสารที่เกี่ยวข้องจะไม่ถูกลบ แต่จะไม่มีหมวดหมู่", async () => {
        try {
          await db.collection("categories").doc(btn.dataset.delCat).delete();
          showToast("ลบหมวดหมู่แล้ว", "success");
        } catch (err) { showToast(err.message, "error"); }
      });
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
  if (!name) return;
  try {
    await db.collection("categories").add({ name, createdAt: Date.now() });
    showToast("เพิ่มหมวดหมู่แล้ว", "success");
    closeModal("categoryModalOverlay");
  } catch (err) { showToast(err.message, "error"); }
});

/* =========================================================
   DOCUMENT FILE HANDLING (PDF -> base64, stored in Firestore)
   ========================================================= */
const fileDrop = document.getElementById("fileDrop");
const fileInput = document.getElementById("docFile");
const fileDropText = document.getElementById("fileDropText");

fileDrop.addEventListener("click", () => fileInput.click());
fileDrop.addEventListener("dragover", (e) => { e.preventDefault(); fileDrop.classList.add("has-file"); });
fileDrop.addEventListener("dragleave", () => { if (!pendingFileData) fileDrop.classList.remove("has-file"); });
fileDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

function handleFile(file) {
  const errEl = document.getElementById("docFormError");
  errEl.hidden = true;
  if (file.type !== "application/pdf") {
    errEl.textContent = "รองรับเฉพาะไฟล์ PDF เท่านั้น";
    errEl.hidden = false;
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    errEl.textContent = `ไฟล์ใหญ่เกินไป (${(file.size / 1024).toFixed(0)}KB) กรุณาใช้ไฟล์ไม่เกิน ${(MAX_FILE_BYTES / 1024).toFixed(0)}KB`;
    errEl.hidden = false;
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingFileData = { name: file.name, size: file.size, dataUrl: reader.result };
    fileDrop.classList.add("has-file");
    fileDropText.textContent = `${file.name} (${(file.size / 1024).toFixed(0)}KB) — คลิกเพื่อเปลี่ยนไฟล์`;
  };
  reader.readAsDataURL(file);
}
/* =========================================================
   DOCUMENT CRUD
   ========================================================= */
document.getElementById("addDocBtn").addEventListener("click", () => openDocModal());
document.querySelectorAll("[data-open='addDocBtn']").forEach((b) => b.addEventListener("click", () => openDocModal()));

function openDocModal(doc = null) {
  document.getElementById("docForm").reset();
  document.getElementById("docFormError").hidden = true;
  fileInput.value = "";
  pendingFileData = null;
  fileDrop.classList.remove("has-file");
  fileDropText.textContent = "ลากไฟล์ PDF มาวาง หรือคลิกเพื่อเลือกไฟล์ (สูงสุด " + (MAX_FILE_BYTES / 1024).toFixed(0) + "KB)";

  if (doc) {
    document.getElementById("docModalTitle").textContent = "แก้ไขเอกสาร";
    document.getElementById("docId").value = doc.id;
    document.getElementById("docTitle").value = doc.title || "";
    document.getElementById("docNumber").value = doc.docNumber || "";
    document.getElementById("docDate").value = doc.date || "";
    document.getElementById("docAgency").value = doc.agency || "";
    document.getElementById("docCategory").value = doc.category || "";
    document.getElementById("docStatus").value = doc.status || "pending";
    document.getElementById("docDescription").value = doc.description || "";
    if (doc.fileName) fileDropText.textContent = `ไฟล์ปัจจุบัน: ${doc.fileName} — คลิกเพื่อแทนที่`;
  } else {
    document.getElementById("docModalTitle").textContent = "เพิ่มเอกสารใหม่";
    document.getElementById("docId").value = "";
    const today = new Date();
    const localDate = new Date(today.getTime() - today.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
    document.getElementById("docDate").value = localDate;
  }
  openModal("docModalOverlay");
}

document.getElementById("docForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("docId").value;
  const errEl = document.getElementById("docFormError");
  const payload = {
    title: document.getElementById("docTitle").value.trim(),
    docNumber: document.getElementById("docNumber").value.trim(),
    date: document.getElementById("docDate").value,
    agency: document.getElementById("docAgency").value.trim(),
    category: document.getElementById("docCategory").value,
    status: document.getElementById("docStatus").value,
    description: document.getElementById("docDescription").value.trim(),
    deleted: false,
    updatedAt: Date.now(),
  };
  if (pendingFileData) {
    payload.fileName = pendingFileData.name;
    payload.fileSize = pendingFileData.size;
    payload.fileData = pendingFileData.dataUrl;
  } else if (!id) {
    errEl.textContent = "กรุณาแนบไฟล์ PDF";
    errEl.hidden = false;
    return;
  }

  const saveBtn = document.getElementById("docSaveBtn");
  saveBtn.disabled = true;
  saveBtn.textContent = "กำลังบันทึก...";
  try {
    if (id) {
      await db.collection("documents").doc(id).update(payload);
      showToast("แก้ไขเอกสารสำเร็จ", "success");
    } else {
      payload.createdAt = Date.now();
      payload.createdAtMs = Date.now();
      await db.collection("documents").add(payload);
      showToast("เพิ่มเอกสารสำเร็จ", "success");
    }
    closeModal("docModalOverlay");
  } catch (err) {
    errEl.textContent = "บันทึกไม่สำเร็จ: " + err.message;
    errEl.hidden = false;
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "บันทึกเอกสาร";
  }
});

function softDeleteDoc(id) {
  askConfirm("ย้ายเอกสารนี้ไปยังถังขยะ?", async () => {
    try {
      await db.collection("documents").doc(id).update({ deleted: true, deletedAt: Date.now() });
      showToast("ย้ายไปถังขยะแล้ว", "success");
    } catch (err) { showToast(err.message, "error"); }
  });
}
function restoreDoc(id) {
  db.collection("documents").doc(id).update({ deleted: false, deletedAt: null })
    .then(() => showToast("กู้คืนเอกสารแล้ว", "success"))
    .catch((err) => showToast(err.message, "error"));
}
function permanentlyDeleteDoc(id) {
  askConfirm("ลบเอกสารนี้ถาวร? ไม่สามารถกู้คืนได้", async () => {
    try {
      await db.collection("documents").doc(id).delete();
      showToast("ลบเอกสารถาวรแล้ว", "success");
    } catch (err) { showToast(err.message, "error"); }
  });
}

function downloadDoc(doc) {
  if (!doc.fileData) { showToast("ไม่พบไฟล์แนบสำหรับเอกสารนี้", "error"); return; }
  const a = document.createElement("a");
  a.href = doc.fileData;
  a.download = doc.fileName || `${doc.title}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function previewDoc(doc) {
  if (!doc.fileData) { showToast("ไม่พบไฟล์แนบสำหรับเอกสารนี้", "error"); return; }
  document.getElementById("previewTitle").textContent = doc.title;
  document.getElementById("previewFrame").src = doc.fileData;
  openModal("previewModalOverlay");
}

/* =========================================================
   DOCUMENTS TABLE: search, filter, sort, paginate
   ========================================================= */
document.getElementById("globalSearch").addEventListener("input", () => { currentPage = 1; renderDocsTable(); });
document.getElementById("filterCategory").addEventListener("change", () => { currentPage = 1; renderDocsTable(); });
document.getElementById("filterStatus").addEventListener("change", () => { currentPage = 1; renderDocsTable(); });
document.getElementById("filterDate").addEventListener("change", () => { currentPage = 1; renderDocsTable(); });
document.getElementById("clearFilters").addEventListener("click", () => {
  document.getElementById("globalSearch").value = "";
  document.getElementById("filterCategory").value = "";
  document.getElementById("filterStatus").value = "";
  document.getElementById("filterDate").value = "";
  currentPage = 1;
  renderDocsTable();
});
document.querySelectorAll("#docsTable th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = key; sortDir = "asc"; }
    renderDocsTable();
  });
});

function getFilteredDocs() {
  const q = document.getElementById("globalSearch").value.trim().toLowerCase();
  const catFilter = document.getElementById("filterCategory").value;
  const statusFilter = document.getElementById("filterStatus").value;
  const dateFilter = document.getElementById("filterDate").value;

  let list = allDocuments.filter((d) => {
    const matchesQuery = !q || [d.title, d.docNumber, d.agency, categoryName(d.category)]
      .some((f) => (f || "").toLowerCase().includes(q));
    const matchesCat = !catFilter || d.category === catFilter;
    const matchesStatus = !statusFilter || d.status === statusFilter;
    const matchesDate = !dateFilter || d.date === dateFilter;
    return matchesQuery && matchesCat && matchesStatus && matchesDate;
  });

  list.sort((a, b) => {
    let av = a[sortKey] ?? "", bv = b[sortKey] ?? "";
    if (sortKey === "category") { av = categoryName(a.category) || ""; bv = categoryName(b.category) || ""; }
    if (sortKey === "size") { av = a.fileSize || 0; bv = b.fileSize || 0; }
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return 0;
  });
  return list;
}
function renderDocsTable() {
  const list = getFilteredDocs();
  const tbody = document.getElementById("docsTableBody");
  const emptyEl = document.getElementById("docsEmpty");
  const emptyMessage = document.getElementById("docsEmptyMessage");
  const emptyAddButton = document.getElementById("docsEmptyAddBtn");

  // sort direction indicator on the header
  document.querySelectorAll("#docsTable th[data-sort]").forEach((th) => {
    th.classList.toggle("is-sorted-asc", th.dataset.sort === sortKey && sortDir === "asc");
    th.classList.toggle("is-sorted-desc", th.dataset.sort === sortKey && sortDir === "desc");
  });

  const hasDocuments = allDocuments.length > 0;
  const hasResults = list.length > 0;
  emptyEl.hidden = hasResults;
  document.getElementById("resultCount").textContent =
    hasDocuments ? `พบ ${list.length} จาก ${allDocuments.length} รายการ` : "";
  emptyMessage.textContent = hasDocuments ? "ไม่พบเอกสารที่ตรงกับตัวกรอง" : "ยังไม่มีเอกสารในระบบ";
  emptyAddButton.hidden = hasDocuments;
  document.querySelector("#docsTable").style.display = hasResults ? "table" : "none";

  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages);
  const pageItems = list.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  tbody.innerHTML = pageItems.map((d) => `
    <tr>
      <td class="mono">${escapeHtml(d.docNumber || "-")}</td>
      <td class="doc-title-cell">${escapeHtml(d.title)}${d.description ? `<div class="doc-sub">${escapeHtml(truncate(d.description, 60))}</div>` : ""}</td>
      <td>${escapeHtml(categoryName(d.category) || "-")}</td>
      <td>${escapeHtml(d.agency || "-")}</td>
      <td class="mono">${formatDate(d.date)}</td>
      <td class="mono">${d.fileSize ? (d.fileSize / 1024).toFixed(0) + " KB" : "-"}</td>
      <td>${statusStamp(d.status)}</td>
      <td class="col-actions">
        <div class="row-actions">
          <button class="icon-btn" data-preview="${d.id}" title="ดูตัวอย่าง"><svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg></button>
          <button class="icon-btn" data-download="${d.id}" title="ดาวน์โหลด"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg></button>
          <button class="icon-btn" data-edit="${d.id}" title="แก้ไข"><svg viewBox="0 0 24 24"><path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg></button>
          <button class="icon-btn" data-delete="${d.id}" title="ลบ"><svg viewBox="0 0 24 24"><path d="M6 7h12l-1 13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7z"/></svg></button>
        </div>
      </td>
    </tr>`).join("");

  bindRowActions(tbody);
  renderPagination(totalPages);
}

function bindRowActions(scope) {
  scope.querySelectorAll("[data-preview]").forEach((b) => b.addEventListener("click", () => previewDoc(findDoc(b.dataset.preview))));
  scope.querySelectorAll("[data-download]").forEach((b) => b.addEventListener("click", () => downloadDoc(findDoc(b.dataset.download))));
  scope.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openDocModal(findDoc(b.dataset.edit))));
  scope.querySelectorAll("[data-delete]").forEach((b) => b.addEventListener("click", () => softDeleteDoc(b.dataset.delete)));
}
function findDoc(id) { return allDocuments.find((d) => d.id === id) || allTrash.find((d) => d.id === id); }

function renderPagination(totalPages) {
  const el = document.getElementById("pagination");
  if (totalPages <= 1) { el.innerHTML = ""; return; }
  let html = "";
  for (let i = 1; i <= totalPages; i++) {
    html += `<button class="${i === currentPage ? "is-active" : ""}" data-page="${i}">${i}</button>`;
  }
  el.innerHTML = html;
  el.querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => { currentPage = Number(b.dataset.page); renderDocsTable(); }));
}

/* =========================================================
   TRASH VIEW
   ========================================================= */
function renderTrash() {
  const tbody = document.getElementById("trashTableBody");
  const emptyEl = document.getElementById("trashEmpty");
  emptyEl.hidden = allTrash.length !== 0;
  document.getElementById("trashTable").style.display = allTrash.length === 0 ? "none" : "table";
  document.getElementById("navCountTrash").textContent = allTrash.length;

  tbody.innerHTML = allTrash.map((d) => `
    <tr>
      <td class="mono">${escapeHtml(d.docNumber || "-")}</td>
      <td class="doc-title-cell">${escapeHtml(d.title)}</td>
      <td class="mono">${d.deletedAt ? new Date(d.deletedAt).toLocaleDateString("th-TH") : "-"}</td>
      <td class="col-actions">
        <div class="row-actions">
          <button class="icon-btn" data-restore="${d.id}" title="กู้คืน"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/></svg></button>
          <button class="icon-btn" data-purge="${d.id}" title="ลบถาวร"><svg viewBox="0 0 24 24"><path d="M6 7h12l-1 13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7z"/></svg></button>
        </div>
      </td>
    </tr>`).join("");

  tbody.querySelectorAll("[data-restore]").forEach((b) => b.addEventListener("click", () => restoreDoc(b.dataset.restore)));
  tbody.querySelectorAll("[data-purge]").forEach((b) => b.addEventListener("click", () => permanentlyDeleteDoc(b.dataset.purge)));
}

/* =========================================================
   HELPERS
   ========================================================= */
function statusStamp(status) {
  const cls = { approved: "stamp-approved", pending: "stamp-pending", rejected: "stamp-rejected" }[status] || "stamp-pending";
  return `<span class="stamp ${cls}">${STATUS_LABEL[status] || "รอดำเนินการ"}</span>`;
}
function formatDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d)) return "-";
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}
function truncate(str, n) { return str.length > n ? str.slice(0, n) + "…" : str; }
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}