// track.js
import { drawGeometryGizmos } from './geometry.js';
let targets = []; // 存儲所有追蹤目標物件
let activeTargetId = null;
let defaultSearchRadius = 60;

export const TARGET_COLORS = [
  '#22c55e', // P1: 綠色 (Emerald)
  '#06b6d4', // P2: 青色 (Cyan)
  '#f43f5e', // P3: 桃紅 (Rose)
  '#eab308', // P4: 琥珀金 (Amber)
  '#a855f7', // P5: 紫色 (Purple)
  '#3b82f6', // P6: 藍色 (Blue)
  '#f97316'  // P7: 橙色 (Orange)
];

export function resetTrackState() {
  targets = [];
  activeTargetId = null;
}

export function getAllTargets() {
  return targets;
}

export function getActiveTarget() {
  return targets.find(t => t.id === activeTargetId) || targets[0] || null;
}

export function setActiveTargetId(id) {
  activeTargetId = id;
}

export function removeTarget(id) {
  targets = targets.filter(t => t.id !== id);
  if (activeTargetId === id) {
    activeTargetId = targets.length > 0 ? targets[0].id : null;
  }
}

export function setSearchRadius(radius) {
  const active = getActiveTarget();
  const r = Math.max(10, Math.round(radius));
  if (active) active.searchRadius = r;
  defaultSearchRadius = r;
}

export function getTargetCenter() {
  const active = getActiveTarget();
  return active ? active.center : null;
}

export function setTargetCenter(cx, cy, targetId = activeTargetId) {
  const target = targets.find(t => t.id === targetId) || getActiveTarget();
  if (!target) return;
  target.center = { cx, cy };
  const half = Math.floor(target.templateSize / 2);
  target.bbox = {
    x: Math.round(cx - half),
    y: Math.round(cy - half),
    width: target.templateSize,
    height: target.templateSize
  };
}

// 根據指定座標與尺寸更新特定目標的灰階 NCC 特徵矩陣
export function updateTemplatePatch(ctx, cx, cy, newSize = null, targetId = activeTargetId) {
  const target = targets.find(t => t.id === targetId);
  if (!target) return null;

  if (newSize) {
    target.templateSize = Math.max(10, Math.round(newSize));
  }
  const size = target.templateSize;
  const half = Math.floor(size / 2);
  const startX = Math.round(cx - half);
  const startY = Math.round(cy - half);

  target.center = { cx, cy };
  target.bbox = { x: startX, y: startY, width: size, height: size };

  const imgData = ctx.getImageData(startX, startY, size, size);
  const gray = new Float32Array(size * size);
  let sum = 0;

  for (let i = 0; i < gray.length; i++) {
    const idx = i << 2;
    const g = 0.299 * imgData.data[idx] + 0.587 * imgData.data[idx + 1] + 0.114 * imgData.data[idx + 2];
    gray[i] = g;
    sum += g;
  }

  const mean = sum / gray.length;
  let variance = 0;
  for (let i = 0; i < gray.length; i++) {
    gray[i] -= mean;
    variance += gray[i] * gray[i];
  }
  const norm = Math.sqrt(variance) || 1e-5;

  target.templatePatch = {
    data: gray,
    norm: norm,
    width: size,
    height: size
  };

  return target;
}

// 新增一個追蹤點
export function addTargetPoint(x, y, ctx, size = 32) {
  const newIndex = targets.length;
  const id = `target_${Date.now()}_${newIndex}`;
  const color = TARGET_COLORS[newIndex % TARGET_COLORS.length];
  const name = `P${newIndex + 1}`;

  const newTarget = {
    id,
    name,
    color,
    templateSize: size,
    searchRadius: defaultSearchRadius,
    center: { cx: x, cy: y },
    bbox: null,
    templatePatch: null,
    trajectory: []
  };

  targets.push(newTarget);
  activeTargetId = id;
  updateTemplatePatch(ctx, x, y, size, id);
  return newTarget;
}

// NCC 模板匹配演算法
function matchTemplateNCC(searchData, searchW, searchH, tpl) {
  const tW = tpl.width;
  const tH = tpl.height;
  const tData = tpl.data;
  const tNorm = tpl.norm;

  const sGray = new Float32Array(searchW * searchH);
  for (let i = 0; i < sGray.length; i++) {
    const idx = i << 2;
    sGray[i] = 0.299 * searchData.data[idx] + 0.587 * searchData.data[idx + 1] + 0.114 * searchData.data[idx + 2];
  }

  let bestScore = -1;
  let bestX = -1;
  let bestY = -1;

  const maxOffsetX = searchW - tW;
  const maxOffsetY = searchH - tH;

  for (let y = 0; y <= maxOffsetY; y++) {
    for (let x = 0; x <= maxOffsetX; x++) {
      let sum = 0;
      let sVar = 0;
      let cross = 0;

      for (let ty = 0; ty < tH; ty++) {
        const row = (y + ty) * searchW + x;
        for (let tx = 0; tx < tW; tx++) {
          sum += sGray[row + tx];
        }
      }
      const sMean = sum / (tW * tH);

      for (let ty = 0; ty < tH; ty++) {
        const row = (y + ty) * searchW + x;
        const tRow = ty * tW;
        for (let tx = 0; tx < tW; tx++) {
          const sVal = sGray[row + tx] - sMean;
          sVar += sVal * sVal;
          cross += sVal * tData[tRow + tx];
        }
      }

      const sNorm = Math.sqrt(sVar) || 1e-5;
      const ncc = cross / (tNorm * sNorm);

      if (ncc > bestScore) {
        bestScore = ncc;
        bestX = x;
        bestY = y;
      }
    }
  }

  return { score: bestScore, x: bestX, y: bestY };
}

export function seekTo(video, time) {
  return new Promise(resolve => {
    if (Math.abs(video.currentTime - time) < 0.001) {
      resolve();
      return;
    }
    let timer;
    const onSeeked = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    // ★ 保險機制：若 150ms 內瀏覽器解碼未回調 seeked，強制 resolve 繼續下一幀
    timer = setTimeout(() => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    }, 150);

    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
  });
}

function drawHandle(ctx, x, y, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// 支援多目標的點擊與手柄判定
export function hitTestHandles(mx, my, canvasWidth = 1e5, canvasHeight = 1e5) {
  if (targets.length === 0) return null;

  const HIT_DIST = 12;
  const active = getActiveTarget();

  // 1. 優先檢測「當前啟用目標 (Active Target)」的手柄
  if (active && active.center) {
    const { cx, cy } = active.center;
    const halfT = active.templateSize / 2;
    const r = active.searchRadius;

    // 1-1. 目標框四角
    const targetCorners = [
      { type: 'target', cursor: 'nwse-resize', x: cx - halfT, y: cy - halfT },
      { type: 'target', cursor: 'nesw-resize', x: cx + halfT, y: cy - halfT },
      { type: 'target', cursor: 'nwse-resize', x: cx + halfT, y: cy + halfT },
      { type: 'target', cursor: 'nesw-resize', x: cx - halfT, y: cy + halfT }
    ];
    for (const corner of targetCorners) {
      if (Math.hypot(mx - corner.x, my - corner.y) <= HIT_DIST) {
        return { ...corner, targetId: active.id };
      }
    }

    // 1-2. 搜尋框四角手柄
    const sX = Math.max(0, Math.min(canvasWidth - r * 2, cx - r));
    const sY = Math.max(0, Math.min(canvasHeight - r * 2, cy - r));
    const sW = Math.min(r * 2, canvasWidth - sX);
    const sH = Math.min(r * 2, canvasHeight - sY);

    const searchCorners = [
      { type: 'search', cursor: 'nwse-resize', x: sX, y: sY },
      { type: 'search', cursor: 'nesw-resize', x: sX + sW, y: sY },
      { type: 'search', cursor: 'nwse-resize', x: sX + sW, y: sY + sH },
      { type: 'search', cursor: 'nesw-resize', x: sX, y: sY + sH }
    ];
    for (const corner of searchCorners) {
      if (Math.hypot(mx - corner.x, my - corner.y) <= HIT_DIST) {
        return { ...corner, targetId: active.id };
      }
    }

    // 1-3. 搜尋範圍框內部平移
    if (mx >= sX && mx <= sX + sW && my >= sY && my <= sY + sH) {
      return { type: 'move', cursor: 'move', targetId: active.id, cx, cy };
    }
  }

  // 2. 若未命中作用中手柄，檢測點擊是否落在其他目標框上（直接切換選取該目標）
  for (const t of targets) {
    if (t.id === activeTargetId || !t.center) continue;
    const half = t.templateSize / 2;
    if (mx >= t.center.cx - half && mx <= t.center.cx + half &&
        my >= t.center.cy - half && my <= t.center.cy + half) {
      return { type: 'switchTarget', cursor: 'pointer', targetId: t.id };
    }
  }

  return null;
}

// 繪製單一目標的 Gizmo
export function drawSingleGizmo(ctx, target, isActive = false, isLost = false, showHandles = true) {
  if (!target || !target.center) return;
  const { cx, cy } = target.center;
  const tSize = target.templateSize;
  const halfT = Math.floor(tSize / 2);
  const r = target.searchRadius;
  const mainColor = isLost ? '#ef4444' : target.color;

  ctx.save();

  // 若為非作用中目標，僅精簡繪製目標方框與十字準心
  if (!isActive) {
    ctx.strokeStyle = mainColor;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(cx - halfT, cy - halfT, tSize, tSize);

    // 名稱標籤
    ctx.fillStyle = mainColor;
    ctx.font = 'bold 11px monospace';
    ctx.fillText(target.name, cx - halfT, cy - halfT - 4);

    // 準心
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // 作用中目標：完整繪製搜尋框、目標框、調整把手與十字線
  const sX = Math.max(0, cx - r);
  const sY = Math.max(0, cy - r);
  const sW = r * 2;
  const sH = r * 2;

  // 搜尋半徑範圍
  ctx.strokeStyle = isLost ? '#ef4444' : 'rgba(245, 158, 11, 0.85)';
  ctx.fillStyle = isLost ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.03)';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 4]);
  ctx.fillRect(sX, sY, sW, sH);
  ctx.strokeRect(sX, sY, sW, sH);

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = isLost ? 'rgba(239, 68, 68, 0.35)' : 'rgba(245, 158, 11, 0.2)';
  ctx.stroke();
  ctx.setLineDash([]);

  if (showHandles) {
    const handleCol = isLost ? '#ef4444' : '#f59e0b';
    drawHandle(ctx, sX, sY, handleCol);
    drawHandle(ctx, sX + sW, sY, handleCol);
    drawHandle(ctx, sX + sW, sY + sH, handleCol);
    drawHandle(ctx, sX, sY + sH, handleCol);
  }

  // 目標框
  ctx.strokeStyle = mainColor;
  ctx.lineWidth = isLost ? 2 : 1.5;
  ctx.strokeRect(cx - halfT, cy - halfT, tSize, tSize);

  // 標籤名稱
  ctx.fillStyle = mainColor;
  ctx.font = 'bold 12px monospace';
  ctx.fillText(`[${target.name}] ACTIVE`, cx - halfT, cy - halfT - 6);

  if (showHandles) {
    drawHandle(ctx, cx - halfT, cy - halfT, mainColor);
    drawHandle(ctx, cx + halfT, cy - halfT, mainColor);
    drawHandle(ctx, cx + halfT, cy + halfT, mainColor);
    drawHandle(ctx, cx - halfT, cy + halfT, mainColor);
  }

  // 十字線
  ctx.strokeStyle = mainColor;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy);
  ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6);
  ctx.stroke();

  ctx.restore();
}

// 繪製所有目標的 Gizmo
export function drawAllGizmos(ctx, lostTargetId = null, showHandles = true) {
  for (const t of targets) {
    const isAct = (t.id === activeTargetId);
    const isLost = (t.id === lostTargetId);
    drawSingleGizmo(ctx, t, isAct, isLost, showHandles);
  }
}

// 多目標自動追蹤主迴圈
export async function runAutoTrack({
  video,
  canvas,
  pxPerMeter,
  threshold = 0.55,
  renderFrame,
  transformCoords,
  onFrameUpdate,
  onTargetLost,
  isTrackingCheck,
  startTime = 0
}) {
  if (targets.length === 0 || !video) return;

  const ctx = canvas.getContext('2d');
  const fps = 30;
  const frameDuration = 1 / fps;
  let frameIdx = Math.round(startTime * fps);

  for (let t = startTime; t < video.duration; t += frameDuration) {
    if (typeof isTrackingCheck === 'function' && !isTrackingCheck()) {
      break;
    }

    await seekTo(video, t);

    // 渲染基礎無標註影格以擷取影像像素
    if (typeof renderFrame === 'function') {
      renderFrame(false);
    } else {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }

    const currentFrameData = {
      frame: frameIdx,
      time: t.toFixed(3),
      targets: {}
    };

    // 同步對所有目標點執行匹配
    for (const target of targets) {
      const { cx, cy } = target.center;
      const radius = target.searchRadius;
      const tSize = target.templateSize;
      const halfT = Math.floor(tSize / 2);

      const sX = Math.max(0, Math.min(canvas.width - radius * 2, cx - radius));
      const sY = Math.max(0, Math.min(canvas.height - radius * 2, cy - radius));
      const sW = Math.min(radius * 2, canvas.width - sX);
      const sH = Math.min(radius * 2, canvas.height - sY);

      let match = { score: -1, x: 0, y: 0 };
      if (sW >= tSize && sH >= tSize && target.templatePatch) {
        const searchImgData = ctx.getImageData(sX, sY, sW, sH);
        match = matchTemplateNCC(searchImgData, sW, sH, target.templatePatch);
      }

      let newCx = cx;
      let newCy = cy;
      let finalScore = match.score;

      if (match.score >= threshold) {
        newCx = sX + match.x + halfT;
        newCy = sY + match.y + halfT;
        target.center = { cx: newCx, cy: newCy };
      } else {
        // 目標遺失事件回調
        if (typeof onTargetLost === 'function') {
          activeTargetId = target.id;
          const decision = await onTargetLost({
            target,
            frameIdx,
            time: t,
            score: match.score,
            cx,
            cy
          });

          if (decision === 'abort') {
            return;
          } else if (decision === 'continue') {
            newCx = target.center.cx;
            newCy = target.center.cy;
            finalScore = 1.0;
          }
        }
      }

      // 轉換座標與記錄
      let x_m = 0, y_m = 0;
      if (typeof transformCoords === 'function') {
        const trans = transformCoords(newCx, newCy);
        x_m = trans.x_m;
        y_m = trans.y_m;
      } else {
        x_m = pxPerMeter ? newCx / pxPerMeter : 0;
        y_m = pxPerMeter ? (canvas.height - newCy) / pxPerMeter : 0;
      }

      const ptRecord = {
        frame: frameIdx,
        time: t.toFixed(3),
        cx: newCx,
        cy: newCy,
        x_px: newCx.toFixed(1),
        y_px: newCy.toFixed(1),
        x_m: Number(x_m).toFixed(4),
        y_m: Number(y_m).toFixed(4),
        score: Number(finalScore).toFixed(3)
      };

      target.trajectory.push(ptRecord);
      currentFrameData.targets[target.id] = ptRecord;
    }

    // 重新繪製含疊加 Gizmo 標註
    if (typeof renderFrame === 'function') renderFrame(true);
    drawAllGizmos(ctx, null, false);
    drawGeometryGizmos(ctx, targets, pxPerMeter);

    if (onFrameUpdate) onFrameUpdate(currentFrameData, targets);
    frameIdx++;
    await new Promise(r => setTimeout(r, 0));
  }
}