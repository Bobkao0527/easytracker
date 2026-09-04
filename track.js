// track.js
let templatePatch = null;
let targetBBox = null;
let targetCenter = null;  // { cx, cy }
let templateSize = 32;
let currentSearchRadius = 60;

export function resetTrackState() {
  templatePatch = null;
  targetBBox = null;
  targetCenter = null;
}

export function setROI(x, y, width, height) {
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  };
}

export function setSearchRadius(radius) {
  currentSearchRadius = Math.max(10, Math.round(radius));
}

export function getSearchRadius() {
  return currentSearchRadius;
}

export function getTargetCenter() {
  return targetCenter;
}

export function getTemplateSize() {
  return templateSize;
}

// 僅平移座標與 BBox（供滑鼠拖曳時高頻更新，不消耗效能讀取 ImageData）
export function setTargetCenter(cx, cy) {
  targetCenter = { cx, cy };
  const half = Math.floor(templateSize / 2);
  targetBBox = {
    x: Math.round(cx - half),
    y: Math.round(cy - half),
    width: templateSize,
    height: templateSize
  };
}

// 僅在釋放滑鼠或確認校正時，擷取指定大小的純淨紋理模板
export function updateTemplatePatch(ctx, cx, cy, newSize = templateSize) {
  templateSize = Math.max(10, Math.round(newSize));
  const half = Math.floor(templateSize / 2);
  const startX = Math.round(cx - half);
  const startY = Math.round(cy - half);

  targetCenter = { cx, cy };
  targetBBox = {
    x: startX,
    y: startY,
    width: templateSize,
    height: templateSize
  };

  const imgData = ctx.getImageData(startX, startY, templateSize, templateSize);
  const gray = new Float32Array(templateSize * templateSize);
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

  templatePatch = {
    data: gray,
    norm: norm,
    width: templateSize,
    height: templateSize
  };

  return { targetBBox, targetColor: true };
}

export function selectTarget(x, y, ctx, size = 32) {
  return updateTemplatePatch(ctx, x, y, size);
}

// NCC 模板匹配
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
    if (Math.abs(video.currentTime - time) < 0.0001) {
      resolve();
      return;
    }
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
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

// 檢測滑鼠落點
export function hitTestHandles(mx, my, canvasWidth = 1e5, canvasHeight = 1e5) {
  if (!targetCenter || !targetBBox) return null;

  const { cx, cy } = targetCenter;
  const halfT = templateSize / 2;
  const r = currentSearchRadius;
  const HIT_DIST = 12; // 角點手柄判定半徑

  // 1. 綠框四角縮放手柄（最優先判定）
  const targetCorners = [
    { type: 'target', cursor: 'nwse-resize', x: cx - halfT, y: cy - halfT },
    { type: 'target', cursor: 'nesw-resize', x: cx + halfT, y: cy - halfT },
    { type: 'target', cursor: 'nwse-resize', x: cx + halfT, y: cy + halfT },
    { type: 'target', cursor: 'nesw-resize', x: cx - halfT, y: cy + halfT }
  ];
  for (const corner of targetCorners) {
    if (Math.hypot(mx - corner.x, my - corner.y) <= HIT_DIST) return corner;
  }

  // 2. 搜尋範圍框（黃框）四角手柄
  const searchX = Math.max(0, Math.min(canvasWidth - r * 2, cx - r));
  const searchY = Math.max(0, Math.min(canvasHeight - r * 2, cy - r));
  const searchW = Math.min(r * 2, canvasWidth - searchX);
  const searchH = Math.min(r * 2, canvasHeight - searchY);

  const searchCorners = [
    { type: 'search', cursor: 'nwse-resize', x: searchX, y: searchY },
    { type: 'search', cursor: 'nesw-resize', x: searchX + searchW, y: searchY },
    { type: 'search', cursor: 'nwse-resize', x: searchX + searchW, y: searchY + searchH },
    { type: 'search', cursor: 'nesw-resize', x: searchX, y: searchY + searchH }
  ];
  for (const corner of searchCorners) {
    if (Math.hypot(mx - corner.x, my - corner.y) <= HIT_DIST) return corner;
  }

  // 3. ★ 黃色搜尋框內部任意位置：未命中四角時，一律觸發整體平移
  if (mx >= searchX && mx <= searchX + searchW && my >= searchY && my <= searchY + searchH) {
    return { type: 'move', cursor: 'move', cx, cy };
  }

  return null;
}

// 繪製追蹤 Gizmo
export function drawTrackingGizmo(ctx, {
  searchX, searchY, searchW, searchH,
  searchCenterX, searchCenterY, searchRadius,
  matchBox,
  centerX, centerY,
  isLost = false,
  showHandles = true
}) {
  ctx.save();

  // 1. 搜尋範圍框
  const searchColor = isLost ? '#ef4444' : 'rgba(245, 158, 11, 0.85)';
  const searchFill = isLost ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.03)';

  ctx.strokeStyle = searchColor;
  ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 4]);
  ctx.fillStyle = searchFill;
  ctx.fillRect(searchX, searchY, searchW, searchH);
  ctx.strokeRect(searchX, searchY, searchW, searchH);

  if (searchCenterX !== undefined && searchCenterY !== undefined && searchRadius) {
    ctx.beginPath();
    ctx.arc(searchCenterX, searchCenterY, searchRadius, 0, Math.PI * 2);
    ctx.strokeStyle = isLost ? 'rgba(239, 68, 68, 0.35)' : 'rgba(245, 158, 11, 0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // 搜尋框控制手柄
  if (showHandles) {
    const handleCol = isLost ? '#ef4444' : '#f59e0b';
    drawHandle(ctx, searchX, searchY, handleCol);
    drawHandle(ctx, searchX + searchW, searchY, handleCol);
    drawHandle(ctx, searchX + searchW, searchY + searchH, handleCol);
    drawHandle(ctx, searchX, searchY + searchH, handleCol);
  }

  // 2. 目標框
  if (matchBox) {
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = isLost ? 2 : 1.2;
    ctx.strokeRect(matchBox.x, matchBox.y, matchBox.width, matchBox.height);

    if (showHandles) {
      drawHandle(ctx, matchBox.x, matchBox.y, '#22c55e');
      drawHandle(ctx, matchBox.x + matchBox.width, matchBox.y, '#22c55e');
      drawHandle(ctx, matchBox.x + matchBox.width, matchBox.y + matchBox.height, '#22c55e');
      drawHandle(ctx, matchBox.x, matchBox.y + matchBox.height, '#22c55e');
    }
  }

  // 3. 十字準心
  const cx = centerX !== undefined ? centerX : searchCenterX;
  const cy = centerY !== undefined ? centerY : searchCenterY;
  if (cx !== undefined && cy !== undefined) {
    const crossSize = 5;
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = isLost ? '#ef4444' : '#22c55e';

    ctx.beginPath();
    ctx.moveTo(cx - crossSize, cy);
    ctx.lineTo(cx + crossSize, cy);
    ctx.moveTo(cx, cy - crossSize);
    ctx.lineTo(cx, cy + crossSize);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// 自動追蹤迴圈
export async function runAutoTrack({
  video,
  canvas,
  pxPerMeter,
  searchRadius,
  threshold = 0.55,
  renderFrame,
  transformCoords,
  onFrameUpdate,
  onTargetLost,
  isTrackingCheck,
  startTime = 0,             // ★ 新增：支援指定起始時間
  initialData = []           // ★ 新增：接續先前的追蹤資料
}) {
  if (!targetBBox || !templatePatch || !video) return initialData;

  const ctx = canvas.getContext('2d');
  const trackingData = [...initialData];
  const fps = 30;
  const frameDuration = 1 / fps;
  let frameIdx = Math.round(startTime * fps);

  let currentCenterX = targetCenter ? targetCenter.cx : (targetBBox.x + targetBBox.width / 2);
  let currentCenterY = targetCenter ? targetCenter.cy : (targetBBox.y + targetBBox.height / 2);
  let radius = searchRadius || currentSearchRadius;

  for (let t = startTime; t < video.duration; t += frameDuration) {
    // 檢查外部是否按下了暫停
    if (typeof isTrackingCheck === 'function' && !isTrackingCheck()) {
      break;
    }

    await seekTo(video, t);

    if (typeof renderFrame === 'function') {
      renderFrame(false);
    } else {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }

    radius = currentSearchRadius;
    const halfT = Math.floor(templateSize / 2);
    const searchX = Math.max(0, Math.min(canvas.width - radius * 2, currentCenterX - radius));
    const searchY = Math.max(0, Math.min(canvas.height - radius * 2, currentCenterY - radius));
    const searchW = Math.min(radius * 2, canvas.width - searchX);
    const searchH = Math.min(radius * 2, canvas.height - searchY);

    let match = { score: -1, x: 0, y: 0 };
    if (searchW >= templateSize && searchH >= templateSize) {
      const searchImgData = ctx.getImageData(searchX, searchY, searchW, searchH);
      match = matchTemplateNCC(searchImgData, searchW, searchH, templatePatch);
    }

    if (typeof renderFrame === 'function') {
      renderFrame(true);
    }

    // 門檻判定
    if (match.score >= threshold) {
      currentCenterX = searchX + match.x + halfT;
      currentCenterY = searchY + match.y + halfT;
      targetCenter = { cx: currentCenterX, cy: currentCenterY };
      recordTrackingPoint(currentCenterX, currentCenterY, match.score, t, frameIdx);
    } else {
      console.warn(`第 ${frameIdx} 幀目標遺失 (得分: ${match.score.toFixed(2)} < 門檻: ${threshold.toFixed(2)})`);

      if (typeof onTargetLost === 'function') {
        const decision = await onTargetLost({
          frameIdx,
          time: t,
          score: match.score,
          cx: currentCenterX,
          cy: currentCenterY
        });

        if (decision === 'abort') {
          break;
        } else if (decision === 'continue') {
          if (targetCenter) {
            currentCenterX = targetCenter.cx;
            currentCenterY = targetCenter.cy;
            recordTrackingPoint(currentCenterX, currentCenterY, 1.0, t, frameIdx);
          }
        }
      }
    }

    frameIdx++;
    await new Promise(r => setTimeout(r, 0));
  }

  function recordTrackingPoint(cx, cy, score, timeSec, idx) {
    let x_m = 0, y_m = 0;
    if (typeof transformCoords === 'function') {
      const trans = transformCoords(cx, cy);
      x_m = trans.x_m;
      y_m = trans.y_m;
    } else {
      x_m = pxPerMeter ? cx / pxPerMeter : 0;
      y_m = pxPerMeter ? (canvas.height - cy) / pxPerMeter : 0;
    }

    const frameRes = {
      frame: idx,
      time: timeSec.toFixed(3),
      x_px: cx.toFixed(1),
      y_px: cy.toFixed(1),
      x_m: Number(x_m).toFixed(4),
      y_m: Number(y_m).toFixed(4),
      score: Number(score).toFixed(3),
      cx,
      cy,
      timestamp: timeSec * 1_000_000
    };

    trackingData.push(frameRes);

    const half = Math.floor(templateSize / 2);
    drawTrackingGizmo(ctx, {
      searchX: Math.max(0, cx - currentSearchRadius),
      searchY: Math.max(0, cy - currentSearchRadius),
      searchW: Math.min(currentSearchRadius * 2, canvas.width - (cx - currentSearchRadius)),
      searchH: Math.min(currentSearchRadius * 2, canvas.height - (cy - currentSearchRadius)),
      searchCenterX: cx,
      searchCenterY: cy,
      searchRadius: currentSearchRadius,
      matchBox: {
        x: cx - half,
        y: cy - half,
        width: templateSize,
        height: templateSize
      },
      centerX: cx,
      centerY: cy,
      isLost: false,
      showHandles: false
    });

    if (onFrameUpdate) onFrameUpdate(frameRes, trackingData);
  }

  // ★ 移除原先強制 jump 回 0 秒的動作，使影片停留在當前幀以利後續校正
  return trackingData;
}

export function getTargetBBox() {
  return targetBBox;
}

export function getTargetColor() {
  return templatePatch !== null;
}