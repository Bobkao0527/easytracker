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
 * 建立兩線段的夾角
 */
export function addAngle(line1, line2) {
  const id = `angle_${Date.now()}_${angles.length + 1}`;
  const name = `θ${angles.length + 1}`;
  const angle = {
    id,
    name,
    line1Id: line1.id,
    line2Id: line2.id,
    color: '#ec4899'
  };
  angles.push(angle);
  return { angle, message: `已建立夾角 [${name}]: ${line1.name} 與 ${line2.name} 之夾角` };
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
 * 計算兩向量夾角 (單位: 度 0° ~ 180°)
 */
export function calculateAngleBetweenLines(line1, line2, targetsMap) {
  const seg1 = getLineEndpoints(line1, targetsMap);
  const seg2 = getLineEndpoints(line2, targetsMap);
  if (!seg1 || !seg2) return null;

  const v1 = { x: seg1.end.x - seg1.start.x, y: seg1.end.y - seg1.start.y };
  const v2 = { x: seg2.end.x - seg2.start.x, y: seg2.end.y - seg2.start.y };

  const mag1 = Math.hypot(v1.x, v1.y);
  const mag2 = Math.hypot(v2.x, v2.y);
  if (mag1 < 1e-4 || mag2 < 1e-4) return 0;

  const dot = v1.x * v2.x + v1.y * v2.y;
  let cosTheta = dot / (mag1 * mag2);
  cosTheta = Math.max(-1, Math.min(1, cosTheta)); // 數值截斷防溢位

  return (Math.acos(cosTheta) * 180) / Math.PI;
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
 * 繪製所有線段與夾角 Gizmo (含弧線與即時度數標籤)
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
      ctx.setLineDash([6, 4]); // 參考軸線用虛線表示
    }
    ctx.beginPath();
    ctx.moveTo(seg.start.x, seg.start.y);
    ctx.lineTo(seg.end.x, seg.end.y);
    ctx.stroke();

    // 繪製線段標籤及物理長度 (公尺或像素)
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

    const deg = calculateAngleBetweenLines(l1, l2, targetsMap);
    if (deg === null) return;

    // 找出兩條線的交點（共頂點），若無共點則以 L1 的起點作為繪製基準
    let vertex = seg1.start;
    if (Math.hypot(seg1.start.x - seg2.start.x, seg1.start.y - seg2.start.y) < 5) {
      vertex = seg1.start;
    } else if (Math.hypot(seg1.end.x - seg2.start.x, seg1.end.y - seg2.start.y) < 5) {
      vertex = seg1.end;
    }

    const a1 = Math.atan2(seg1.end.y - seg1.start.y, seg1.end.x - seg1.start.x);
    const a2 = Math.atan2(seg2.end.y - seg2.start.y, seg2.end.x - seg2.start.x);

    ctx.save();
    ctx.strokeStyle = angle.color;
    ctx.fillStyle = angle.color;
    ctx.lineWidth = 1.8;

    // 繪製角弧度
    ctx.beginPath();
    ctx.arc(vertex.x, vertex.y, 24, Math.min(a1, a2), Math.max(a1, a2));
    ctx.stroke();

    // 標示角度數值文字
    const midAngle = (a1 + a2) / 2;
    const textX = vertex.x + Math.cos(midAngle) * 38;
    const textY = vertex.y + Math.sin(midAngle) * 38;

    ctx.font = 'bold 13px monospace';
    ctx.fillText(`${angle.name}: ${deg.toFixed(1)}°`, textX, textY);
    ctx.restore();
  });
}