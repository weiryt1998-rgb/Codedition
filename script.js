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
   THEME
   ========================================================= */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("govdocs-theme", theme);
}
(function initTheme() {
  const saved = localStorage.getItem("govdocs-theme");
  const preferred = saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(preferred);
})();
document.getElementById("themeToggle").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
  renderCharts(); // repaint chart colors for the new theme
});

/* =========================================================
   TOASTS
   ========================================================= */
function showToast(message, type = "info") {
  const stack = document.getElementById("toastStack");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

/* =========================================================
   APP START — single-user setup, no login screen.
   Signs in anonymously in the background so Firestore rules can
   still require request.auth != null without showing any UI for it.
   ========================================================= */
auth.signInAnonymously()
  .then(() => attachFirestoreListeners())
  .catch((err) => {
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

function switchView(view) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${view}`));
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
function renderStats() {
  document.getElementById("statTotal").textContent = allDocuments.length;
  document.getElementById("statApproved").textContent = allDocuments.filter((d) => d.status === "approved").length;
  document.getElementById("statPending").textContent = allDocuments.filter((d) => d.status === "pending").length;
  document.getElementById("statRejected").textContent = allDocuments.filter((d) => d.status === "rejected").length;
}

function chartColors() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  return {
    text: dark ? "#8FA5C0" : "#5B7089",
    grid: dark ? "#24405F" : "#C7DDF2",
    palette: ["#0B3D91", "#C9A227", "#1E8E5A", "#C13B3B", "#5B93DD", "#8A6DD1"],
  };
}

function renderCharts() {
  if (typeof Chart === "undefined") return;
  const c = chartColors();
  Chart.defaults.font.family = "Sarabun";
  Chart.defaults.color = c.text;

  // --- by category ---
  const catCounts = {};
  allDocuments.forEach((d) => {
    const name = categoryName(d.category) || "ไม่ระบุหมวดหมู่";
    catCounts[name] = (catCounts[name] || 0) + 1;
  });
  paintChart("chartCategory", "bar", {
    labels: Object.keys(catCounts),
    datasets: [{ data: Object.values(catCounts), backgroundColor: c.palette[0], borderRadius: 6, maxBarThickness: 34 }],
  }, { plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { grid: { color: c.grid }, beginAtZero: true, ticks: { precision: 0 } } } });

  // --- by status ---
  const statusCounts = { approved: 0, pending: 0, rejected: 0 };
  allDocuments.forEach((d) => { if (statusCounts[d.status] !== undefined) statusCounts[d.status]++; });
  paintChart("chartStatus", "doughnut", {
    labels: [STATUS_LABEL.approved, STATUS_LABEL.pending, STATUS_LABEL.rejected],
    datasets: [{ data: [statusCounts.approved, statusCounts.pending, statusCounts.rejected], backgroundColor: [c.palette[2], c.palette[1], c.palette[3]], borderWidth: 0 }],
  }, { cutout: "68%", plugins: { legend: { position: "bottom", labels: { boxWidth: 10, padding: 14 } } } });

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
    datasets: [{ data: trendData, borderColor: c.palette[0], backgroundColor: "rgba(11,61,145,0.12)", fill: true, tension: 0.35, pointRadius: 4, pointBackgroundColor: c.palette[0] }],
  }, { plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { grid: { color: c.grid }, beginAtZero: true, ticks: { precision: 0 } } } });
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
  return cat ? cat.name : id;
}
function renderCategoryOptions() {
  const opts = allCategories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  document.getElementById("docCategory").innerHTML = opts || `<option value="">— ยังไม่มีหมวดหมู่ —</option>`;
  document.getElementById("filterCategory").innerHTML = `<option value="">หมวดหมู่ทั้งหมด</option>${opts}`;
}
function renderCategories() {
  const grid = document.getElementById("categoryGrid");
  if (!allCategories.length) {
    grid.innerHTML = `<p class="doc-sub">ยังไม่มีหมวดหมู่ กดปุ่ม “เพิ่มหมวดหมู่” เพื่อเริ่มต้น</p>`;
    return;
  }
  const max = Math.max(1, ...allCategories.map((c) => allDocuments.filter((d) => d.category === c.id).length));
  grid.innerHTML = allCategories.map((c) => {
    const count = allDocuments.filter((d) => d.category === c.id).length;
    return `
      <div class="category-card">
        <span class="cat-name">${escapeHtml(c.name)}</span>
        <span class="cat-count">${count} เอกสาร</span>
        <div class="cat-bar"><span style="width:${(count / max) * 100}%"></span></div>
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

  const hasDocuments = allDocuments.length > 0;
  const hasResults = list.length > 0;
  emptyEl.hidden = hasResults;
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