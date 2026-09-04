// standard.js
let calibrationPoints = [];
let pxPerMeter = null;

// ============================================================
// 座標轉換（去畸變 -> 透視校正 -> 傾角旋轉 -> 物理公尺轉換）
// ============================================================
export function transformCoordinates(rawX, rawY, options = {}) {
  const {
    imageWidth = 1920,
    imageHeight = 1080,
    k1 = 0,
    tiltAngleDeg = 0,
    homography = [1,0,0, 0,1,0, 0,0,1],
    originX = 0,
    originY = imageHeight,
    isAlreadyRectified = false // 👈 支援標記：是否已在 WebGL 校正後的畫布上
  } = options;

  let rectX = rawX;
  let rectY = rawY;

  // 若尚未校正（例如純 CPU 計算環境），才執行 k1 與 Homography
  if (!isAlreadyRectified) {
    let x = rawX;
    let y = rawY;
    const cx = imageWidth / 2;
    const cy = imageHeight / 2;
    const diag = Math.hypot(imageWidth, imageHeight) / 2;

    // 1. k1 去畸變
    if (k1 !== 0) {
      const dx = (rawX - cx) / diag;
      const dy = (rawY - cy) / diag;
      const r2 = dx * dx + dy * dy;
      const factor = 1 + k1 * r2;
      x = cx + (rawX - cx) * factor;
      y = cy + (rawY - cy) * factor;
    }

    // 2. 透視變換 Homography 映射
    const u = x / imageWidth;
    const v = y / imageHeight;
    const h = homography;
    const w_elem = h[6] * u + h[7] * v + h[8];
    rectX = Math.abs(w_elem) > 1e-7 ? ((h[0] * u + h[1] * v + h[2]) / w_elem) * imageWidth : x;
    rectY = Math.abs(w_elem) > 1e-7 ? ((h[3] * u + h[4] * v + h[5]) / w_elem) * imageHeight : y;
  }

  // 3. 換算相對於原點的螢幕差值 (Y軸轉為笛卡爾向上)
  const dx = rectX - originX;
  const dy = originY - rectY;

  // 4. 傾角旋轉 (依照使用者設定的角度轉正)
  const rad = (-tiltAngleDeg * Math.PI) / 180;
  const rotX = dx * Math.cos(rad) - dy * Math.sin(rad);
  const rotY = dx * Math.sin(rad) + dy * Math.cos(rad);

  const x_m = pxPerMeter ? rotX / pxPerMeter : 0;
  const y_m = pxPerMeter ? rotY / pxPerMeter : 0;

  return { x: rotX, y: rotY, x_m, y_m };
}

export function resetCalibration() {
  calibrationPoints = [];
  pxPerMeter = null;
}

export function addCalibrationPoint(x, y, realLengthInMeters) {
  calibrationPoints.push({ x, y });

  if (calibrationPoints.length === 2) {
    const [p1, p2] = calibrationPoints;
    const distPx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const realLen = parseFloat(realLengthInMeters) || 1.0;
    pxPerMeter = distPx / realLen;
    return { completed: true, pxPerMeter, points: calibrationPoints };
  }

  return { completed: false, pxPerMeter: null, points: calibrationPoints };
}

export function getPxPerMeter() {
  return pxPerMeter;
}

export function getCalibrationPoints() {
  return calibrationPoints;
}

// 點排序函數：[Top-Left, Top-Right, Bottom-Right, Bottom-Left]
function sortQuadPoints(pts) {
  const sortedY = [...pts].sort((a, b) => a.y - b.y);
  const topPts = [sortedY[0], sortedY[1]].sort((a, b) => a.x - b.x);
  const bottomPts = [sortedY[2], sortedY[3]].sort((a, b) => a.x - b.x);

  return {
    pTL: topPts[0],
    pTR: topPts[1],
    pBR: bottomPts[1],
    pBL: bottomPts[0]
  };
}

// 單條直線的 k1 計算
export function autoCalculateK1(linePoints, imageWidth, imageHeight) {
  const cx = imageWidth / 2;
  const cy = imageHeight / 2;
  const diag = Math.hypot(imageWidth, imageHeight) / 2;

  function evaluate(k1) {
    const pts = linePoints.map(p => {
      const dx = (p.x - cx) / diag;
      const dy = (p.y - cy) / diag;
      const factor = 1 + k1 * (dx * dx + dy * dy);
      return { x: cx + (p.x - cx) * factor, y: cy + (p.y - cy) * factor };
    });
    return getLineResidual(pts);
  }

  let bestK1 = 0;
  let minErr = Infinity;
  // 粗搜尋
  for (let k = -0.5; k <= 0.5; k += 0.01) {
    const err = evaluate(k);
    if (err < minErr) { minErr = err; bestK1 = k; }
  }
  // 細搜尋
  for (let k = bestK1 - 0.01; k <= bestK1 + 0.01; k += 0.001) {
    const err = evaluate(k);
    if (err < minErr) { minErr = err; bestK1 = k; }
  }
  return parseFloat(bestK1.toFixed(4));
}

export function calculatePerspectiveFromLines(fourLines, imageWidth, imageHeight) {
  // 兩點求直線方程式 Ax + By + C = 0
  const getLineEqFrom2Points = ([p1, p2]) => {
    const A = p2.y - p1.y;
    const B = p1.x - p2.x;
    const C = p2.x * p1.y - p1.x * p2.y;
    return { A, B, C };
  };

  // 畫面上看到的已經由 WebGL 拉直，直接使用使用者點選的 4 條直線
  const eqH1 = getLineEqFrom2Points(fourLines[0]);
  const eqH2 = getLineEqFrom2Points(fourLines[1]);
  const eqV1 = getLineEqFrom2Points(fourLines[2]);
  const eqV2 = getLineEqFrom2Points(fourLines[3]);

  // 求出 4 個交點
  const rawIntersections = [
    getIntersection(eqH1, eqV1),
    getIntersection(eqH1, eqV2),
    getIntersection(eqH2, eqV1),
    getIntersection(eqH2, eqV2)
  ];

  if (rawIntersections.some(p => !p)) {
    alert('偵測到線條平行或無交點，請重新選取！');
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }

  // 排序為 [左上 TL, 右上 TR, 右下 BR, 左下 BL]
  const { pTL, pTR, pBR, pBL } = sortQuadPoints(rawIntersections);

  // 計算平均寬度與高度
  const targetW = (Math.hypot(pTR.x - pTL.x, pTR.y - pTL.y) + Math.hypot(pBR.x - pBL.x, pBR.y - pBL.y)) / 2;
  const targetH = (Math.hypot(pBL.x - pTL.x, pBL.y - pTL.y) + Math.hypot(pBR.x - pTR.x, pBR.y - pTR.y)) / 2;

  const centerQuadX = (pTL.x + pTR.x + pBR.x + pBL.x) / 4;
  const centerQuadY = (pTL.y + pTR.y + pBR.y + pBL.y) / 4;

  const dstTL = { x: (centerQuadX - targetW / 2) / imageWidth, y: (centerQuadY - targetH / 2) / imageHeight };
  const dstTR = { x: (centerQuadX + targetW / 2) / imageWidth, y: (centerQuadY - targetH / 2) / imageHeight };
  const dstBR = { x: (centerQuadX + targetW / 2) / imageWidth, y: (centerQuadY + targetH / 2) / imageHeight };
  const dstBL = { x: (centerQuadX - targetW / 2) / imageWidth, y: (centerQuadY + targetH / 2) / imageHeight };

  const src = [
    { u: dstTL.x, v: dstTL.y, x: pTL.x / imageWidth, y: pTL.y / imageHeight },
    { u: dstTR.x, v: dstTR.y, x: pTR.x / imageWidth, y: pTR.y / imageHeight },
    { u: dstBR.x, v: dstBR.y, x: pBR.x / imageWidth, y: pBR.y / imageHeight },
    { u: dstBL.x, v: dstBL.y, x: pBL.x / imageWidth, y: pBL.y / imageHeight }
  ];

  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { u, v, x, y } = src[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }

  const h = solve8x8(A, b);
  return h ? [...h, 1.0] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

function solve8x8(A, b) {
  const n = 8;
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) maxRow = k;
    }
    [A[i], A[maxRow]] = [A[maxRow], A[i]];
    [b[i], b[maxRow]] = [b[maxRow], b[i]];

    if (Math.abs(A[i][i]) < 1e-10) return null;

    for (let k = i + 1; k < n; k++) {
      const c = A[k][i] / A[i][i];
      for (let j = i; j < n; j++) {
        A[k][j] -= c * A[i][j];
      }
      b[k] -= c * b[i];
    }
  }

  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = 0;
    for (let j = i + 1; j < n; j++) {
      sum += A[i][j] * x[j];
    }
    x[i] = (b[i] - sum) / A[i][i];
  }
  return x;
}

function getLineResidual(pts) {
  const n = pts.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += pts[i].x; my += pts[i].y; }
  mx /= n; my /= n;

  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts[i].x - mx;
    const dy = pts[i].y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const diff = sxx - syy;
  return (sxx + syy - Math.sqrt(diff * diff + 4 * sxy * sxy)) / 2;
}

function fitLineEquation(pts) {
  const n = pts.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += pts[i].x; my += pts[i].y; }
  mx /= n; my /= n;

  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts[i].x - mx;
    const dy = pts[i].y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(-2 * sxy, syy - sxx);
  const A = Math.cos(theta);
  const B = Math.sin(theta);
  const C = -(A * mx + B * my);
  return { A, B, C };
}

function getIntersection(l1, l2) {
  const det = l1.A * l2.B - l2.A * l1.B;
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (l1.B * l2.C - l2.B * l1.C) / det,
    y: (l2.A * l1.C - l1.A * l2.C) / det
  };
}