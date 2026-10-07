/* =========================================================
   เกมปลูกทานตะวันบนป้ายชื่อ
   ไม่รดน้ำแล้วต้นค่อย ๆ เหี่ยวตามเวลาจริง: 5 นาทีเริ่มเฉา 10 นาทีคอตก 15 นาทีสีเริ่มเปลี่ยน
   20 นาทีเหี่ยวมาก ครบ 25 นาทีตาย ต้องกดปลูกใหม่ เมล็ดค่อย ๆ งอกจนบานเต็มที่ใน 13 นาที ระหว่างนั้นก็ต้องรดน้ำ
   สถานะเก็บใน localStorage ของเครื่องนั้นเท่านั้น ไม่แตะ Firestore
   ปิดเกมแล้วนาฬิกาของเกมหยุด ต้นกลับเป็นของประดับที่บานสดเหมือนเดิม เปิดอีกครั้งก็เล่นต่อจากจุดเดิม
   ========================================================= */
const SUNFLOWER_KEY = "govdocs-sunflower";
const SUNFLOWER_MINUTE = 60 * 1000;
const SUNFLOWER_DEAD_AT = 25;    // นาทีหลังรดน้ำครั้งล่าสุด
const SUNFLOWER_BLOOMED_AT = 13; // นาทีหลังปลูก
const SUNFLOWER_WILT_LABELS = ["สดชื่น", "เริ่มเฉา", "คอตก", "สีเริ่มเปลี่ยน", "เหี่ยวมาก", "ตายแล้ว"];
// ขั้นการโต: [นาทีหลังปลูกที่เริ่มขั้นนี้, ชื่อขั้น]
const SUNFLOWER_GROWTH_STAGES = [[0, "เมล็ด"], [2, "ต้นอ่อน"], [5, "กำลังโต"], [9, "ดอกตูม"], [12, "กำลังบาน"], [13, "บานเต็มที่"]];

/* ท่าของต้นเป็นจุด [นาที, ค่า] ค่าระหว่างจุดไล่ต่อเนื่อง ต้นจึงค่อย ๆ เปลี่ยนทีละนิดแทนการกระโดดทีละขั้น
   bend คือก้านโค้ง (องศาที่ปลายก้าน) neck คือคอดอกตกเพิ่มจากก้าน leaf คือใบห้อย colour 0 สด 1 แห้ง petals คือขนาดดอก
   face คือหน้าดอกที่หันลง: ดอกกลมหมุนไปเท่าไรก็ดูเหมือนเดิม จึงบีบดอกให้แบนตามแนวก้าน ให้เห็นเป็นดอกห้อยหน้าคว่ำ */
const SUNFLOWER_WILT = {
  bend: [[5, 0], [10, 4], [15, 10], [20, 16], [25, 28]],
  neck: [[5, 0], [10, 20], [15, 140], [20, 150], [25, 156]],
  face: [[5, 1], [10, 0.85], [15, 0.5], [20, 0.45], [25, 0.42]],
  leaf: [[5, 0], [10, 14], [15, 24], [20, 34], [25, 52]],
  colour: [[15, 0], [20, 0.55], [25, 0.9]],
  petals: [[20, 1], [25, 0.75]],
};
const SUNFLOWER_DEAD = { bend: 34, neck: 152, face: 0.4, leaf: 62, colour: 1, petals: 0.6 };
// stem คือความยาวก้านในหน่วย viewBox (บานเต็มที่ยาว 47) ค่าอื่นเป็นขนาดหรือความทึบ 0 ถึง 1
const SUNFLOWER_GROWTH = {
  stem: [[2, 0], [5, 14], [9, 40], [12, 47]],
  stemWidth: [[2, 1.4], [9, 3.2]],
  seed: [[2, 1], [3, 0]],
  soil: [[4, 1], [6, 0]],
  sprout: [[2, 0], [3, 1], [8, 1], [9, 0]],
  leafRight: [[5, 0], [8, 1]],
  leafLeft: [[6, 0], [9, 1]],
  bud: [[9, 0], [12, 1]],
  budFade: [[12, 1], [13, 0]],
  bloom: [[12, 0.3], [13, 1]],
  bloomFade: [[12, 0], [12.3, 1]],
};
// สีไล่จากสด ผ่านเหลืองซีด ไปน้ำตาลแห้ง: แต่ละ stop ของไล่สีมี [สด, กลาง, แห้ง]
const SUNFLOWER_COLOURS = {
  sunflowerOuter: [["#D98200", "#B86A1C", "#6E4220"], ["#FFC93A", "#E0A548", "#A27443"]],
  sunflowerInner: [["#F2A100", "#C98020", "#80522A"], ["#FFE15A", "#EBC060", "#B48650"]],
  sunflowerDisc: [["#8E5A2A", "#7A5530", "#5C4733"], ["#3F220E", "#3A2412", "#2B2016"]],
  sunflowerLeaf: [["#7CCB63", "#C8C255", "#A88450"], ["#2E7A2E", "#7E8A2C", "#634722"]],
};
const SUNFLOWER_STEM_COLOURS = ["#3E8C36", "#8C8A34", "#7A5E30"];
const SUNFLOWER_VEIN_COLOURS = ["#B4E59A", "#E6E0A0", "#D3BF94"];
const SUNFLOWER_SOIL_COLOURS = [["#8A5A35", "#C7A47A"], ["#5A3820", "#9A7650"]]; // ดินชื้น → ดินแห้ง
// จุดที่ใบติดก้าน (สัดส่วนตามความยาวก้าน) และจุดโคนใบในรูปเดิม ใบขวาห้อยตามเข็มนาฬิกา ใบซ้ายทวนเข็ม
const SUNFLOWER_LEAVES = {
  right: { along: 0.447, base: [32.6, 59], droop: 1, grow: "leafRight" },
  left: { along: 0.234, base: [31.4, 69], droop: -1, grow: "leafLeft" },
};

function sunflowerTrack(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

/* ท่าของต้นจากนาทีที่ไม่ได้รดน้ำ (dry) และนาทีที่โตมาแล้ว (grown) */
function sunflowerPose(dry, grown) {
  const dead = dry >= SUNFLOWER_DEAD_AT;
  const wilt = (key) => (dead ? SUNFLOWER_DEAD[key] : sunflowerTrack(SUNFLOWER_WILT[key], dry));
  const grow = (key) => sunflowerTrack(SUNFLOWER_GROWTH[key], grown);
  const bud = grow("bud");
  return {
    dead, bend: wilt("bend"), neck: wilt("neck"), face: wilt("face"), leafDroop: wilt("leaf"), colour: wilt("colour"),
    petals: wilt("petals"), innerPetals: dead ? 0 : 1, soilDry: Math.min(1, dry / SUNFLOWER_DEAD_AT),
    stem: grow("stem"), stemWidth: grow("stemWidth"), seed: grow("seed"), soil: grow("soil"), sprout: grow("sprout"),
    leafRight: grow("leafRight"), leafLeft: grow("leafLeft"),
    bud, budOpacity: bud > 0 ? grow("budFade") : 0, bloom: grow("bloom"), bloomOpacity: grow("bloomFade"),
  };
}

function sunflowerWiltStage(dry) {
  return Math.min(SUNFLOWER_WILT_LABELS.length - 1, Math.floor(dry / 5));
}
function sunflowerGrowthLabel(grown) {
  return SUNFLOWER_GROWTH_STAGES.filter(([from]) => grown >= from).pop()[1];
}

/* นาทีที่ไม่ได้รดน้ำ และนาทีที่โตมา ตามนาฬิกาของเกม ซึ่งหยุดเดินตอนปิดเกม ต้นที่ตายแล้วไม่โตต่อ */
function sunflowerAges(state, now) {
  const clock = state.on ? now : state.pausedAt;
  const deathAt = state.wateredAt + SUNFLOWER_DEAD_AT * SUNFLOWER_MINUTE;
  return {
    dry: Math.max(0, (clock - state.wateredAt) / SUNFLOWER_MINUTE),
    grown: Math.max(0, (Math.min(clock, deathAt) - state.plantedAt) / SUNFLOWER_MINUTE),
  };
}
function sunflowerStatus({ dry, grown }) {
  if (dry >= SUNFLOWER_DEAD_AT) return "ทานตะวันตายแล้ว กดปลูกใหม่ได้เลย";
  const minutes = Math.floor(dry);
  return [
    grown < SUNFLOWER_BLOOMED_AT ? sunflowerGrowthLabel(grown) : "",
    SUNFLOWER_WILT_LABELS[sunflowerWiltStage(dry)],
    minutes < 1 ? "เพิ่งรดน้ำ" : `รดน้ำล่าสุด ${minutes} นาทีที่แล้ว`,
  ].filter(Boolean).join(" · ");
}

/* เครื่องที่ยังไม่เคยเล่นเริ่มด้วยต้นที่บานเต็มที่และเพิ่งรดน้ำ */
function sunflowerNewGame(now) {
  return { on: true, plantedAt: now - SUNFLOWER_BLOOMED_AT * SUNFLOWER_MINUTE, wateredAt: now, pausedAt: null };
}
function sunflowerSwitched(state, on, now) {
  if (on === state.on) return state;
  if (!on) return { ...state, on: false, pausedAt: now };
  // เลื่อนเวลาที่ปลูกและรดน้ำออกไปเท่าช่วงที่ปิดเกม ต้นจึงอยู่ในสภาพเดิมตอนเปิดกลับมา
  const paused = now - state.pausedAt;
  return { on: true, plantedAt: state.plantedAt + paused, wateredAt: state.wateredAt + paused, pausedAt: null };
}
function sunflowerLoad(now) {
  try {
    const saved = JSON.parse(localStorage.getItem(SUNFLOWER_KEY) || "null");
    const time = (value) => typeof value === "number" && Number.isFinite(value);
    if (saved && typeof saved.on === "boolean" && time(saved.plantedAt) && time(saved.wateredAt)) {
      return { on: saved.on, plantedAt: saved.plantedAt, wateredAt: saved.wateredAt, pausedAt: saved.on ? null : (time(saved.pausedAt) ? saved.pausedAt : now) };
    }
  } catch { /* โหมดส่วนตัวของเบราว์เซอร์อาจอ่านไม่ได้ — เริ่มเกมใหม่ */ }
  return sunflowerNewGame(now);
}
function sunflowerSave(state) {
  try { localStorage.setItem(SUNFLOWER_KEY, JSON.stringify(state)); } catch { /* บันทึกไม่ได้ก็เล่นต่อได้จนปิดหน้า */ }
}

function sunflowerMix(from, to, t) {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const a = rgb(from), b = rgb(to);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(", ")})`;
}
// สีจาก [สด, กลาง, แห้ง] ที่ระดับ t (0 ถึง 1)
function sunflowerShade([fresh, middle, dry], t) {
  return t <= 0.5 ? sunflowerMix(fresh, middle, t * 2) : sunflowerMix(middle, dry, (t - 0.5) * 2);
}
// จุดบนเส้นโค้งเบซิเยร์ของก้าน และมุมของก้านตรงนั้น (องศาจากแนวตั้ง ตามเข็มนาฬิกาเป็นบวก)
function sunflowerPoint([p0, p1, p2, p3], t) {
  const u = 1 - t;
  const at = (i) => u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i];
  const slope = (i) => 3 * u * u * (p1[i] - p0[i]) + 6 * u * t * (p2[i] - p1[i]) + 3 * t * t * (p3[i] - p2[i]);
  const dx = slope(0), dy = slope(1);
  return { x: at(0), y: at(1), angle: dx || dy ? Math.atan2(dx, -dy) * 180 / Math.PI : 0 };
}

/* ส่วนโค้งของวงกลมยาว length เริ่มที่ start หันไปทาง angle (องศาจากแนวตั้ง ตามเข็มนาฬิกาเป็นบวก) แล้วเลี้ยวขวาอีก turn องศา
   คืนจุดของเส้นโค้งเบซิเยร์ที่ใกล้เคียง [start, c1, c2, end] */
function sunflowerArc(start, angle, length, turn) {
  const a0 = angle * Math.PI / 180, a1 = (angle + turn) * Math.PI / 180, sweep = a1 - a0;
  const along = (point, a, distance) => [point[0] + distance * Math.sin(a), point[1] - distance * Math.cos(a)];
  let end = along(start, a0, length), handle = length / 3;
  if (sweep > 0.001) {
    const radius = length / sweep;
    // จุดศูนย์กลางของวงอยู่ทางขวาของทิศที่เริ่ม
    const centre = [start[0] + radius * Math.cos(a0), start[1] + radius * Math.sin(a0)];
    end = [centre[0] - radius * Math.cos(a1), centre[1] - radius * Math.sin(a1)];
    handle = 4 / 3 * Math.tan(sweep / 4) * radius;
  }
  return [start, along(start, a0, handle), along(end, a1, -handle), end];
}

/* วาดท่าลงบน SVG: ก้านโค้งจากโคน (32, 80) ต่อด้วยคอสั้น ๆ ที่งอได้มาก ดอกห้อยอยู่ปลายคอ ใบติดอยู่ตามก้าน */
function sunflowerDraw(svg, pose) {
  const r2 = (value) => Math.round(value * 100) / 100;
  const length = pose.stem, neckLength = length * 9 / 47, mainLength = length - neckLength;
  const curve = sunflowerArc([32, 80], 0, mainLength, pose.bend);
  // ก้านสดคดเล็กน้อยเหมือนรูปเดิม พอโค้งลงก็ค่อย ๆ หายคด
  const wiggle = 1.5 * (length / 47) * Math.max(0, 1 - pose.bend / 15);
  curve[1] = [curve[1][0] - wiggle, curve[1][1]];
  curve[2] = [curve[2][0] + wiggle, curve[2][1]];
  const neck = sunflowerArc(curve[3], pose.bend, neckLength, pose.neck);
  const end = neck[3];
  const stem = svg.querySelector(".sunflower-stem");
  const points = (segment) => segment.slice(1).map((p) => p.map(r2).join(" ")).join(" ");
  stem.setAttribute("d", `M32 80C${points(curve)}C${points(neck)}`);
  stem.setAttribute("stroke-width", r2(pose.stemWidth));
  stem.setAttribute("stroke", sunflowerShade(SUNFLOWER_STEM_COLOURS, pose.colour));
  stem.setAttribute("opacity", length > 0.2 ? 1 : 0);

  svg.querySelectorAll(".sunflower-leaf-at").forEach((group) => {
    const leaf = SUNFLOWER_LEAVES[group.dataset.leaf];
    const point = sunflowerPoint(curve, mainLength > 0 ? Math.min(1, leaf.along * length / mainLength) : 0);
    group.setAttribute("transform", `translate(${r2(point.x)} ${r2(point.y)}) rotate(${r2(point.angle + leaf.droop * pose.leafDroop)}) `
      + `scale(${r2(pose[leaf.grow])}) translate(${-leaf.base[0]} ${-leaf.base[1]})`);
  });
  svg.querySelectorAll(".sunflower-vein").forEach((vein) => vein.setAttribute("stroke", sunflowerShade(SUNFLOWER_VEIN_COLOURS, pose.colour)));

  const around = (x, y, scale) => `translate(${x} ${y}) scale(${r2(scale)}) translate(${-x} ${-y})`;
  // ดอกหน้าตรงติดคอที่ใต้ฐานดอก (32, 33) พอหน้าดอกคว่ำลงจุดที่ติดคอค่อย ๆ เลื่อนไปที่หลังดอก (ขอบกลีบ) ดอกจึงห้อยอยู่ใต้คอ
  const rim = pose.bloomOpacity > 0 ? 25 + 24 * pose.petals * pose.bloom : 33;
  const anchor = 33 + Math.max(0, rim - 33) * Math.min(1, (1 - pose.face) / 0.6);
  svg.querySelector(".sunflower-head-at").setAttribute("transform",
    `translate(${end.map(r2).join(" ")}) rotate(${r2(pose.bend + pose.neck)}) scale(1 ${r2(pose.face)}) translate(-32 ${-r2(anchor)})`);
  const sprout = svg.querySelector(".sunflower-sprout");
  sprout.setAttribute("transform", around(32, 33, pose.sprout));
  sprout.setAttribute("opacity", pose.sprout > 0 ? 1 : 0);
  const bloom = svg.querySelector(".sunflower-bloom");
  bloom.setAttribute("transform", around(32, 25, pose.bloom * pose.petals));
  bloom.setAttribute("opacity", r2(pose.bloomOpacity));
  svg.querySelector(".sunflower-petals-inner").setAttribute("opacity", pose.innerPetals);
  const bud = svg.querySelector(".sunflower-bud");
  bud.setAttribute("transform", around(32, 27, pose.bud));
  bud.setAttribute("opacity", r2(pose.budOpacity));

  svg.querySelector(".sunflower-soil").setAttribute("opacity", r2(pose.soil));
  svg.querySelector(".sunflower-seed").setAttribute("opacity", r2(pose.seed));
  svg.querySelectorAll("#sunflowerSoil stop").forEach((stop, i) => stop.setAttribute("stop-color", sunflowerMix(...SUNFLOWER_SOIL_COLOURS[i], pose.soilDry)));
  Object.entries(SUNFLOWER_COLOURS).forEach(([id, stops]) => {
    svg.querySelectorAll(`#${id} stop`).forEach((stop, i) => stop.setAttribute("stop-color", sunflowerShade(stops[i], pose.colour)));
  });
}

const sunflowerBanner = document.querySelector(".officer-banner");
if (sunflowerBanner) {
  const svg = sunflowerBanner.querySelector(".officer-sunflower");
  const toggle = document.getElementById("sunflowerSwitch");
  const can = document.getElementById("sunflowerCan");
  const replant = document.getElementById("sunflowerReplant");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let state = sunflowerLoad(Date.now());
  sunflowerSave(state); // เครื่องที่เพิ่งเริ่มเล่นต้องจำเวลาไว้ ไม่งั้นโหลดหน้าใหม่ทีไรก็ได้ต้นสดใหม่ทุกครั้ง
  // ตอนรดน้ำ ต้นค่อย ๆ ฟื้นจากท่าเดิม (นาทีที่แห้งอยู่) กลับมาสดระหว่างที่หยดน้ำตก
  let recovery = null;

  const render = () => {
    const ages = state.on ? sunflowerAges(state, Date.now()) : { dry: 0, grown: Infinity };
    let shownDry = ages.dry;
    if (recovery) {
      // รอหยดน้ำแรกตก (ราวหนึ่งในสี่ของเวลา) แล้วค่อย ๆ ฟื้นแบบเร็วตรงกลาง ช้าตอนต้นและตอนจบ
      const progress = (performance.now() - recovery.start) / 1800;
      if (progress >= 1) recovery = null;
      else shownDry = Math.max(shownDry, recovery.from * (progress < 0.25 ? 1 : (1 + Math.cos(Math.PI * (progress - 0.25) / 0.75)) / 2));
    }
    const pose = sunflowerPose(shownDry, ages.grown);
    sunflowerDraw(svg, pose);
    svg.dataset.wilt = sunflowerWiltStage(shownDry);
    toggle.setAttribute("aria-checked", String(state.on));
    sunflowerBanner.classList.toggle("is-game-on", state.on);
    can.hidden = !state.on || pose.dead;
    replant.hidden = !state.on || !pose.dead;
    const status = state.on ? sunflowerStatus(ages) : "";
    can.title = `รดน้ำ · ${status}`;
    replant.title = status;
    if (recovery) requestAnimationFrame(render);
  };
  const update = (next) => {
    state = next;
    sunflowerSave(state);
    render();
  };

  toggle.addEventListener("click", () => {
    // ปิดเกมระหว่างรดน้ำ บัวถูกซ่อนกลางคันจนไม่มี animationend ต้องเอาคลาสออกเอง ไม่งั้นรดน้ำครั้งต่อไปไม่ได้
    sunflowerBanner.classList.remove("is-watering");
    recovery = null;
    update(sunflowerSwitched(state, !state.on, Date.now()));
  });
  can.addEventListener("click", () => {
    const now = Date.now();
    const { dry } = sunflowerAges(state, now);
    if (!state.on || dry >= SUNFLOWER_DEAD_AT || sunflowerBanner.classList.contains("is-watering")) return;
    if (!reducedMotion.matches) {
      recovery = { from: dry, start: performance.now() };
      sunflowerBanner.classList.add("is-watering");
    }
    update({ ...state, wateredAt: now });
  });
  can.addEventListener("animationend", (event) => {
    if (event.target === can) sunflowerBanner.classList.remove("is-watering");
  });
  replant.addEventListener("click", () => {
    const now = Date.now();
    update({ ...state, plantedAt: now, wateredAt: now });
    // ปุ่มปลูกใหม่หายไปแล้ว ส่งโฟกัสต่อให้บัวรดน้ำที่มาแทนที่
    can.focus();
    sunflowerBanner.classList.remove("is-planting");
    void sunflowerBanner.offsetWidth; // ให้แอนิเมชันดินพูนเล่นใหม่ทุกครั้งที่ปลูก
    sunflowerBanner.classList.add("is-planting");
  });
  // เล่นอยู่หลายแท็บ: แท็บอื่นรดน้ำหรือปลูกใหม่ แท็บนี้ก็เห็นตาม
  window.addEventListener("storage", (event) => {
    if (event.key !== SUNFLOWER_KEY) return;
    state = sunflowerLoad(Date.now());
    render();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });
  setInterval(() => { if (state.on && !document.hidden && !recovery) render(); }, 1000);
  render();
}
