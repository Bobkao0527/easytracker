// standard.js
let calibrationPoints = [];
let pxPerMeter = null;
const DEFAULT_PX_PER_METER = 1000; // 預設 1000 px/m

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
    isAlreadyRectified = false
  } = options;

  let rectX = rawX;
  let rectY = rawY;

  // 若尚未在 WebGL 校正，才執行 CPU 端的 k1 與 Homography 映射
  if (!isAlreadyRectified) {
    let x = rawX;
    let y = rawY;
    const cx = imageWidth / 2;
    const cy = imageHeight / 2;
    const diag = Math.hypot(imageWidth, imageHeight) / 2;

    if (k1 !== 0) {
      const dx = (rawX - cx) / diag;
      const dy = (rawY - cy) / diag;
      const factor = 1 + k1 * (dx * dx + dy * dy);
      x = cx + (rawX - cx) * factor;
      y = cy + (rawY - cy) * factor;
    }

    const invH = invert3x3(homography) || [1,0,0, 0,1,0, 0,0,1];
    const w_elem = invH[6] * x + invH[7] * y + invH[8];
    rectX = Math.abs(w_elem) > 1e-7 ? (invH[0] * x + invH[1] * y + invH[2]) / w_elem : x;
    rectY = Math.abs(w_elem) > 1e-7 ? (invH[3] * x + invH[4] * y + invH[5]) / w_elem : y;
  }

  // 相對於自訂原點
  const dx = rectX - originX;
  const dy = originY - rectY; // 笛卡爾座標 Y 軸向上為正

  // 傾角轉正
  const rad = (-tiltAngleDeg * Math.PI) / 180;
  const rotX = dx * Math.cos(rad) - dy * Math.sin(rad);
  const rotY = dx * Math.sin(rad) + dy * Math.cos(rad);

  const scale = (pxPerMeter && pxPerMeter > 0) ? pxPerMeter : DEFAULT_PX_PER_METER;
  const x_m = rotX / scale;
  const y_m = rotY / scale;

  return { x: rotX, y: rotY, x_m, y_m };
}

export function resetCalibration() {
  calibrationPoints = [];
  pxPerMeter = DEFAULT_PX_PER_METER; // 重設時也保留預設值
}

export function setPxPerMeter(val) {
  pxPerMeter = val;
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

  return { completed: false, pxPerMeter, points: calibrationPoints };
}

export function getPxPerMeter() {
  return pxPerMeter;
}

// 額外匯出一個輔助函式，方便 UI 判斷是否為使用者自訂的標定
export function isUserCalibrated() {
  return calibrationPoints.length === 2;
}

export function getCalibrationPoints() {
  return calibrationPoints;
}

// ============================================================
// ★ 平面矩形 4 點透視校正（像素空間 DLT，獨立於焦距 f）
// ============================================================
export function calculateHomographyFrom4Points(corners, imgW, imgH) {
  if (!corners || corners.length !== 4) {
    throw new Error('必須提供 4 個角點 (左上, 右上, 右下, 左下)');
  }

  const [c0, c1, c2, c3] = corners;
  const Vz = getLineIntersection(c3, c0, c2, c1);
  const Vx = getLineIntersection(c0, c1, c3, c2);

  const cx = imgW / 2;
  const cy = imgH / 2;

  let f = Math.hypot(imgW, imgH);
  if (Vz && Vx) {
    const vZx = Vz.x - cx;
    const vZy = Vz.y - cy;
    const vXx = Vx.x - cx;
    const vXy = Vx.y - cy;
    const fSquared = -(vZx * vXx + vZy * vXy);
    if (fSquared > 0) {
      const computedF = Math.sqrt(fSquared);
      if (computedF > imgW * 0.3 && computedF < imgW * 3.0) {
        f = computedF;
      }
    }
  }

  let dZ = Vz ? [Vz.x - cx, Vz.y - cy, f] : [0, 0, f];
  if (dZ[2] < 0) dZ = [-dZ[0], -dZ[1], -dZ[2]];
  const uZ = normalize3(dZ);

  let dX = Vx ? [Vx.x - cx, Vx.y - cy, f] : [1, 0, 0];
  if (dot3(dX, [1, 0, 0]) < 0) dX = [-dX[0], -dX[1], -dX[2]];

  let uY = cross3(uZ, dX);
  uY = normalize3(uY);
  if (dot3(uY, [0, 1, 0]) < 0) uY = [-uY[0], -uY[1], -uY[2]];

  const uX = normalize3(cross3(uY, uZ));

  const R = [
    uX[0], uY[0], uZ[0],
    uX[1], uY[1], uZ[1],
    uX[2], uY[2], uZ[2]
  ];

  const K = [f, 0, cx,  0, f, cy,  0, 0, 1];
  const K_inv = [1 / f, 0, -cx / f,  0, 1 / f, -cy / f,  0, 0, 1];

  const H_pixel = multiply3x3(multiply3x3(K, R), K_inv);
  const H_uv = convertPixelHomographyToUV(H_pixel, imgW, imgH);

  // 只回傳單應性矩陣與輔助資訊，定標交給獨立的定標模組
  return {
    homography: H_uv,
    rectifiedBox: { f, Vz, Vx }
  };
}

function getLineIntersection(p1, p2, p3, p4) {
  const a1 = p1.y - p2.y;
  const b1 = p2.x - p1.x;
  const c1 = p1.x * p2.y - p2.x * p1.y;

  const a2 = p3.y - p4.y;
  const b2 = p4.x - p3.x;
  const c2 = p3.x * p4.y - p4.x * p3.y;

  const D = a1 * b2 - a2 * b1;
  if (Math.abs(D) < 1e-6) return null; // 兩線近乎平行
  return {
    x: (b1 * c2 - b2 * c1) / D,
    y: (c1 * a2 - c2 * a1) / D
  };
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function multiply3x3(A, B) {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      C[r * 3 + c] = 
        A[r * 3 + 0] * B[0 * 3 + c] +
        A[r * 3 + 1] * B[1 * 3 + c] +
        A[r * 3 + 2] * B[2 * 3 + c];
    }
  }
  return C;
}

function convertPixelHomographyToUV(H, w, h) {
  // H_uv = S_src_inv * H * S_dst
  // S_dst : [w, 0, 0; 0, h, 0; 0, 0, 1]
  // S_src_inv : [1/w, 0, 0; 0, 1/h, 0; 0, 0, 1]
  return [
    H[0],         H[1] * h / w, H[2] / w,
    H[3] * w / h, H[4],         H[5] / h,
    H[6] * w,     H[7] * h,     H[8]
  ];
}

function invert3x3(m) {
  const n00 = m[0], n01 = m[1], n02 = m[2];
  const n10 = m[3], n11 = m[4], n12 = m[5];
  const n20 = m[6], n21 = m[7], n22 = m[8];

  const t00 = n11 * n22 - n12 * n21;
  const t01 = n02 * n21 - n01 * n22;
  const t02 = n01 * n12 - n02 * n11;

  const det = n00 * t00 + n10 * t01 + n20 * t02;
  if (Math.abs(det) < 1e-8) return null;

  const invDet = 1.0 / det;
  return [
    t00 * invDet,
    t01 * invDet,
    t02 * invDet,
    (n12 * n20 - n10 * n22) * invDet,
    (n00 * n22 - n02 * n20) * invDet,
    (n02 * n10 - n00 * n12) * invDet,
    (n10 * n21 - n11 * n20) * invDet,
    (n01 * n20 - n00 * n21) * invDet,
    (n00 * n11 - n01 * n10) * invDet
  ];
}

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
  for (let k = -0.5; k <= 0.5; k += 0.01) {
    const err = evaluate(k);
    if (err < minErr) { minErr = err; bestK1 = k; }
  }
  for (let k = bestK1 - 0.01; k <= bestK1 + 0.01; k += 0.001) {
    const err = evaluate(k);
    if (err < minErr) { minErr = err; bestK1 = k; }
  }
  return parseFloat(bestK1.toFixed(4));
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