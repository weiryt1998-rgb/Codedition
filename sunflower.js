/* =========================================================
   เกมปลูกทานตะวันบนป้ายชื่อ
   ไม่รดน้ำแล้วต้นค่อย ๆ เหี่ยวตามเวลาจริง: 5 นาทีเริ่มเฉา 10 นาทีคอตก 15 นาทีสีเริ่มเปลี่ยน
   20 นาทีเหี่ยวมาก ครบ 25 นาทีตาย ต้องกดปลูกใหม่ เมล็ดค่อย ๆ งอกจนบานเต็มที่ใน 13 นาที ระหว่างนั้นก็ต้องรดน้ำ
   สถานะเก็บใน localStorage ของเครื่องนั้นเท่านั้น ไม่แตะ Firestore
   ใส่ปุ๋ยได้ครั้งเดียวตอนที่ต้นยังโตไม่เต็มที่ ต้นจะโตเร็วขึ้น 13 เท่า บานเต็มที่ใน 1 นาทีแทน 13 นาที (ถ้าใส่ตอนปลูก) ไม่ใส่ก็ไม่เป็นอะไร
   แมลงวันบินมาตอมเป็นระยะ (วาดบน canvas) ตัวที่ตอมอยู่ทำให้ต้นแห้งเร็วขึ้นมาก (ตัวเดียว 10 เท่า สามตัว 28 เท่า) กดหรือแตะที่ตัวเพื่อตบทิ้ง
   แมลงมาเฉพาะตอนที่เปิดเกม ต้นยังไม่ตาย และมองเห็นต้นอยู่บนจอ รดน้ำแล้วความแห้งที่แมลงทำไว้ก็หายไปด้วย
   ปิดเกมแล้วนาฬิกาของเกมหยุด ต้นกลับเป็นของประดับที่บานสดเหมือนเดิม เปิดอีกครั้งก็เล่นต่อจากจุดเดิม
   ========================================================= */
const SUNFLOWER_KEY = "govdocs-sunflower";
const SUNFLOWER_MINUTE = 60 * 1000;
const SUNFLOWER_DEAD_AT = 25;    // นาทีหลังรดน้ำครั้งล่าสุด
const SUNFLOWER_BLOOMED_AT = 13; // นาทีหลังปลูก
const SUNFLOWER_FERTILIZED_BLOOM = 1; // ใส่ปุ๋ยแล้ว การโตที่เคยใช้ 13 นาทีใช้แค่ 1 นาที
const SUNFLOWER_BUG_MAX = 3;            // แมลงตอมพร้อมกันได้มากสุด
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
   bitten คือมิลลิวินาทีที่แห้งเพิ่มเพราะแมลงตอมตั้งแต่รดน้ำครั้งล่าสุด */
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
// bitten เป็นนาที: ความแห้งที่มาจากแมลงไม่นับเป็นเวลาตั้งแต่รดน้ำ
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

/* แมลงวันหนึ่งตัว หันหน้าไปทาง +x: ท้องเขียวเหลือบ อก หัวตาแดง ปีกใสกระพือ เส้นขอบจาง ๆ ให้เห็นบนพื้นม่วงเข้ม */
function sunflowerDrawFly(ctx, fly) {
  const flap = fly.state === "swatted" || fly.still ? 0.5 : Math.abs(Math.sin(fly.t * 70 + fly.phase));
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, fly.alpha));
  ctx.translate(fly.x, fly.y);
  ctx.rotate(fly.heading + fly.spin);
  ctx.scale(1.5, 1.5);
  // แสงจาง ๆ รอบตัว แยกตัวแมลงออกจากเกสรดอกสีเข้มและพื้นม่วงเข้ม
  ctx.shadowColor = "rgba(255, 244, 214, .7)";
  ctx.shadowBlur = 3;
  const belly = ctx.createLinearGradient(-6, -3, 2, 3);
  belly.addColorStop(0, "#47A07A");
  belly.addColorStop(1, "#123828");
  ctx.fillStyle = belly;
  ctx.strokeStyle = "rgba(255, 255, 255, .4)";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.ellipse(-2, 0, 4, 2.8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "rgba(0, 0, 0, .35)";
  ctx.lineWidth = 0.6;
  [-3.6, -1.9].forEach((x) => {
    ctx.beginPath();
    ctx.moveTo(x, -2.3);
    ctx.quadraticCurveTo(x + 0.7, 0, x, 2.3);
    ctx.stroke();
  });
  ctx.fillStyle = "#1E2A24";
  ctx.beginPath();
  ctx.arc(2, 0, 2.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#2A1A14";
  ctx.beginPath();
  ctx.arc(4.3, 0, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#D2402F";
  [-1, 1].forEach((side) => {
    ctx.beginPath();
    ctx.arc(4.8, side * 1.05, 1.05, 0, Math.PI * 2);
    ctx.fill();
  });
  // ปีกชี้ไปข้างหลังเฉียงออกข้างลำตัว
  ctx.shadowColor = "transparent";
  ctx.fillStyle = "rgba(225, 240, 255, .32)";
  ctx.strokeStyle = "rgba(255, 255, 255, .6)";
  ctx.lineWidth = 0.4;
  [-1, 1].forEach((side) => {
    ctx.beginPath();
    ctx.ellipse(-1.2, side * 2.6, 4.4, 1.2 + 1.2 * flap, side * -0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}
// ตบโดน: เส้นสั้น ๆ กระจายออกรอบจุดที่ตบ
function sunflowerDrawPop(ctx, pop) {
  const k = pop.t / 0.35;
  ctx.save();
  ctx.globalAlpha = Math.max(0, 1 - k);
  ctx.strokeStyle = "#FFF3C9";
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3 + 0.3, near = 5 + k * 6, far = 8 + k * 10;
    ctx.beginPath();
    ctx.moveTo(pop.x + Math.cos(a) * near, pop.y + Math.sin(a) * near);
    ctx.lineTo(pop.x + Math.cos(a) * far, pop.y + Math.sin(a) * far);
    ctx.stroke();
  }
  ctx.restore();
}

/* ฝูงแมลงวันบน canvas ที่คลุมรอบต้น
   canvas ไม่รับเมาส์ (กดทะลุไปที่สวิตช์ ถุงปุ๋ย บัว และเมนูได้ตามปกติ) การตบจึงดักที่ pointerdown ของทั้งหน้าแล้ววัดระยะถึงแมลงเอง
   active() บอกว่าต้นให้แมลงกัดได้ไหม (on) และมองเห็นต้นอยู่ไหม (seen) onBite(ms) รับความแห้งที่เพิ่ม
   แมลงบินมาจากขอบซ้ายหรือขวา เลือกส่วนของต้นที่จะตอม (ดอกมากสุด) แล้วบินวนอยู่ตรงนั้น ตัวที่วนอยู่เท่านั้นที่กัด
   ต้นตายหรือปิดเกม แมลงบินหนีออกไปเอง มองไม่เห็นต้น (แท็บซ่อน เมนูมือถือปิด เลื่อนพ้นจอ) ทุกอย่างหยุดรอ
   ไม่มีแมลงก็ไม่วาดอะไรเลย ไม่เปลือง requestAnimationFrame */
function sunflowerBugs(canvas, svg, { active, onBite, reducedMotion }) {
  const ctx = canvas.getContext("2d");
  const area = canvas.closest(".sidebar") || canvas.parentElement;
  const spots = [
    [".sunflower-bloom", 3], [".sunflower-bud", 2], [".sunflower-sprout", 2],
    ['.sunflower-leaf-at[data-leaf="right"]', 1], ['.sunflower-leaf-at[data-leaf="left"]', 1], [".sunflower-soil", 1],
  ];
  let flies = [], pops = [], frame = 0, last = 0, swallowClickUntil = 0;
  let gap = 0, wait = SUNFLOWER_BUG_GAPS[0] * 1000;

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
  // จุดที่แมลงตอม ตามส่วนของต้นที่กำลังไหวหรือโตอยู่ ส่วนนั้นหายไป (ดอกตูมกลายเป็นดอกบาน) ก็เลือกส่วนใหม่
  const anchorOf = (fly, origin) => {
    if (fly.at) return fly.at;
    let rect = fly.spot && spotRect(fly.spot, origin);
    if (!rect) {
      fly.spot = pick(origin);
      rect = fly.spot && spotRect(fly.spot, origin);
    }
    return rect ? { x: rect.x + rect.w * fly.fx, y: rect.y + rect.h * fly.fy } : null;
  };
  const buzzing = (fly) => fly.state === "arrive" || fly.state === "buzz";

  const step = (time) => {
    // ระหว่างเฟรมนี้ onBite วาดต้นใหม่ซึ่งเรียก wake() ต้องไม่เริ่มวงวาดซ้อนอีกวง
    frame = -1;
    const { on, seen } = active();
    if (!seen) { frame = 0; last = 0; return; }
    const dt = last ? Math.min(0.1, (time - last) / 1000) : 0;
    last = time;
    const origin = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(origin.width * dpr), height = Math.round(origin.height * dpr);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, origin.width, origin.height);

    let biting = 0;
    flies.forEach((fly) => {
      fly.t += dt;
      const x0 = fly.x, y0 = fly.y;
      if (buzzing(fly) && !on) fly.state = "leave";
      if (fly.state !== "swatted") fly.alpha = Math.min(1, fly.alpha + dt * 2.5);
      const anchor = buzzing(fly) ? anchorOf(fly, origin) : null;
      if (buzzing(fly) && !anchor) fly.state = "leave";
      if (fly.state === "arrive") {
        const dx = anchor.x - fly.x, dy = anchor.y - fly.y, distance = Math.hypot(dx, dy);
        if (distance < 6) fly.state = "buzz";
        else {
          // บินซิกแซกเข้าหาต้น
          const ux = dx / distance, uy = dy / distance, wobble = Math.sin(fly.t * 9 + fly.phase) * 40;
          fly.x += (ux * 80 - uy * wobble) * dt;
          fly.y += (uy * 80 + ux * wobble) * dt;
        }
      }
      if (fly.state === "buzz") {
        if (fly.still) { fly.x = anchor.x; fly.y = anchor.y; }
        else {
          // วนเป็นวงรีบิด ๆ รอบจุดที่ตอม รัศมีหดขยายตลอด
          fly.angle += dt * (5 + 2 * Math.sin(fly.t * 1.3 + fly.phase));
          const r = 9 + 4 * Math.sin(fly.t * 2.1 + fly.phase), follow = Math.min(1, dt * 12);
          fly.x += (anchor.x + Math.cos(fly.angle) * r * 1.4 - fly.x) * follow;
          fly.y += (anchor.y + Math.sin(fly.angle * 1.7) * r * 0.8 - fly.y) * follow;
        }
        if (on && fly.alpha > 0.5) biting++;
      }
      if (fly.state === "leave") {
        const dx = fly.home - fly.x, dy = -40 - fly.y, distance = Math.hypot(dx, dy) || 1;
        fly.x += dx / distance * 130 * dt;
        fly.y += dy / distance * 130 * dt;
        if (distance < 10) fly.gone = true;
      }
      if (fly.state === "swatted") {
        fly.vy += 500 * dt;
        fly.y += fly.vy * dt;
        fly.spin += dt * 12;
        fly.alpha -= dt * 1.8;
        if (fly.alpha <= 0) fly.gone = true;
      }
      const mx = fly.x - x0, my = fly.y - y0;
      if (fly.state !== "swatted" && Math.hypot(mx, my) > 0.05) fly.heading = Math.atan2(my, mx);
    });
    flies = flies.filter((fly) => !fly.gone);
    pops.forEach((pop) => { pop.t += dt; });
    pops = pops.filter((pop) => pop.t < 0.35);
    if (biting) onBite(dt * 1000 * SUNFLOWER_BUG_BITE * biting);
    flies.forEach((fly) => sunflowerDrawFly(ctx, fly));
    pops.forEach((pop) => sunflowerDrawPop(ctx, pop));
    if (flies.length || pops.length) frame = requestAnimationFrame(step);
    else { frame = 0; last = 0; }
  };
  const wake = () => {
    if (!frame && (flies.length || pops.length) && active().seen) frame = requestAnimationFrame(step);
  };

  // at (พิกัดบนจอ) ให้แมลงเกาะนิ่งที่จุดนั้นทันที ใช้ในชุดทดสอบ ส่วนคนที่ขอลดการเคลื่อนไหว แมลงค่อย ๆ โผล่ที่ต้นแล้วเกาะนิ่ง
  const spawn = (at) => {
    const origin = canvas.getBoundingClientRect();
    const fromLeft = Math.random() < 0.5;
    const fly = {
      state: "arrive", t: 0, phase: Math.random() * Math.PI * 2, angle: 0, spin: 0, vy: 0, alpha: 1,
      x: fromLeft ? -12 : origin.width + 12, y: origin.height * (0.35 + Math.random() * 0.3), heading: fromLeft ? 0 : Math.PI,
      home: fromLeft ? -30 : origin.width + 30, fx: 0.2 + Math.random() * 0.6, fy: 0.2 + Math.random() * 0.6, spot: null, at: null, still: false,
    };
    if (at) fly.at = { x: at.x - origin.left, y: at.y - origin.top };
    if (at || reducedMotion.matches) {
      const anchor = anchorOf(fly, origin);
      if (!anchor) return;
      Object.assign(fly, { state: "buzz", x: anchor.x, y: anchor.y, alpha: 0, still: true });
    }
    flies.push(fly);
    wake();
  };
  // เรียกทุกวินาที: นับเวลาเฉพาะตอนที่แมลงมาได้ ครบแล้วปล่อยตัวใหม่
  const tick = (ms) => {
    const { on, seen } = active();
    if (on && seen && flies.filter(buzzing).length < SUNFLOWER_BUG_MAX) {
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
    if (!flies.length) return;
    // มีหน้าต่างหรือฉากมืดบังแถบเมนูอยู่ แมลงข้างใต้ตบไม่ได้
    const top = document.elementFromPoint(event.clientX, event.clientY);
    if (!top || !area.contains(top)) return;
    const origin = canvas.getBoundingClientRect();
    const x = event.clientX - origin.left, y = event.clientY - origin.top;
    let target = null, best = event.pointerType === "touch" ? 22 : 14; // นิ้วใหญ่กว่าเมาส์ ให้ระยะเผื่อมากกว่า
    flies.forEach((fly) => {
      const distance = Math.hypot(fly.x - x, fly.y - y);
      if (buzzing(fly) && fly.alpha > 0.3 && distance < best) { target = fly; best = distance; }
    });
    if (!target) return;
    // กดนี้เป็นของแมลง ไม่ให้ทะลุไปโดนปุ่มหรือเมนูที่อยู่ข้างใต้ (click ตามมาทีหลังเสมอ ต้องกลืนทิ้งด้วย)
    event.preventDefault();
    event.stopPropagation();
    swallowClickUntil = performance.now() + 800;
    Object.assign(target, { state: "swatted", vy: -60 });
    pops.push({ x: target.x, y: target.y, t: 0 });
    wake();
  }, true);
  document.addEventListener("click", (event) => {
    if (performance.now() > swallowClickUntil) return;
    swallowClickUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  return {
    tick, wake, spawn,
    count: () => flies.filter(buzzing).length,
    // ตำแหน่งบนจอของแมลงแต่ละตัว สำหรับชุดทดสอบ
    flies: () => {
      const origin = canvas.getBoundingClientRect();
      return flies.map((fly) => ({ state: fly.state, x: origin.left + fly.x, y: origin.top + fly.y }));
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
  // แมลงกัดทีละนิดทุกเฟรม เก็บลงเครื่องแค่วินาทีละครั้งพอ แต่วาดต้นใหม่ถี่กว่านั้น ให้เห็นต้นทรุดลงต่อหน้า
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
  bugCanvas.sunflowerBugs = bugs; // ให้ชุดทดสอบเรียกแมลงมาได้ทันที ไม่ต้องรอสุ่ม

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
      ? [sunflowerStatus(ages, state.fertilizedAt != null, (state.bitten || 0) / SUNFLOWER_MINUTE), pests ? `แมลงตอม ${pests} ตัว` : ""].filter(Boolean).join(" · ")
      : "";
    can.title = `รดน้ำ · ${status}`;
    replant.title = status;
    // ถุงปุ๋ยโผล่ทุกครั้งที่เปิดเกม แต่จางและกดไม่ได้เมื่อใส่ไม่ได้ ผู้เล่นจึงรู้ว่ามีปุ๋ยแม้ต้นบานเต็มที่อยู่
    fertilizer.hidden = !state.on;
    fertilizer.setAttribute("aria-disabled", String(!sunflowerCanFertilize(state, ages)));
    fertilizer.title = state.on ? sunflowerFertilizerHint(state, ages) : "";
    bugs.wake(); // ปิดเกมหรือต้นตาย แมลงต้องได้บินหนี
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
