/* =========================================================
   เกมปลูกทานตะวันบนป้ายชื่อ
   ไม่รดน้ำแล้วต้นค่อย ๆ เหี่ยวตามเวลาจริง: 5 นาทีเริ่มเฉา 10 นาทีคอตก 15 นาทีสีเริ่มเปลี่ยน
   20 นาทีเหี่ยวมาก ครบ 25 นาทีตาย ต้องกดปลูกใหม่ เมล็ดค่อย ๆ งอกจนบานเต็มที่ใน 13 นาที ระหว่างนั้นก็ต้องรดน้ำ
   สถานะเก็บใน localStorage ของเครื่องนั้นเท่านั้น ไม่แตะ Firestore
   ใส่ปุ๋ยได้ครั้งเดียวตอนที่ต้นยังโตไม่เต็มที่ ต้นจะโตเร็วขึ้น 13 เท่า บานเต็มที่ใน 1 นาทีแทน 13 นาที (ถ้าใส่ตอนปลูก) ไม่ใส่ก็ไม่เป็นอะไร
   ผีเสื้อบินมาตอมเป็นระยะ (วาดด้วย three.js) ตัวที่ตอมอยู่ทำให้ต้นแห้งเร็วขึ้นมาก (ตัวเดียว 10 เท่า สามตัว 28 เท่า) กดหรือแตะที่ตัวเพื่อไล่ให้บินหนีไป
   ผีเสื้อมาเฉพาะตอนที่เปิดเกม ต้นยังไม่ตาย และมองเห็นต้นอยู่บนจอ รดน้ำแล้วความแห้งที่ผีเสื้อทำไว้ก็หายไปด้วย
   ปิดเกมแล้วนาฬิกาของเกมหยุด ต้นกลับเป็นของประดับที่บานสดเหมือนเดิม เปิดอีกครั้งก็เล่นต่อจากจุดเดิม
   ========================================================= */
const SUNFLOWER_KEY = "govdocs-sunflower";
const SUNFLOWER_MINUTE = 60 * 1000;
const SUNFLOWER_DEAD_AT = 25;    // นาทีหลังรดน้ำครั้งล่าสุด
const SUNFLOWER_BLOOMED_AT = 13; // นาทีหลังปลูก
const SUNFLOWER_FERTILIZED_BLOOM = 1; // ใส่ปุ๋ยแล้ว การโตที่เคยใช้ 13 นาทีใช้แค่ 1 นาที
const SUNFLOWER_BUG_MAX = 3;            // ผีเสื้อตอมพร้อมกันได้มากสุด
const SUNFLOWER_BUG_GAPS = [20, 25, 30]; // วินาทีก่อนตัวที่ 1, 2, 3 มา (นับต่อจากตัวก่อน) แล้ววนใหม่
const SUNFLOWER_BUG_BITE = 9;           // ตอมหนึ่งนาที ต้นแห้งเพิ่มกี่นาที ต่อตัว (ตัวเดียวก็เหี่ยวเร็วขึ้น 10 เท่า)
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

/* นาทีที่ไม่ได้รดน้ำ และนาทีที่โตมา ตามนาฬิกาของเกม ซึ่งหยุดเดินตอนปิดเกม ต้นที่ตายแล้วไม่โตต่อ
   fertilizedAt คือเวลาที่ใส่ปุ๋ย (null ถ้ายังไม่ได้ใส่) นับจากนั้นต้นโตเร็วขึ้น 13 เท่า
   bitten คือมิลลิวินาทีที่แห้งเพิ่มเพราะผีเสื้อตอมตั้งแต่รดน้ำครั้งล่าสุด */
function sunflowerAges(state, now) {
  const clock = state.on ? now : state.pausedAt;
  const dryFrom = state.wateredAt - (state.bitten || 0);
  const deathAt = dryFrom + SUNFLOWER_DEAD_AT * SUNFLOWER_MINUTE;
  const growthEnd = Math.min(clock, deathAt);
  // คูณก่อนหาร เวลาหลังใส่ปุ๋ยจึงได้การโตครบ 13 นาทีพอดี ไม่คลาดเพราะเศษทศนิยม
  const boost = state.fertilizedAt == null ? 0
    : Math.max(0, growthEnd - state.fertilizedAt) * (SUNFLOWER_BLOOMED_AT - SUNFLOWER_FERTILIZED_BLOOM) / SUNFLOWER_FERTILIZED_BLOOM;
  return {
    dry: Math.max(0, (clock - dryFrom) / SUNFLOWER_MINUTE),
    grown: Math.max(0, (growthEnd - state.plantedAt + boost) / SUNFLOWER_MINUTE),
  };
}
// bitten เป็นนาที: ความแห้งที่มาจากผีเสื้อไม่นับเป็นเวลาตั้งแต่รดน้ำ
function sunflowerStatus({ dry, grown }, fertilized = false, bitten = 0) {
  if (dry >= SUNFLOWER_DEAD_AT) return "ทานตะวันตายแล้ว กดปลูกใหม่ได้เลย";
  const minutes = Math.floor(Math.max(0, dry - bitten));
  const growing = grown < SUNFLOWER_BLOOMED_AT;
  return [
    growing ? sunflowerGrowthLabel(grown) : "",
    growing && fertilized ? "ใส่ปุ๋ยแล้ว" : "",
    SUNFLOWER_WILT_LABELS[sunflowerWiltStage(dry)],
    minutes < 1 ? "เพิ่งรดน้ำ" : `รดน้ำล่าสุด ${minutes} นาทีที่แล้ว`,
  ].filter(Boolean).join(" · ");
}
/* ใส่ปุ๋ยได้ครั้งเดียวต่อการปลูก และเฉพาะตอนที่ต้นยังมีชีวิตแต่ยังโตไม่เต็มที่ */
function sunflowerCanFertilize(state, { dry, grown }) {
  return state.on && state.fertilizedAt == null && dry < SUNFLOWER_DEAD_AT && grown < SUNFLOWER_BLOOMED_AT;
}
function sunflowerFertilizerHint(state, { dry, grown }) {
  if (dry >= SUNFLOWER_DEAD_AT) return "ทานตะวันตายแล้ว ใส่ปุ๋ยไม่ได้";
  if (grown >= SUNFLOWER_BLOOMED_AT) return "ทานตะวันบานเต็มที่แล้ว ไม่ต้องใส่ปุ๋ย";
  if (state.fertilizedAt != null) return "ใส่ปุ๋ยแล้ว ต้นกำลังโตเร็วขึ้น";
  return `ใส่ปุ๋ย · ต้นจะโตเร็วขึ้น ${SUNFLOWER_BLOOMED_AT / SUNFLOWER_FERTILIZED_BLOOM} เท่า`;
}

/* เครื่องที่ยังไม่เคยเล่นเริ่มด้วยต้นที่บานเต็มที่และเพิ่งรดน้ำ */
function sunflowerNewGame(now) {
  return { on: true, plantedAt: now - SUNFLOWER_BLOOMED_AT * SUNFLOWER_MINUTE, wateredAt: now, fertilizedAt: null, bitten: 0, pausedAt: null };
}
function sunflowerSwitched(state, on, now) {
  if (on === state.on) return state;
  if (!on) return { ...state, on: false, pausedAt: now };
  // เลื่อนเวลาที่ปลูก รดน้ำ และใส่ปุ๋ยออกไปเท่าช่วงที่ปิดเกม ต้นจึงอยู่ในสภาพเดิมตอนเปิดกลับมา
  const paused = now - state.pausedAt;
  return {
    on: true, plantedAt: state.plantedAt + paused, wateredAt: state.wateredAt + paused,
    fertilizedAt: state.fertilizedAt == null ? null : state.fertilizedAt + paused, bitten: state.bitten || 0, pausedAt: null,
  };
}
function sunflowerLoad(now) {
  try {
    const saved = JSON.parse(localStorage.getItem(SUNFLOWER_KEY) || "null");
    const time = (value) => typeof value === "number" && Number.isFinite(value);
    if (saved && typeof saved.on === "boolean" && time(saved.plantedAt) && time(saved.wateredAt)) {
      return {
        on: saved.on, plantedAt: saved.plantedAt, wateredAt: saved.wateredAt, fertilizedAt: time(saved.fertilizedAt) ? saved.fertilizedAt : null,
        bitten: time(saved.bitten) && saved.bitten > 0 ? saved.bitten : 0,
        pausedAt: saved.on ? null : (time(saved.pausedAt) ? saved.pausedAt : now),
      };
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

/* ผีเสื้อวาดด้วย three.js ซึ่งโหลดจาก CDN ตอนที่เปิดเกมและมองเห็นต้นครั้งแรก (โหลดแบบเดียวกับ PDF.js ใน script.js)
   โหลดไม่ได้หรือเครื่องไม่มี WebGL ก็แค่ไม่มีผีเสื้อมา ส่วนอื่นของเกมเล่นได้ตามปกติ */
const SUNFLOWER_THREE = "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.min.js";
const SUNFLOWER_VIEW_TILT = 0.75; // มองผีเสื้อจากด้านข้างค่อนลงมาจากข้างบน (เรเดียน) จึงเห็นทั้งหลังปีกตอนกาง และปีกที่หุบตั้งขึ้นตอนเกาะ
// ลายปีกสามแบบ สุ่มให้แต่ละตัว: wing คือสีโคนปีกไล่ไปปลายปีก edge คือขอบปีกสีเข้ม dots คือจุดบนขอบ tip คือแต้มสีที่ปลายปีกหน้า
const SUNFLOWER_BUTTERFLY_KINDS = [
  // ส้มลายดำ แบบผีเสื้อจักรพรรดิ
  { wing: ["#E8590C", "#FFB238"], vein: "#1A1210", veinWidth: 0.4, edge: "#1A1210", edgeWidth: 1.4, dots: "#FFF4DC", body: "#2B1D17" },
  // เหลืองปลายปีกดำ
  { wing: ["#F0B000", "#FFE760"], vein: "rgba(120, 78, 0, .4)", veinWidth: 0.3, edge: "#22180E", edgeWidth: 0.9, tip: "#22180E", spots: "#FFE760", body: "#3A2D18" },
  // ฟ้าเหลือบ
  { wing: ["#0C2A86", "#3FC4FF"], vein: "rgba(6, 16, 56, .55)", veinWidth: 0.3, edge: "#0A0E22", edgeWidth: 1.4, dots: "#EAF7FF", body: "#141A30" },
];
// ขอบปีกข้างหนึ่ง หัวไปทาง +x ปีกกางออกทาง +y หน่วยละหนึ่งพิกเซลที่ขนาดปกติ: จุดเริ่มที่โคนปีก ตามด้วยเส้นโค้งเบซิเยร์ [c1x, c1y, c2x, c2y, x, y]
const SUNFLOWER_WINGS = {
  fore: [[1.2, 0.4], [3.2, 3.5, 6.4, 8.5, 6.6, 12.6], [5.2, 14, 1.5, 13.6, -1, 11.6], [-2.6, 10.2, -3.2, 6, -2.6, 3.4], [-2, 1.8, -0.8, 0.6, 1.2, 0.4]],
  hind: [[0.2, 0.5], [-0.6, 3.6, -1.6, 7.6, -4.4, 9], [-7.4, 10.2, -10.2, 7.8, -10, 4.6], [-9.8, 2.2, -6, 0.6, 0.2, 0.5]],
};

/* ระบายลายปีกลง canvas ที่จะเป็น texture ของปีก: ด้านกว้างของ texture คือกรอบของปีกตามแกน x ด้านสูงตามแกน y แบบเดียวกับ uv ของรูปทรงปีก
   points คือจุดเรียงตามขอบปีก ใช้วางเส้นปีกกับจุดบนขอบ */
function sunflowerPaintWing(outline, points, box, kind, fore) {
  const size = 128, canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const w = box.max.x - box.min.x, h = box.max.y - box.min.y;
  ctx.setTransform(size / w, 0, 0, -size / h, -box.min.x * size / w, box.max.y * size / h);
  const path = new Path2D();
  path.moveTo(...outline[0]);
  outline.slice(1).forEach((curve) => path.bezierCurveTo(...curve));
  path.closePath();
  const far = (p) => Math.hypot(p.x, p.y), reach = Math.max(...points.map(far));
  // นอกปีกทาสีขอบไว้ด้วย ริมปีกที่ texture เกลี่ยสีจะได้ไม่ติดสีอื่นมา
  ctx.fillStyle = kind.edge;
  ctx.fillRect(box.min.x, box.min.y, w, h);
  ctx.save();
  ctx.clip(path);
  const colour = ctx.createRadialGradient(0, 0, 0, 0, 0, reach);
  colour.addColorStop(0, kind.wing[0]);
  colour.addColorStop(1, kind.wing[1]);
  ctx.fillStyle = colour;
  ctx.fillRect(box.min.x, box.min.y, w, h);
  const root = ctx.createRadialGradient(0, 0, 0, 0, 0, reach * 0.35);
  root.addColorStop(0, "rgba(0, 0, 0, .4)");
  root.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = root;
  ctx.fillRect(box.min.x, box.min.y, w, h);
  // เส้นปีกแผ่จากโคนปีกไปที่ขอบนอก
  ctx.strokeStyle = kind.vein;
  ctx.lineWidth = kind.veinWidth;
  points.filter((p, i) => i % 4 === 0 && far(p) > reach * 0.55).forEach((p) => {
    ctx.beginPath();
    ctx.moveTo(p.x * 0.08, p.y * 0.08);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });
  if (kind.tip && fore) {
    // ปลายปีกหน้าสีเข้ม มีจุดสีปีกสองจุด
    const apex = points.reduce((a, p) => (far(p) > far(a) ? p : a)), ux = apex.x / far(apex), uy = apex.y / far(apex);
    ctx.fillStyle = kind.tip;
    ctx.beginPath();
    ctx.arc(apex.x, apex.y, 4.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = kind.spots;
    [[2.4, 1.2], [2.2, -1.4]].forEach(([back, side]) => {
      ctx.beginPath();
      ctx.arc(apex.x - ux * back - uy * side, apex.y - uy * back + ux * side, 0.75, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  ctx.strokeStyle = kind.edge;
  ctx.lineWidth = kind.edgeWidth * 2; // ครึ่งหนึ่งของเส้นอยู่นอกปีกซึ่งถูกตัดทิ้ง
  ctx.stroke(path);
  if (kind.dots) {
    ctx.fillStyle = kind.dots;
    points.filter((p, i) => i % 2 === 0 && far(p) > reach * 0.5).forEach((p) => {
      const inset = 1 - kind.edgeWidth * 0.5 / far(p);
      ctx.beginPath();
      ctx.arc(p.x * inset, p.y * inset, 0.32, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  ctx.restore();
  return canvas;
}

/* ฉาก three.js บน canvas ของผีเสื้อ: กล้องมุมฉาก (orthographic) หน่วยละหนึ่งพิกเซล CSS แกน y ชี้ขึ้น ผีเสื้อที่ (x, y) บน canvas จึงอยู่ที่ (x, -y)
   ผีเสื้อแต่ละตัวมีท้อง อก หัว หนวด และปีกสี่ชิ้นที่กระพือรอบแนวลำตัว ในตัวผีเสื้อหัวไปทาง +x หลังอยู่ทาง +y ปีกกางออกทาง ±z
   สร้าง WebGL ไม่ได้ (เครื่องเก่า ปิดการ์ดจอไว้) ก็โยนข้อผิดพลาดออกไป ผู้เรียกจะไม่ปล่อยผีเสื้อมา */
function sunflowerButterflyStage(THREE, canvas) {
  // เก็บภาพล่าสุดไว้ ชุดทดสอบจึงอ่านพิกเซลได้
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, 1, 0, -1, 1, 600);
  camera.position.z = 300;
  scene.add(new THREE.AmbientLight(0xffffff, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(0.3, 1, 0.8);
  scene.add(sun);

  // ชิ้นส่วนที่ผีเสื้อทุกตัวใช้ร่วมกัน: รูปทรงปีกซ้ายขวา ลายปีกของแต่ละแบบ ทรงกลมสำหรับตัว และเส้นหนวด
  const shapes = {}, textures = {};
  Object.entries(SUNFLOWER_WINGS).forEach(([part, outline]) => {
    const shape = new THREE.Shape();
    shape.moveTo(...outline[0]);
    outline.slice(1).forEach((curve) => shape.bezierCurveTo(...curve));
    const flat = new THREE.ShapeGeometry(shape, 12);
    flat.computeBoundingBox();
    const box = flat.boundingBox, position = flat.attributes.position, uv = flat.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (position.getX(i) - box.min.x) / (box.max.x - box.min.x), (position.getY(i) - box.min.y) / (box.max.y - box.min.y));
    }
    // ปีกข้างหนึ่งกางไปทาง +z อีกข้างไปทาง -z ปีกหลังต่ำกว่าปีกหน้านิดเดียว ตรงที่ซ้อนกันปีกหน้าจึงอยู่บน
    const drop = part === "hind" ? -0.06 : 0;
    shapes[part] = { 1: flat.clone().rotateX(Math.PI / 2).translate(0, drop, 0), [-1]: flat.clone().rotateX(-Math.PI / 2).translate(0, drop, 0) };
    const points = shape.getSpacedPoints(64);
    textures[part] = SUNFLOWER_BUTTERFLY_KINDS.map((kind) => {
      const texture = new THREE.CanvasTexture(sunflowerPaintWing(outline, points, box, kind, part === "fore"));
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    });
  });
  const ball = new THREE.SphereGeometry(1, 12, 8);
  // หนวดโค้งไปข้างหน้าแล้วชี้ขึ้น ปลายหนวดเป็นตุ่ม
  const feelers = [1, -1].map((side) => new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(2.7, 0.8, side * 0.4), new THREE.Vector3(4.6, 1.4, side * 1), new THREE.Vector3(6.6, 4, side * 2)));
  const feelerLines = feelers.map((curve) => new THREE.BufferGeometry().setFromPoints(curve.getPoints(8)));

  let size = "";
  return {
    make(index) {
      const kind = SUNFLOWER_BUTTERFLY_KINDS[index];
      // วัสดุแยกของแต่ละตัว จางเข้าจางออกได้ไม่กระทบตัวอื่น (ลาย texture ยังใช้ร่วมกัน)
      const wing = (part) => new THREE.MeshLambertMaterial({ map: textures[part][index], side: THREE.DoubleSide, transparent: true });
      const fore = wing("fore"), hind = wing("hind");
      const body = new THREE.MeshLambertMaterial({ color: kind.body, transparent: true });
      const line = new THREE.LineBasicMaterial({ color: kind.body, transparent: true });
      const group = new THREE.Group();
      // ท้องยาว อก หัว แล้วตุ่มปลายหนวด
      [[[4.2, 0.95, 0.95], [-4, 0, 0]], [[1.9, 1.3, 1.3], [-0.1, 0.1, 0]], [[1, 1, 1], [2.1, 0.25, 0]],
        ...feelers.map((curve) => [[0.45, 0.45, 0.45], curve.v2.toArray()])].forEach(([scale, at]) => {
        const part = new THREE.Mesh(ball, body);
        part.scale.set(...scale);
        part.position.set(...at);
        group.add(part);
      });
      feelerLines.forEach((geometry) => group.add(new THREE.Line(geometry, line)));
      const wings = [];
      [1, -1].forEach((side) => [["fore", fore], ["hind", hind]].forEach(([part, material]) => {
        const mesh = new THREE.Mesh(shapes[part][side], material);
        group.add(mesh);
        wings.push({ mesh, side, hind: part === "hind" });
      }));
      scene.add(group);
      return { group, wings, materials: [fore, hind, body, line] };
    },
    remove({ group, materials }) {
      scene.remove(group);
      materials.forEach((material) => material.dispose());
    },
    // วางผีเสื้อตามตำแหน่ง ทิศที่หัน และมุมยกปีก (0 คือกางแบน ราว 1.5 คือหุบตั้งขึ้น)
    pose(butterfly) {
      const { group, wings, materials } = butterfly.model;
      group.position.set(butterfly.x, -(butterfly.y + butterfly.bob), butterfly.layer);
      group.rotation.set(SUNFLOWER_VIEW_TILT, butterfly.yaw, butterfly.pitch);
      group.scale.setScalar(butterfly.size);
      wings.forEach(({ mesh, side, hind }) => { mesh.rotation.x = -side * (hind ? butterfly.liftHind : butterfly.lift); });
      materials.forEach((material) => { material.opacity = Math.max(0, Math.min(1, butterfly.alpha)); });
    },
    render(width, height) {
      const dpr = window.devicePixelRatio || 1, next = `${width}x${height}@${dpr}`;
      if (next !== size) {
        size = next;
        renderer.setPixelRatio(dpr);
        renderer.setSize(width, height, false);
        camera.right = width;
        camera.bottom = -height;
        camera.updateProjectionMatrix();
      }
      renderer.render(scene, camera);
    },
  };
}

/* ฝูงผีเสื้อบน canvas ที่คลุมรอบต้น
   canvas ไม่รับเมาส์ (กดทะลุไปที่สวิตช์ ถุงปุ๋ย บัว และเมนูได้ตามปกติ) การไล่จึงดักที่ pointerdown ของทั้งหน้าแล้ววัดระยะถึงผีเสื้อเอง
   active() บอกว่าต้นให้ผีเสื้อตอมได้ไหม (on) และมองเห็นต้นอยู่ไหม (seen) onBite(ms) รับความแห้งที่เพิ่ม
   ผีเสื้อบินพลิ้วมาจากขอบซ้ายหรือขวา เลือกส่วนของต้นที่จะตอม (ดอกมากสุด) บินวนอยู่ตรงนั้นสลับกับลงเกาะหุบกางปีกช้า ๆ
   ตัวที่วนหรือเกาะอยู่ที่ต้นเท่านั้นที่ทำให้ต้นแห้ง กดหรือแตะโดนตัวไหน ตัวนั้นตกใจบินหนีไป
   ต้นตายหรือปิดเกม ผีเสื้อบินจากไปเอง มองไม่เห็นต้น (แท็บซ่อน เมนูมือถือปิด เลื่อนพ้นจอ) ทุกอย่างหยุดรอ
   ไม่มีผีเสื้อก็ไม่วาดอะไรเลย ไม่เปลือง requestAnimationFrame */
function sunflowerBugs(canvas, svg, { active, onBite, reducedMotion }) {
  const area = canvas.closest(".sidebar") || canvas.parentElement;
  const spots = [
    [".sunflower-bloom", 3], [".sunflower-bud", 2], [".sunflower-sprout", 2],
    ['.sunflower-leaf-at[data-leaf="right"]', 1], ['.sunflower-leaf-at[data-leaf="left"]', 1], [".sunflower-soil", 1],
  ];
  let butterflies = [], frame = 0, last = 0, swallowClickUntil = 0, spawned = 0;
  let gap = 0, wait = SUNFLOWER_BUG_GAPS[0] * 1000;
  let stage = null, loading = null, lost = false;
  const ready = () => Boolean(stage) && !lost;

  // ส่วนของต้นในพิกัดของ canvas ส่วนที่จางหรือยังไม่งอกนับว่าไม่มี
  const spotRect = (selector, origin) => {
    const el = svg.querySelector(selector);
    const opacity = el && el.getAttribute("opacity");
    if (!el || (opacity !== null && Number(opacity) < 0.3)) return null;
    const r = el.getBoundingClientRect();
    return r.width > 3 && r.height > 3 ? { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height } : null;
  };
  const pick = (origin) => {
    const options = spots.filter(([selector]) => spotRect(selector, origin));
    let roll = Math.random() * options.reduce((sum, [, weight]) => sum + weight, 0);
    const spot = options.find(([, weight]) => (roll -= weight) < 0) || options[0];
    return spot ? spot[0] : null;
  };
  // จุดที่ผีเสื้อตอม ตามส่วนของต้นที่กำลังไหวหรือโตอยู่ ส่วนนั้นหายไป (ดอกตูมกลายเป็นดอกบาน) ก็เลือกส่วนใหม่
  const anchorOf = (butterfly, origin) => {
    if (butterfly.at) return butterfly.at;
    let rect = butterfly.spot && spotRect(butterfly.spot, origin);
    if (!rect) {
      butterfly.spot = pick(origin);
      rect = butterfly.spot && spotRect(butterfly.spot, origin);
    }
    return rect ? { x: rect.x + rect.w * butterfly.fx, y: rect.y + rect.h * butterfly.fy } : null;
  };
  const pestering = (butterfly) => butterfly.state === "arrive" || butterfly.state === "flutter" || butterfly.state === "perch";

  // ขยับผีเสื้อหนึ่งตัวไปหนึ่งเฟรม คืนค่าว่ากำลังตอมต้นอยู่ไหม (บินวนหรือเกาะอยู่ที่ต้น)
  const move = (butterfly, dt, on, origin) => {
    const calm = reducedMotion.matches;
    butterfly.t += dt;
    const x0 = butterfly.x, y0 = butterfly.y;
    if (pestering(butterfly) && !on) butterfly.state = "leave";
    const anchor = pestering(butterfly) ? anchorOf(butterfly, origin) : null;
    if (pestering(butterfly) && !anchor) butterfly.state = "leave";
    if (pestering(butterfly)) butterfly.alpha = Math.min(1, butterfly.alpha + dt * 2.5);
    let landed = false;
    if (butterfly.state === "arrive") {
      const dx = anchor.x - butterfly.x, dy = anchor.y - butterfly.y, distance = Math.hypot(dx, dy);
      if (distance < 8) butterfly.state = "flutter";
      else {
        // บินเข้าหาต้นเป็นลูกคลื่น ส่ายไปมากว้าง ๆ
        const ux = dx / distance, uy = dy / distance, sway = Math.sin(butterfly.t * 2.6 + butterfly.phase) * 34;
        butterfly.x += (ux * 75 - uy * sway) * dt;
        butterfly.y += (uy * 75 + ux * sway) * dt;
      }
    }
    if (butterfly.state === "flutter") {
      // วนเป็นวงรีหลวม ๆ เหนือจุดที่ตอม ครบเวลาแล้วลงเกาะ
      butterfly.angle += dt * (1.9 + 0.8 * Math.sin(butterfly.t * 0.7 + butterfly.phase));
      const r = 13 + 5 * Math.sin(butterfly.t * 1.1 + butterfly.phase), follow = Math.min(1, dt * 3.5);
      butterfly.x += (anchor.x + Math.cos(butterfly.angle) * r * 1.3 - butterfly.x) * follow;
      butterfly.y += (anchor.y - 6 + Math.sin(butterfly.angle * 1.6) * r * 0.6 - butterfly.y) * follow;
      if ((butterfly.timer -= dt) <= 0) Object.assign(butterfly, { state: "perch", timer: 2 + Math.random() * 2.5 });
    } else if (butterfly.state === "perch") {
      // ร่อนลงที่จุดที่ตอม ถึงแล้วเกาะติดไปกับต้นที่ไหวอยู่ ครบเวลาแล้วบินวนต่อ บางทีก็ย้ายไปตอมส่วนอื่นของต้น
      const dx = anchor.x - butterfly.x, dy = anchor.y - butterfly.y;
      landed = butterfly.pinned || Math.hypot(dx, dy) < 3;
      if (landed) { butterfly.x = anchor.x; butterfly.y = anchor.y; }
      else {
        const follow = Math.min(1, dt * 4);
        butterfly.x += dx * follow;
        butterfly.y += dy * follow;
      }
      if (!butterfly.pinned && (butterfly.timer -= dt) <= 0) {
        Object.assign(butterfly, { state: "flutter", timer: 3 + Math.random() * 3 });
        if (Math.random() < 0.4) Object.assign(butterfly, { spot: null, fx: 0.2 + Math.random() * 0.6, fy: 0.2 + Math.random() * 0.6 });
      }
    }
    if (butterfly.state === "leave" || butterfly.state === "scared") {
      if (calm) {
        // คนที่ขอลดการเคลื่อนไหว: ค่อย ๆ จางหายไปตรงที่อยู่ ไม่บินข้ามจอ
        butterfly.alpha -= dt * 2;
        if (butterfly.alpha <= 0) butterfly.gone = true;
      } else {
        let ux, uy, speed;
        if (butterfly.state === "leave") {
          const dx = butterfly.home - butterfly.x, dy = -50 - butterfly.y, distance = Math.hypot(dx, dy) || 1;
          [ux, uy, speed] = [dx / distance, dy / distance, 110];
        } else {
          // ตกใจ: เร่งความเร็วหนีออกจากจุดที่โดนกด
          butterfly.speed = Math.min(300, butterfly.speed + 700 * dt);
          [ux, uy, speed] = [...butterfly.away, butterfly.speed];
        }
        const sway = Math.sin(butterfly.t * (butterfly.state === "scared" ? 9 : 2.6) + butterfly.phase) * 0.3;
        butterfly.x += (ux - uy * sway) * speed * dt;
        butterfly.y += (uy + ux * sway) * speed * dt;
        if (butterfly.x < -40 || butterfly.x > origin.width + 40 || butterfly.y < -40 || butterfly.y > origin.height + 40) butterfly.gone = true;
      }
    }

    // หันหัวไปทางที่บิน ตอนกลับทิศก็ค่อย ๆ หมุนตัวผ่านด้านหลัง เชิดหัวตอนบินขึ้น ก้มหัวตอนบินลง
    const vx = dt ? (butterfly.x - x0) / dt : 0, vy = dt ? (butterfly.y - y0) / dt : 0;
    if (!landed && Math.abs(vx) > 6) butterfly.facing = Math.sign(vx);
    const pitch = landed ? 0.3 : Math.max(-0.5, Math.min(0.6, Math.atan2(-vy, Math.abs(vx) + 25)));
    const turn = Math.min(1, dt * 4);
    butterfly.yaw += ((butterfly.facing > 0 ? butterfly.turn : Math.PI - butterfly.turn) - butterfly.yaw) * turn;
    butterfly.pitch += (pitch - butterfly.pitch) * turn;
    // ปีก: บินอยู่กระพือเร็วสลับกับร่อน เกาะอยู่หุบกางช้า ๆ ตกใจกระพือถี่ ปีกหลังตามปีกหน้าช้านิดหนึ่ง ตัวโยนขึ้นลงตามจังหวะปีก
    butterfly.rest += ((landed ? 1 : 0) - butterfly.rest) * Math.min(1, dt * 5);
    const scared = butterfly.state === "scared", rate = scared ? 70 : 38 + 6 * Math.sin(butterfly.t * 0.9 + butterfly.phase);
    butterfly.beat += dt * (rate * (1 - butterfly.rest) + 2.4 * butterfly.rest);
    const glide = scared ? 1 : 0.4 + 0.6 * Math.min(1, Math.max(0, 0.5 + 1.5 * Math.sin(butterfly.t * 1.5 + butterfly.phase)));
    const lift = (lag) => (0.5 + 0.85 * glide * Math.sin(butterfly.beat - lag)) * (1 - butterfly.rest)
      + (0.85 + 0.6 * Math.sin(butterfly.beat - lag)) * butterfly.rest;
    butterfly.lift = calm ? 0.6 : lift(0);
    butterfly.liftHind = calm ? 0.55 : lift(0.35) * 0.95;
    butterfly.bob = calm ? 0 : -Math.sin(butterfly.beat + 1.2) * 1.4 * (1 - butterfly.rest);
    return butterfly.state === "flutter" || butterfly.state === "perch";
  };

  const step = (time) => {
    // ระหว่างเฟรมนี้ onBite วาดต้นใหม่ซึ่งเรียก wake() ต้องไม่เริ่มวงวาดซ้อนอีกวง
    frame = -1;
    const { on, seen } = active();
    if (!seen || !ready()) { frame = 0; last = 0; return; }
    const dt = last ? Math.min(0.1, (time - last) / 1000) : 0;
    last = time;
    const origin = canvas.getBoundingClientRect();
    let biting = 0;
    butterflies.forEach((butterfly) => {
      if (move(butterfly, dt, on, origin) && on && butterfly.alpha > 0.5) biting++;
    });
    butterflies = butterflies.filter((butterfly) => {
      if (butterfly.gone) stage.remove(butterfly.model);
      return !butterfly.gone;
    });
    if (biting) onBite(dt * 1000 * SUNFLOWER_BUG_BITE * biting);
    butterflies.forEach((butterfly) => stage.pose(butterfly));
    stage.render(origin.width, origin.height); // ตัวสุดท้ายไปแล้วก็วาดอีกครั้งเพื่อล้างภาพ
    if (butterflies.length) frame = requestAnimationFrame(step);
    else { frame = 0; last = 0; }
  };
  const wake = () => {
    if (!frame && butterflies.length && ready() && active().seen) frame = requestAnimationFrame(step);
  };

  // โหลด three.js ครั้งเดียวต่อการเปิดหน้า และรอให้หน้าเว็บโหลดเสร็จก่อน ไม่แย่งเน็ตกับตอนเปิดหน้า
  const prepare = () => {
    if (loading) return;
    const pageLoaded = document.readyState === "complete" ? Promise.resolve()
      : new Promise((resolve) => window.addEventListener("load", resolve, { once: true }));
    loading = pageLoaded.then(() => import(SUNFLOWER_THREE)).then((THREE) => {
      stage = sunflowerButterflyStage(THREE, canvas);
      wake();
    }).catch(() => { /* เน็ตหลุด CDN ถูกบล็อก หรือไม่มี WebGL — ไม่มีผีเสื้อมาตอม */ });
  };
  // การ์ดจอรีเซ็ตแล้วภาพผีเสื้อหายหมด ผีเสื้อก็ต้องหายไปด้วย จะได้ไม่มีตัวที่มองไม่เห็นแต่ยังตอมอยู่ (three.js กู้ฉากคืนเองเมื่อได้ WebGL คืน)
  canvas.addEventListener("webglcontextlost", () => {
    lost = true;
    butterflies.forEach((butterfly) => stage.remove(butterfly.model));
    butterflies = [];
  });
  canvas.addEventListener("webglcontextrestored", () => { lost = false; });

  // at (พิกัดบนจอ) ให้ผีเสื้อเกาะนิ่งที่จุดนั้นทันที ใช้ในชุดทดสอบ ส่วนคนที่ขอลดการเคลื่อนไหว ผีเสื้อค่อย ๆ โผล่ที่ต้นแล้วเกาะนิ่ง
  const spawn = (at) => {
    if (!ready()) return;
    const origin = canvas.getBoundingClientRect();
    const fromLeft = Math.random() < 0.5, turn = (Math.random() - 0.5) * 0.9;
    const butterfly = {
      state: "arrive", t: 0, phase: Math.random() * Math.PI * 2, beat: Math.random() * Math.PI * 2, angle: Math.random() * Math.PI * 2,
      x: fromLeft ? -16 : origin.width + 16, y: origin.height * (0.3 + Math.random() * 0.3), home: fromLeft ? -50 : origin.width + 50,
      fx: 0.2 + Math.random() * 0.6, fy: 0.2 + Math.random() * 0.6, spot: null, at: null, pinned: false, timer: 2.5 + Math.random() * 2.5,
      alpha: 1, rest: 0, lift: 0.5, liftHind: 0.5, bob: 0, speed: 0, away: [0, -1],
      // turn เอียงตัวเข้าหาหรือออกจากจอเล็กน้อย ให้เห็นเป็นสามมิติ layer แยกความลึกของแต่ละตัวไม่ให้ปีกทะลุกัน
      facing: fromLeft ? 1 : -1, turn, yaw: fromLeft ? turn : Math.PI - turn, pitch: 0, size: 1.05 + Math.random() * 0.25,
      layer: [0, -36, 36, -72, 72][spawned++ % 5], kind: Math.floor(Math.random() * SUNFLOWER_BUTTERFLY_KINDS.length),
    };
    if (at) butterfly.at = { x: at.x - origin.left, y: at.y - origin.top };
    if (at || reducedMotion.matches) {
      const anchor = anchorOf(butterfly, origin);
      if (!anchor) return;
      Object.assign(butterfly, { state: "perch", x: anchor.x, y: anchor.y, alpha: 0, pinned: true, rest: 1 });
    }
    butterfly.model = stage.make(butterfly.kind);
    butterflies.push(butterfly);
    wake();
  };
  // เรียกทุกวินาที: เปิดเกมและเห็นต้นครั้งแรกก็เริ่มโหลด three.js นับเวลาเฉพาะตอนที่ผีเสื้อมาได้ ครบแล้วปล่อยตัวใหม่
  const tick = (ms) => {
    const { on, seen } = active();
    if (on && seen) prepare();
    if (ready() && on && seen && butterflies.filter(pestering).length < SUNFLOWER_BUG_MAX) {
      wait -= ms;
      if (wait <= 0) {
        gap = (gap + 1) % SUNFLOWER_BUG_GAPS.length;
        wait = SUNFLOWER_BUG_GAPS[gap] * 1000;
        spawn();
      }
    }
    wake();
  };

  document.addEventListener("pointerdown", (event) => {
    if (!butterflies.length) return;
    // มีหน้าต่างหรือฉากมืดบังแถบเมนูอยู่ ผีเสื้อข้างใต้ไล่ไม่ได้
    const top = document.elementFromPoint(event.clientX, event.clientY);
    if (!top || !area.contains(top)) return;
    const origin = canvas.getBoundingClientRect();
    const x = event.clientX - origin.left, y = event.clientY - origin.top;
    let target = null, best = event.pointerType === "touch" ? 24 : 16; // นิ้วใหญ่กว่าเมาส์ ให้ระยะเผื่อมากกว่า
    butterflies.forEach((butterfly) => {
      const distance = Math.hypot(butterfly.x - x, butterfly.y - y);
      if (pestering(butterfly) && butterfly.alpha > 0.3 && distance < best) { target = butterfly; best = distance; }
    });
    if (!target) return;
    // กดนี้เป็นของผีเสื้อ ไม่ให้ทะลุไปโดนปุ่มหรือเมนูที่อยู่ข้างใต้ (click ตามมาทีหลังเสมอ ต้องกลืนทิ้งด้วย)
    event.preventDefault();
    event.stopPropagation();
    swallowClickUntil = performance.now() + 800;
    // หนีออกจากจุดที่กด แต่ขึ้นข้างบนเสมอ (ทำมุมอย่างน้อย 45 องศา) กดเหนือตัวแล้วจะไม่บินลงไปถูกขอบล่างของ canvas ตัดทิ้งกลางป้ายชื่อ
    const dx = target.x - x, dy = Math.min(target.y - y - 12, -Math.abs(target.x - x) - 4), length = Math.hypot(dx, dy);
    Object.assign(target, { state: "scared", speed: 120, away: [dx / length, dy / length] });
    wake();
  }, true);
  document.addEventListener("click", (event) => {
    if (performance.now() > swallowClickUntil) return;
    swallowClickUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  return {
    tick, wake, spawn, prepare, ready,
    count: () => butterflies.filter(pestering).length,
    // ตำแหน่งบนจอของผีเสื้อแต่ละตัว สำหรับชุดทดสอบ
    butterflies: () => {
      const origin = canvas.getBoundingClientRect();
      return butterflies.map((butterfly) => ({ state: butterfly.state, x: origin.left + butterfly.x, y: origin.top + butterfly.y }));
    },
  };
}

const sunflowerBanner = document.querySelector(".officer-banner");
if (sunflowerBanner) {
  const svg = sunflowerBanner.querySelector(".officer-sunflower");
  const toggle = document.getElementById("sunflowerSwitch");
  const can = document.getElementById("sunflowerCan");
  const replant = document.getElementById("sunflowerReplant");
  const fertilizer = document.getElementById("sunflowerFertilizer");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let state = sunflowerLoad(Date.now());
  sunflowerSave(state); // เครื่องที่เพิ่งเริ่มเล่นต้องจำเวลาไว้ ไม่งั้นโหลดหน้าใหม่ทีไรก็ได้ต้นสดใหม่ทุกครั้ง
  // ตอนรดน้ำ ต้นค่อย ๆ ฟื้นจากท่าเดิม (นาทีที่แห้งอยู่) กลับมาสดระหว่างที่หยดน้ำตก
  let recovery = null;
  // ผีเสื้อตอมทีละนิดทุกเฟรม เก็บลงเครื่องแค่วินาทีละครั้งพอ แต่วาดต้นใหม่ถี่กว่านั้น ให้เห็นต้นทรุดลงต่อหน้า
  let bitSavedAt = 0, bitDrawnAt = 0;
  const bugCanvas = sunflowerBanner.querySelector(".sunflower-bugs");
  const bugs = sunflowerBugs(bugCanvas, svg, {
    reducedMotion,
    active: () => {
      const r = sunflowerBanner.getBoundingClientRect();
      const seen = !document.hidden && r.width > 0 && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
      return { on: state.on && sunflowerAges(state, Date.now()).dry < SUNFLOWER_DEAD_AT, seen };
    },
    onBite: (ms) => {
      state = { ...state, bitten: (state.bitten || 0) + ms };
      if (performance.now() - bitSavedAt > 1000) {
        bitSavedAt = performance.now();
        sunflowerSave(state);
      }
      if (!recovery && performance.now() - bitDrawnAt > 200) {
        bitDrawnAt = performance.now();
        render();
      }
    },
  });
  bugCanvas.sunflowerBugs = bugs; // ให้ชุดทดสอบเรียกผีเสื้อมาได้ทันที ไม่ต้องรอสุ่ม

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
    const pests = bugs.count();
    const status = state.on
      ? [sunflowerStatus(ages, state.fertilizedAt != null, (state.bitten || 0) / SUNFLOWER_MINUTE), pests ? `ผีเสื้อตอม ${pests} ตัว` : ""].filter(Boolean).join(" · ")
      : "";
    can.title = `รดน้ำ · ${status}`;
    replant.title = status;
    // ถุงปุ๋ยโผล่ทุกครั้งที่เปิดเกม แต่จางและกดไม่ได้เมื่อใส่ไม่ได้ ผู้เล่นจึงรู้ว่ามีปุ๋ยแม้ต้นบานเต็มที่อยู่
    fertilizer.hidden = !state.on;
    fertilizer.setAttribute("aria-disabled", String(!sunflowerCanFertilize(state, ages)));
    fertilizer.title = state.on ? sunflowerFertilizerHint(state, ages) : "";
    bugs.wake(); // ปิดเกมหรือต้นตาย ผีเสื้อต้องได้บินจากไป
    if (recovery) requestAnimationFrame(render);
  };
  const update = (next) => {
    state = next;
    sunflowerSave(state);
    render();
  };

  toggle.addEventListener("click", () => {
    // ปิดเกมระหว่างรดน้ำหรือใส่ปุ๋ย บัวหรือถุงถูกซ่อนกลางคันจนไม่มี animationend ต้องเอาคลาสออกเอง ไม่งั้นครั้งต่อไปทำไม่ได้
    sunflowerBanner.classList.remove("is-watering", "is-fertilizing");
    recovery = null;
    update(sunflowerSwitched(state, !state.on, Date.now()));
  });
  // บัวกับถุงปุ๋ยลอยไปที่ต้นเหมือนกัน เล่นพร้อมกันไม่ได้
  const toolBusy = () => sunflowerBanner.classList.contains("is-watering") || sunflowerBanner.classList.contains("is-fertilizing");
  can.addEventListener("click", () => {
    const now = Date.now();
    const { dry } = sunflowerAges(state, now);
    if (!state.on || dry >= SUNFLOWER_DEAD_AT || toolBusy()) return;
    if (!reducedMotion.matches) {
      recovery = { from: dry, start: performance.now() };
      sunflowerBanner.classList.add("is-watering");
    }
    update({ ...state, wateredAt: now, bitten: 0 });
  });
  can.addEventListener("animationend", (event) => {
    if (event.target === can) sunflowerBanner.classList.remove("is-watering");
  });
  fertilizer.addEventListener("click", () => {
    const now = Date.now();
    if (!sunflowerCanFertilize(state, sunflowerAges(state, now)) || toolBusy()) return;
    if (!reducedMotion.matches) sunflowerBanner.classList.add("is-fertilizing");
    update({ ...state, fertilizedAt: now });
  });
  fertilizer.addEventListener("animationend", (event) => {
    if (event.target === fertilizer) sunflowerBanner.classList.remove("is-fertilizing");
  });
  replant.addEventListener("click", () => {
    const now = Date.now();
    update({ ...state, plantedAt: now, wateredAt: now, fertilizedAt: null, bitten: 0 });
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
  setInterval(() => {
    bugs.tick(1000);
    if (state.on && !document.hidden && !recovery) render();
  }, 1000);
  // ต้นที่ใส่ปุ๋ยโตวินาทีละ 13 วินาที วาดแค่วินาทีละครั้งจะเห็นต้นกระตุกเป็นขั้น จึงวาดถี่ขึ้นจนกว่าจะบาน
  setInterval(() => {
    if (!state.on || state.fertilizedAt == null || document.hidden || recovery) return;
    if (sunflowerAges(state, Date.now()).grown < SUNFLOWER_BLOOMED_AT + 0.5) render();
  }, 150);
  render();
}
