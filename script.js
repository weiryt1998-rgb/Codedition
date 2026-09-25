"use strict";

/* =========================================================
   CONSTANTS
   ========================================================= */
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB — ต้องตรงกับ worker/src/index.js และ firestore.rules
const PDF_MIME = "application/pdf";
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
  let fallbackMode = "system";
  const blank = { mode: fallbackMode, preset: null, radius: 100, light: {}, dark: {} };
  try {
    const legacyMode = localStorage.getItem("govdocs-theme");
    if (["light", "dark", "system"].includes(legacyMode)) fallbackMode = legacyMode;
    blank.mode = fallbackMode;
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
function signInDatabase() {
  if (typeof auth === "undefined" || !auth || typeof db === "undefined" || !db) return Promise.resolve(false);
  return auth.signInAnonymously().then(() => true).catch((err) => {
    showToast("เชื่อมต่อฐานข้อมูลไม่สำเร็จ: " + err.message, "error");
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
  overlay.querySelectorAll("button, input, select, textarea").forEach((el) => { el.disabled = busy; });
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
  catch (err) { showToast(err.message, "error"); }
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
  const failed = (err) => showToast("โหลดข้อมูลล้มเหลว: " + err.message, "error");

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

function ensureDefaultCategories(snap) {
  // รอสแนปช็อตจริงจากเซิร์ฟเวอร์ก่อน ไม่งั้นข้อมูลจากแคชอาจทำให้สร้างซ้ำ
  if (defaultCategoriesChecked || snap.metadata.fromCache || snap.metadata.hasPendingWrites) return;
  defaultCategoriesChecked = true;
  const key = (name) => String(name).trim().normalize().toLocaleLowerCase("th");
  const existing = new Set(allCategories.map((c) => key(c.name)));
  Object.entries(RENAMED_CATEGORIES).forEach(([from, to]) => {
    const old = allCategories.find((c) => key(c.name) === key(from));
    if (!old || existing.has(key(to))) return;
    existing.add(key(to));
    db.collection("categories").doc(old.id).update({ name: to })
      .catch((err) => console.warn("เปลี่ยนชื่อหมวดหมู่ไม่สำเร็จ:", from, err));
  });
  DEFAULT_CATEGORIES.filter((name) => !existing.has(key(name))).forEach((name) => {
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
    if (meter && key !== "Total") meter.style.width = `${pct}%`;
    const chip = document.getElementById(`chip${key}`);
    if (chip && key !== "Total") chip.textContent = `${pct}%`;
  });

  // sidebar badges
  document.getElementById("navCountDocs").textContent = total;
  document.getElementById("navCountCats").textContent = allCategories.length;
  document.getElementById("navCountTrash").textContent = allTrash.length;
}

/* อ่านสีจากตัวแปร CSS โดยตรง กราฟจึงเปลี่ยนตามธีมและสีที่ผู้ใช้ตั้งเองเสมอ */
function chartColors() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  const primary = v("--primary", dark ? "#5B93DD" : "#0B3D91");
  const primaryRgb = v("--primary-rgb", dark ? "91, 147, 221" : "11, 61, 145");
  return {
    text: v("--text-muted", dark ? "#93A9C4" : "#5B7089"),
    grid: v("--border", dark ? "#223B59" : "#D5E3F4"),
    fill: `rgba(${primaryRgb}, ${dark ? 0.18 : 0.12})`,
    primaryRgb,
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
  g.addColorStop(hollow, `rgba(6, 18, 38, ${hollow ? 0 : strength})`);
  g.addColorStop(hollow ? (hollow + 1) / 2 : 0.35, `rgba(6, 18, 38, ${strength})`);
  g.addColorStop(1, "rgba(6, 18, 38, 0)");
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
    ctx.shadowColor = "rgba(6, 18, 38, .35)";
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
  const recent = [...allDocuments].sort((a, b) => createdAtMillis(b) - createdAtMillis(a)).slice(0, 5);
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
  const docSelect = document.getElementById("docCategory");
  const filterSelect = document.getElementById("filterCategory");
  const selected = docSelect.value, filtered = filterSelect.value;
  const opts = allCategories.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join("");
  docSelect.innerHTML = `<option value="">ไม่ระบุหมวดหมู่</option>${opts}`;
  filterSelect.innerHTML = `<option value="">หมวดหมู่ทั้งหมด</option>${opts}`;
  docSelect.value = allCategories.some((c) => c.id === selected) ? selected : "";
  filterSelect.value = allCategories.some((c) => c.id === filtered) ? filtered : "";
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
          <button class="icon-btn" data-del-cat="${escapeHtml(c.id)}" title="ลบหมวดหมู่">
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
  if (!name || document.getElementById("categoryModalOverlay").getAttribute("aria-busy") === "true") return;
  if (allCategories.some((c) => String(c.name).normalize().toLocaleLowerCase("th") === name.normalize().toLocaleLowerCase("th"))) {
    showToast("มีหมวดหมู่นี้แล้ว กรุณาใช้ชื่ออื่น", "error");
    return;
  }
  setModalBusy("categoryModalOverlay", true);
  try {
    await db.collection("categories").add({ name, createdAt: Date.now() });
    showToast("เพิ่มหมวดหมู่แล้ว", "success");
    setModalBusy("categoryModalOverlay", false);
    closeModal("categoryModalOverlay");
  } catch (err) { showToast(err.message, "error"); }
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
/* ข้อความภาษาไทยสำหรับข้อผิดพลาดทั้งจากระบบไฟล์และจาก Firestore */
function friendlyError(err) {
  if (err instanceof PdfApiError) return err.message;
  if (err?.code === "permission-denied") return "ไม่มีสิทธิ์บันทึกหรือแก้ไขข้อมูลเอกสาร";
  if (err?.code === "unavailable") return "เชื่อมต่อฐานข้อมูลไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่";
  return err?.message || String(err);
}

function pdfApiUrl(path) {
  const base = typeof PDF_API_URL === "string" ? PDF_API_URL.trim().replace(/\/+$/, "") : "";
  if (!base) throw new PdfApiError(PDF_API_MESSAGES["not-configured"], "not-configured");
  return base + path;
}
async function currentIdToken() {
  const user = (await databaseReady) && typeof auth !== "undefined" && auth ? auth.currentUser : null;
  if (!user) throw new PdfApiError(PDF_API_MESSAGES.unauthenticated, "unauthenticated");
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
  if (file.type !== PDF_MIME && (file.type || !/\.pdf$/i.test(file.name))) {
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

function openDocModal(doc = null) {
  fileReadVersion++;
  fileReading = false;
  fileInvalid = false;
  setModalBusy("docModalOverlay", false);
  document.getElementById("docForm").reset();
  document.getElementById("docFormError").hidden = true;
  fileInput.value = "";
  pendingFileData = null;
  fileDrop.classList.remove("has-file");
  fileDropText.textContent = `ลากไฟล์ PDF มาวาง หรือคลิกเพื่อเลือกไฟล์ (สูงสุด ${formatFileSize(MAX_FILE_BYTES)})`;

  if (doc) {
    document.getElementById("docModalTitle").textContent = "แก้ไขเอกสาร";
    document.getElementById("docId").value = doc.id;
    document.getElementById("docTitle").value = doc.title || "";
    document.getElementById("docNumber").value = doc.docNumber || "";
    document.getElementById("docDate").value = doc.date || "";
    document.getElementById("docAgency").value = doc.agency || "";
    document.getElementById("docCategory").value = allCategories.some((c) => c.id === doc.category) ? doc.category : "";
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
  if (document.getElementById("docModalOverlay").getAttribute("aria-busy") === "true") return;
  const id = document.getElementById("docId").value;
  const errEl = document.getElementById("docFormError");
  errEl.hidden = true;
  if (fileReading || fileInvalid) {
    errEl.textContent = fileReading ? "กรุณารออ่านไฟล์ให้เสร็จ" : "กรุณาเลือกไฟล์ PDF ที่ถูกต้องก่อนบันทึก";
    errEl.hidden = false;
    return;
  }
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
  if (!payload.title || !payload.docNumber || !payload.date) {
    errEl.textContent = "กรุณากรอกชื่อเอกสาร เลขที่หนังสือ และวันที่ให้ครบถ้วน";
    errEl.hidden = false;
    return;
  }
  const upload = pendingFileData;
  if (!upload && !id) {
    errEl.textContent = "กรุณาแนบไฟล์ PDF";
    errEl.hidden = false;
    return;
  }
  const existing = id ? findDoc(id) : null;

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
      payload.createdBy = auth.currentUser.uid;
      await db.collection("documents").add(payload);
    }
    saved = true;
    showToast(id ? "แก้ไขเอกสารสำเร็จ" : "เพิ่มเอกสารสำเร็จ", "success");
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
  a.download = doc.fileName || `${doc.title}.pdf`;
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
  document.getElementById("previewTitle").textContent = doc.title;
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
   DOCUMENTS TABLE: search, filter, sort, paginate
   ========================================================= */
document.getElementById("globalSearch").addEventListener("input", () => {
  if (!document.getElementById("view-documents").classList.contains("is-active")) switchView("documents");
  currentPage = 1;
  renderDocsTable();
});
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
  th.tabIndex = 0;
  th.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); th.click(); }
  });
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = key; sortDir = "asc"; }
    currentPage = 1;
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
      .some((f) => String(f ?? "").toLowerCase().includes(q));
    const matchesCat = !catFilter || d.category === catFilter;
    const matchesStatus = !statusFilter || d.status === statusFilter;
    const matchesDate = !dateFilter || d.date === dateFilter;
    return matchesQuery && matchesCat && matchesStatus && matchesDate;
  });

  list.sort((a, b) => {
    let av = a[sortKey] ?? "", bv = b[sortKey] ?? "";
    if (sortKey === "category") { av = categoryName(a.category) || ""; bv = categoryName(b.category) || ""; }
    if (sortKey === "size") { av = a.fileSize || 0; bv = b.fileSize || 0; }
    if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv, "th", { numeric: true }) * (sortDir === "asc" ? 1 : -1);
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
    th.setAttribute("aria-sort", th.dataset.sort === sortKey ? (sortDir === "asc" ? "ascending" : "descending") : "none");
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
      <td class="mono">${d.fileSize ? formatFileSize(d.fileSize) : "-"}</td>
      <td>${statusStamp(d.status)}</td>
      <td class="col-actions">
        <div class="row-actions">
          <button class="icon-btn" data-preview="${escapeHtml(d.id)}" title="ดูตัวอย่าง"><svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg></button>
          <button class="icon-btn" data-download="${escapeHtml(d.id)}" title="ดาวน์โหลด"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg></button>
          <button class="icon-btn" data-edit="${escapeHtml(d.id)}" title="แก้ไข"><svg viewBox="0 0 24 24"><path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg></button>
          <button class="icon-btn" data-delete="${escapeHtml(d.id)}" title="ลบ"><svg viewBox="0 0 24 24"><path d="M6 7h12l-1 13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7z"/></svg></button>
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
  let html = `<button data-page="${currentPage - 1}" ${currentPage === 1 ? "disabled" : ""} aria-label="หน้าก่อนหน้า">‹</button>`;
  const pages = [...new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1])].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  let previous = 0;
  for (const i of pages) {
    if (i - previous > 1) html += `<span aria-hidden="true">…</span>`;
    html += `<button class="${i === currentPage ? "is-active" : ""}" data-page="${i}" aria-label="หน้า ${i}" ${i === currentPage ? 'aria-current="page"' : ""}>${i}</button>`;
    previous = i;
  }
  html += `<button data-page="${currentPage + 1}" ${currentPage === totalPages ? "disabled" : ""} aria-label="หน้าถัดไป">›</button>`;
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
function statusStamp(status) {
  const cls = { approved: "stamp-approved", pending: "stamp-pending", rejected: "stamp-rejected" }[status] || "stamp-pending";
  return `<span class="stamp ${cls}">${STATUS_LABEL[status] || "รอดำเนินการ"}</span>`;
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
