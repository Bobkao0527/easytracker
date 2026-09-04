// track.js
// 基於 NCC 模板匹配的高精度逐幀追蹤模組

let templatePatch = null; // 目標模板像素資料
let targetBBox = null;
let templateSize = 32;    // 模板尺寸 (px)，可依物體大小調整

export function resetTrackState() {
  templatePatch = null;
  targetBBox = null;
}

export function setROI(x, y, width, height) {
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  };
}

// 選取目標：擷取整塊區域作為模板並預先計算均值與標準差
export function selectTarget(x, y, ctx, size = 32) {
  templateSize = size;
  const half = Math.floor(size / 2);
  const startX = Math.round(x - half);
  const startY = Math.round(y - half);

  targetBBox = {
    x: startX,
    y: startY,
    width: size,
    height: size
  };

  const imgData = ctx.getImageData(startX, startY, size, size);
  const gray = new Float32Array(size * size);
  let sum = 0;

  // 轉為灰階 (ITU-R BT.601 亮度加權)
  for (let i = 0; i < gray.length; i++) {
    const idx = i << 2;
    const g = 0.299 * imgData.data[idx] + 0.587 * imgData.data[idx + 1] + 0.114 * imgData.data[idx + 2];
    gray[i] = g;
    sum += g;
  }

  const mean = sum / gray.length;
  let variance = 0;
  for (let i = 0; i < gray.length; i++) {
    gray[i] -= mean; // 零均值化
    variance += gray[i] * gray[i];
  }
  const norm = Math.sqrt(variance) || 1e-5;

  templatePatch = {
    data: gray,
    norm: norm,
    width: size,
    height: size
  };

  return { targetBBox, targetColor: true };
}

// 快速正規化互相關 (NCC) 匹配
function matchTemplateNCC(searchData, searchW, searchH, tpl) {
  const tW = tpl.width;
  const tH = tpl.height;
  const tData = tpl.data;
  const tNorm = tpl.norm;

  // 先將搜尋區域整塊轉灰階
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

  // 滑動窗口比對
  for (let y = 0; y <= maxOffsetY; y++) {
    for (let x = 0; x <= maxOffsetX; x++) {
      let sum = 0;
      let sVar = 0;
      let cross = 0;

      // 1. 計算該窗口均值
      for (let ty = 0; ty < tH; ty++) {
        const row = (y + ty) * searchW + x;
        for (let tx = 0; tx < tW; tx++) {
          sum += sGray[row + tx];
        }
      }
      const sMean = sum / (tW * tH);

      // 2. 計算相關度
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

  return {
    score: bestScore,
    x: bestX,
    y: bestY
  };
}

// seekTo Promise
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

export function drawTrackingGizmo(ctx, {
  searchX, searchY, searchW, searchH,
  searchCenterX, searchCenterY, searchRadius,
  matchBox,      // { x, y, width, height }
  centerX, centerY,
  isLost = false
}) {
  ctx.save();

  // 1. 【追蹤半徑搜尋區域】(若遺失目標則呈紅色，否則為橙黃色)
  const searchColor = isLost ? '#ef4444' : '#f59e0b';
  const searchFill = isLost ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.06)';

  // (a) 繪製實際送進演算法 NCC 運算的矩形 Search Window
  ctx.strokeStyle = searchColor;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.fillStyle = searchFill;
  ctx.fillRect(searchX, searchY, searchW, searchH);
  ctx.strokeRect(searchX, searchY, searchW, searchH);

  // (b) 繪製等距搜尋半徑 (R) 圓形輔助線，方便肉眼判斷搜尋界限
  if (searchCenterX !== undefined && searchCenterY !== undefined && searchRadius) {
    ctx.beginPath();
    ctx.arc(searchCenterX, searchCenterY, searchRadius, 0, Math.PI * 2);
    ctx.strokeStyle = isLost ? 'rgba(239, 68, 68, 0.4)' : 'rgba(245, 158, 11, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.setLineDash([]); // 還原實線

  // 2. 【演算法計算區域 (Matched Patch)】
  if (!isLost && matchBox) {
    ctx.strokeStyle = '#22c55e'; // 鮮綠色
    ctx.lineWidth = 2;
    ctx.strokeRect(matchBox.x, matchBox.y, matchBox.width, matchBox.height);

    // 四角亮角標記（提升辨識度）
    const corner = Math.min(6, matchBox.width / 4);
    ctx.lineWidth = 3;
    // 左上
    ctx.beginPath();
    ctx.moveTo(matchBox.x, matchBox.y + corner);
    ctx.lineTo(matchBox.x, matchBox.y);
    ctx.lineTo(matchBox.x + corner, matchBox.y);
    // 右上
    ctx.moveTo(matchBox.x + matchBox.width - corner, matchBox.y);
    ctx.lineTo(matchBox.x + matchBox.width, matchBox.y);
    ctx.lineTo(matchBox.x + matchBox.width, matchBox.y + corner);
    // 左下
    ctx.moveTo(matchBox.x, matchBox.y + matchBox.height - corner);
    ctx.lineTo(matchBox.x, matchBox.y + matchBox.height);
    ctx.lineTo(matchBox.x + corner, matchBox.y + matchBox.height);
    // 右下
    ctx.moveTo(matchBox.x + matchBox.width - corner, matchBox.y + matchBox.height);
    ctx.lineTo(matchBox.x + matchBox.width, matchBox.y + matchBox.height);
    ctx.lineTo(matchBox.x + matchBox.width, matchBox.y + matchBox.height - corner);
    ctx.stroke();
  }

  // 3. 【中心點與十字準心 (Center Crosshair)】
  const cx = isLost ? searchCenterX : centerX;
  const cy = isLost ? searchCenterY : centerY;
  if (cx !== undefined && cy !== undefined) {
    const crossSize = 7;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = isLost ? '#ef4444' : '#22c55e';

    // 十字準心
    ctx.beginPath();
    ctx.moveTo(cx - crossSize, cy);
    ctx.lineTo(cx + crossSize, cy);
    ctx.moveTo(cx, cy - crossSize);
    ctx.lineTo(cx, cy + crossSize);
    ctx.stroke();

    // 中心靶心圓點
    ctx.fillStyle = isLost ? '#ef4444' : '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// 自動追蹤主循環
export async function runAutoTrack({
  video,
  canvas,
  pxPerMeter,
  searchRadius = 60,
  renderFrame,
  transformCoords,
  onFrameUpdate,
  isTrackingCheck
}) {
  if (!targetBBox || !templatePatch || !video) {
    return [];
  }

  const ctx = canvas.getContext('2d');
  const trackingData = [];
  const fps = 30;
  const frameDuration = 1 / fps;
  let frameIdx = 0;

  let currentCenterX = targetBBox.x + targetBBox.width / 2;
  let currentCenterY = targetBBox.y + targetBBox.height / 2;
  const originalTime = video.currentTime;

  for (let t = 0; t < video.duration; t += frameDuration) {
    if (typeof isTrackingCheck === 'function' && !isTrackingCheck()) break;

    await seekTo(video, t);

    // 渲染無網格影格供辨識
    if (typeof renderFrame === 'function') {
      renderFrame(false);
    } else {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }

    // 搜尋區塊大小（半徑 + 模板大小擴展）
    const halfT = Math.floor(templateSize / 2);
    const searchX = Math.max(0, Math.min(canvas.width - searchRadius * 2, currentCenterX - searchRadius));
    const searchY = Math.max(0, Math.min(canvas.height - searchRadius * 2, currentCenterY - searchRadius));
    const searchW = Math.min(searchRadius * 2, canvas.width - searchX);
    const searchH = Math.min(searchRadius * 2, canvas.height - searchY);

    if (searchW >= templateSize && searchH >= templateSize) {
  const searchImgData = ctx.getImageData(searchX, searchY, searchW, searchH);
  const match = matchTemplateNCC(searchImgData, searchW, searchH, templatePatch);

  // 重新繪製影格底圖與網格
  if (typeof renderFrame === 'function') {
      renderFrame(true);
    }

    if (match.score >= 0.55) {
      const cx = searchX + match.x + halfT;
      const cy = searchY + match.y + halfT;
      currentCenterX = cx;
      currentCenterY = cy;

      let x_m = 0;
      let y_m = 0;
      if (typeof transformCoords === 'function') {
        const trans = transformCoords(cx, cy);
        x_m = trans.x_m;
        y_m = trans.y_m;
      } else {
        x_m = pxPerMeter ? cx / pxPerMeter : 0;
        y_m = pxPerMeter ? (canvas.height - cy) / pxPerMeter : 0;
      }

      const frameRes = {
        frame: frameIdx,
        time: t.toFixed(3),
        x_px: cx.toFixed(1),
        y_px: cy.toFixed(1),
        x_m: Number(x_m).toFixed(4),
        y_m: Number(y_m).toFixed(4),
        score: match.score.toFixed(3),
        cx,
        cy,
        timestamp: t * 1_000_000
      };

      trackingData.push(frameRes);

      // ✨ 呼叫精準呈現：搜尋半徑區域 + 演算法比對框 + 十字中心點
      drawTrackingGizmo(ctx, {
        searchX, searchY, searchW, searchH,
        searchCenterX: currentCenterX,
        searchCenterY: currentCenterY,
        searchRadius,
        matchBox: {
          x: cx - halfT,
          y: cy - halfT,
          width: templateSize,
          height: templateSize
        },
        centerX: cx,
        centerY: cy,
        isLost: false
      });

      if (onFrameUpdate) {
        onFrameUpdate(frameRes, trackingData);
      }
    } else {
      // ⚠️ 目標遺失時，以紅色警示搜尋區域
      console.warn(`第 ${frameIdx} 幀目標遺失 (NCC 最高得分僅 ${match.score.toFixed(2)})`);
      drawTrackingGizmo(ctx, {
        searchX, searchY, searchW, searchH,
        searchCenterX: currentCenterX,
        searchCenterY: currentCenterY,
        searchRadius,
        isLost: true
      });
    }
  }
    frameIdx++;
    await new Promise(r => setTimeout(r, 0));
  }

  await seekTo(video, originalTime);
  return trackingData;
}

export function getTargetBBox() {
  return targetBBox;
}

export function getTargetColor() {
  return templatePatch !== null;
}