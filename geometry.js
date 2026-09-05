// geometry.js

let lines = [];   // 儲存所有線段物件
let angles = [];  // 儲存所有夾角物件

export function resetGeometryState() {
  lines = [];
  angles = [];
}

export function getAllLines() {
  return lines;
}

export function getAllAngles() {
  return angles;
}

/**
 * 建立點到點連線，或是單點 + 鉛直/水平參考線
 * @param {Object} p1Target - 起始追蹤點
 * @param {Object|null} p2Target - 第二個追蹤點（若為空白點則為 null）
 * @param {Object|null} freePoint - 空白處點擊的座標 {x, y}
 */
export function addLine(p1Target, p2Target = null, freePoint = null) {
  const id = `line_${Date.now()}_${lines.length + 1}`;
  const name = `L${lines.length + 1}`;

  if (p2Target) {
    // 1. 兩追蹤點動態連線
    const line = {
      id,
      name,
      type: 'two_targets',
      p1Id: p1Target.id,
      p2Id: p2Target.id,
      color: '#38bdf8'
    };
    lines.push(line);
    return { line, message: `已建立連線 [${name}]: ${p1Target.name} - ${p2Target.name}` };
  } else if (freePoint) {
    // 2. 自動判定水平或鉛直參考線
    const dx = freePoint.x - p1Target.center.cx;
    const dy = freePoint.y - p1Target.center.cy;
    const isVertical = Math.abs(dy) > Math.abs(dx);

    const line = {
      id,
      name,
      type: 'axis_ref',
      p1Id: p1Target.id,
      axisType: isVertical ? 'vertical' : 'horizontal',
      dirSign: isVertical ? Math.sign(dy) || 1 : Math.sign(dx) || 1, // 正負方向
      lengthPx: 120, // 參考線預設長度
      color: '#fbbf24'
    };
    lines.push(line);
    const desc = isVertical ? '鉛直線 (垂直軸)' : '水平線 (水平軸)';
    return { line, message: `已建立連線 [${name}]: 以 ${p1Target.name} 為基準的 ${desc}` };
  }
  return null;
}

/**
 * 建立夾角：包含線1、線2，以及使用者點擊的側向參考點 (sidePoint)
 */
export function addAngle(line1, line2, sidePoint = null, targetsMap = {}) {
  const id = `angle_${Date.now()}_${angles.length + 1}`;
  const name = `θ${angles.length + 1}`;

  // 傳入 targetsMap 正確計算幾何側向
  const isMajor = sidePoint ? checkIsMajorAngle(line1, line2, sidePoint, targetsMap) : false;

  const angle = {
    id,
    name,
    line1Id: line1.id,
    line2Id: line2.id,
    sidePoint,
    isMajor,
    color: '#ec4899',
    history: []
  };

  angles.push(angle);
  const typeText = isMajor ? '優角(大角)' : '劣角(小角)';
  return { angle, message: `已建立夾角 [${name}]: ${line1.name} 與 ${line2.name} 的 ${typeText}` };
}

/**
 * 計算兩向量交點 (若無實體交點則取 L1 起點作為頂點)
 */
export function getAngleVertex(seg1, seg2) {
  const eps = 6;
  if (Math.hypot(seg1.start.x - seg2.start.x, seg1.start.y - seg2.start.y) < eps) return seg1.start;
  if (Math.hypot(seg1.end.x - seg2.start.x, seg1.end.y - seg2.start.y) < eps) return seg1.end;
  if (Math.hypot(seg1.start.x - seg2.end.x, seg1.start.y - seg2.end.y) < eps) return seg1.start;
  if (Math.hypot(seg1.end.x - seg2.end.x, seg1.end.y - seg2.end.y) < eps) return seg1.end;
  return seg1.start;
}

/**
 * 利用角平分線判斷點擊點是否在大角（優角）側
 */
function checkIsMajorAngle(line1, line2, clickPt, targetsMap = {}) {
  const seg1 = getLineEndpoints(line1, targetsMap);
  const seg2 = getLineEndpoints(line2, targetsMap);
  if (!seg1 || !seg2) return false;

  const { vertex: v, v1, v2 } = getRayVectors(seg1, seg2);
  const len1 = Math.hypot(v1.x, v1.y) || 1;
  const len2 = Math.hypot(v2.x, v2.y) || 1;

  // 修復：u1.y 應除以 len1，求出正確角平分線
  const u1 = { x: v1.x / len1, y: v1.y / len1 };
  const u2 = { x: v2.x / len2, y: v2.y / len2 };
  const bisector = { x: u1.x + u2.x, y: u1.y + u2.y };

  const vClick = { x: clickPt.x - v.x, y: clickPt.y - v.y };
  return (bisector.x * vClick.x + bisector.y * vClick.y) < 0;
}

/**
 * 取得特定時間點或影格上線段的端點座標 (像素坐標)
 */
export function getLineEndpoints(line, targetsMap) {
  const p1 = targetsMap[line.p1Id];
  if (!p1 || !p1.center) return null;

  const start = { x: p1.center.cx, y: p1.center.cy };

  if (line.type === 'two_targets') {
    const p2 = targetsMap[line.p2Id];
    if (!p2 || !p2.center) return null;
    return { start, end: { x: p2.center.cx, y: p2.center.cy } };
  } else if (line.type === 'axis_ref') {
    if (line.axisType === 'vertical') {
      return { start, end: { x: start.x, y: start.y + line.dirSign * line.lengthPx } };
    } else {
      return { start, end: { x: start.x + line.dirSign * line.lengthPx, y: start.y } };
    }
  }
  return null;
}

/**
 * 使用 2D 外積計算有向角度（支援正負旋轉方向）
 * 定義：從 line1 旋轉到 line2 的角度
 * @returns {number} 角度 (度，範圍 -180° ~ +180°)
 */
export function calculateAngleBetweenLines(line1, line2, targetsMap, angleConfig = null) {
  const seg1 = getLineEndpoints(line1, targetsMap);
  const seg2 = getLineEndpoints(line2, targetsMap);
  if (!seg1 || !seg2) return null;

  const { v1, v2 } = getRayVectors(seg1, seg2);

  const cross = v1.x * v2.y - v1.y * v2.x;
  const dot = v1.x * v2.x + v1.y * v2.y;

  // 注意：在 Canvas 座標系下 (Y向下)，cross > 0 代表順時針，cross < 0 代表逆時針
  let deg = (Math.atan2(cross, dot) * 180) / Math.PI;

  // 2. 如果使用者指定測量「優角」(大角)
  if (angleConfig && angleConfig.isMajor) {
    deg = deg > 0 ? (360 - deg) : (-360 - deg);
  }

  return deg;
}

/**
 * 命中測試：判斷點擊座標是否靠近某條線
 */
export function hitTestLine(mx, my, targetsMap, threshold = 8) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const seg = getLineEndpoints(line, targetsMap);
    if (!seg) continue;

    const dist = pointToSegmentDistance(mx, my, seg.start.x, seg.start.y, seg.end.x, seg.end.y);
    if (dist <= threshold) {
      return line;
    }
  }
  return null;
}

function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
  const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

/**
 * 取得自共用頂點發散的兩條射線向量
 */
function getRayVectors(seg1, seg2) {
  const v = getAngleVertex(seg1, seg2);
  const eps = 6;
  const p1Other = Math.hypot(seg1.start.x - v.x, seg1.start.y - v.y) < eps ? seg1.end : seg1.start;
  const p2Other = Math.hypot(seg2.start.x - v.x, seg2.start.y - v.y) < eps ? seg2.end : seg2.start;
  return {
    vertex: v,
    v1: { x: p1Other.x - v.x, y: p1Other.y - v.y },
    v2: { x: p2Other.x - v.x, y: p2Other.y - v.y }
  };
}

/**
 * 繪製幾何 Gizmo
 */
export function drawGeometryGizmos(ctx, targets, pxPerMeter = 0) {
  const targetsMap = {};
  targets.forEach(t => { targetsMap[t.id] = t; });

  // 1. 繪製線段
  lines.forEach(line => {
    const seg = getLineEndpoints(line, targetsMap);
    if (!seg) return;

    ctx.save();
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 2;
    if (line.type === 'axis_ref') {
      ctx.setLineDash([6, 4]);
    }
    ctx.beginPath();
    ctx.moveTo(seg.start.x, seg.start.y);
    ctx.lineTo(seg.end.x, seg.end.y);
    ctx.stroke();

    const midX = (seg.start.x + seg.end.x) / 2;
    const midY = (seg.start.y + seg.end.y) / 2;
    const pixelLen = Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
    const lenText = pxPerMeter > 0 ? `${(pixelLen / pxPerMeter).toFixed(3)}m` : `${Math.round(pixelLen)}px`;

    ctx.fillStyle = line.color;
    ctx.font = 'bold 11px monospace';
    ctx.fillText(`${line.name} (${lenText})`, midX + 5, midY - 5);
    ctx.restore();
  });

  // 2. 繪製夾角弧線與角度數值
  angles.forEach(angle => {
    const l1 = lines.find(l => l.id === angle.line1Id);
    const l2 = lines.find(l => l.id === angle.line2Id);
    if (!l1 || !l2) return;

    const seg1 = getLineEndpoints(l1, targetsMap);
    const seg2 = getLineEndpoints(l2, targetsMap);
    if (!seg1 || !seg2) return;

    const deg = calculateAngleBetweenLines(l1, l2, targetsMap, angle);
    if (deg === null) return;

    const { vertex, v1, v2 } = getRayVectors(seg1, seg2);
    const a1 = Math.atan2(v1.y, v1.x);
    const a2 = Math.atan2(v2.y, v2.x);

    ctx.save();
    ctx.strokeStyle = angle.color;
    ctx.fillStyle = angle.color;
    ctx.lineWidth = 2;

    let diff = a2 - a1;
    while (diff < 0) diff += Math.PI * 2;
    while (diff >= Math.PI * 2) diff -= Math.PI * 2;

    const isCcw = angle.isMajor ? (diff < Math.PI) : (diff >= Math.PI);

    ctx.beginPath();
    ctx.arc(vertex.x, vertex.y, 28, a1, a2, isCcw);
    ctx.stroke();

    let midAngle = !isCcw ? (a1 + diff / 2) : (a1 - (Math.PI * 2 - diff) / 2);
    const textX = vertex.x + Math.cos(midAngle) * 45;
    const textY = vertex.y + Math.sin(midAngle) * 45;

    ctx.font = 'bold 13px monospace';
    ctx.fillText(`${angle.name}: ${deg.toFixed(1)}°`, textX, textY);
    ctx.restore();
  });
}