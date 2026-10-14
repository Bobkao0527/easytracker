// ncc.js
// 高性能積分圖 (Integral Image) 正規化互相關 (NCC) 模板匹配引擎
// 支援主執行緒與 Web Worker，將局部均值與方差計算自 O(M^2) 降至 O(1)

/**
 * 使用一階與二階積分圖進行高速 NCC 模板匹配
 * @param {ImageData|Object} searchData 包含 data (Uint8ClampedArray) 的影像物件
 * @param {number} searchW 搜尋區域寬度
 * @param {number} searchH 搜尋區域高度
 * @param {Object} tpl 模板物件 { data: Float32Array, norm: number, width: number, height: number }
 * @returns {{ score: number, x: number, y: number }}
 */
export function matchTemplateNCCIntegral(searchData, searchW, searchH, tpl) {
  const tW = tpl.width;
  const tH = tpl.height;
  const tData = tpl.data;
  const tNorm = tpl.norm || 1e-5;

  const numPixels = searchW * searchH;
  const tCount = tW * tH;

  // 1. 將搜尋區域轉換為灰階 Float32Array
  const sGray = new Float32Array(numPixels);
  const rgba = searchData.data;
  for (let i = 0; i < numPixels; i++) {
    const idx = i << 2;
    sGray[i] = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
  }

  // 2. 構建一階積分圖 S 與二階平方積分圖 S2 (大小為 (W+1) x (H+1))
  const tableW = searchW + 1;
  const tableH = searchH + 1;
  const S = new Float64Array(tableW * tableH);
  const S2 = new Float64Array(tableW * tableH);

  for (let y = 0; y < searchH; y++) {
    let rowSum = 0;
    let rowSumSq = 0;
    const inRow = y * searchW;
    const outRow = (y + 1) * tableW;
    const prevOutRow = y * tableW;

    for (let x = 0; x < searchW; x++) {
      const val = sGray[inRow + x];
      rowSum += val;
      rowSumSq += val * val;
      S[outRow + x + 1] = S[prevOutRow + x + 1] + rowSum;
      S2[outRow + x + 1] = S2[prevOutRow + x + 1] + rowSumSq;
    }
  }

  // 輔助函式：計算指定 (x, y) 偏移處的 NCC 分數
  function evaluateAt(x, y) {
    const x1 = x;
    const x2 = x + tW;
    const y1 = y;
    const y2 = y + tH;

    // 查積分圖：在 O(1) 內取得局部像素和與平方和
    const sum = S[y2 * tableW + x2] - S[y1 * tableW + x2] - S[y2 * tableW + x1] + S[y1 * tableW + x1];
    const sumSq = S2[y2 * tableW + x2] - S2[y1 * tableW + x2] - S2[y2 * tableW + x1] + S2[y1 * tableW + x1];

    // 方差計算：E[X^2] - (E[X])^2
    const variance = sumSq - (sum * sum) / tCount;
    const sNorm = variance > 0 ? Math.sqrt(variance) : 1e-5;
    const denom = sNorm * tNorm;

    // 計算互相關點積：sum(sGray * tData)
    let cross = 0;
    for (let ty = 0; ty < tH; ty++) {
      const sRow = (y + ty) * searchW + x;
      const tRow = ty * tW;
      for (let tx = 0; tx < tW; tx++) {
        cross += sGray[sRow + tx] * tData[tRow + tx];
      }
    }

    return cross / denom;
  }

  const maxOffsetX = searchW - tW;
  const maxOffsetY = searchH - tH;

  let bestScore = -1;
  let bestX = 0;
  let bestY = 0;

  // 階段 1：步長為 2 的快速粗篩（候選點減少至 1/4，計算量驟降 75%）
  const step = 2;
  for (let y = 0; y <= maxOffsetY; y += step) {
    for (let x = 0; x <= maxOffsetX; x += step) {
      const score = evaluateAt(x, y);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }

  // 階段 2：在粗篩峰值鄰域 ±2 像素內進行步長為 1 的精確微調
  const refineRadius = 2;
  const startX = Math.max(0, bestX - refineRadius);
  const endX = Math.min(maxOffsetX, bestX + refineRadius);
  const startY = Math.max(0, bestY - refineRadius);
  const endY = Math.min(maxOffsetY, bestY + refineRadius);

  for (let y = startY; y <= endY; y++) {
    for (let x = startX; x <= endX; x++) {
      const score = evaluateAt(x, y);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }

  return { score: bestScore, x: bestX, y: bestY };
}

