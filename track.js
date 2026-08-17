// 追蹤模組：負責目標選取、質心計算、逐幀自動追蹤

let targetBBox = null;
let targetColor = null;

/**
 * 重置追蹤狀態
 */
export function resetTrackState() {
  targetBBox = null;
  targetColor = null;
}

/**
 * 選取目標中心，建立追蹤框與顏色特徵
 * @param {number} x - 點擊的 x 座標（像素）
 * @param {number} y - 點擊的 y 座標（像素）
 * @param {CanvasRenderingContext2D} ctx - 畫布 context
 * @returns {{ targetBBox: object, targetColor: object }}
 */
export function selectTarget(x, y, ctx) {
  const boxSize = 36;
  targetBBox = {
    x: Math.round(x - boxSize / 2),
    y: Math.round(y - boxSize / 2),
    width: boxSize,
    height: boxSize
  };

  const pixel = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  targetColor = { r: pixel[0], g: pixel[1], b: pixel[2] };

  return { targetBBox, targetColor };
}

/**
 * 基於顏色相似度加權的質心計算
 * @param {ImageData} imageData - ROI 區域的像素資料
 * @param {{ r: number, g: number, b: number }} colorTarget - 目標顏色
 * @returns {{ cx: number, cy: number } | null}
 */
export function computeCentroid(imageData, colorTarget) {
  const data = imageData.data;
  const w = imageData.width;
  const h = imageData.height;
  const tr = colorTarget.r;
  const tg = colorTarget.g;
  const tb = colorTarget.b;

  let m00 = 0, m10 = 0, m01 = 0;

  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    for (let x = 0; x < w; x++) {
      const idx = (rowOffset + x) << 2; // 等同 * 4，位元運算更快
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      // 使用整數運算計算顏色差異
      const diff = (r > tr ? r - tr : tr - r)
        + (g > tg ? g - tg : tg - g)
        + (b > tb ? b - tb : tb - b);

      if (diff < 155) { // 相當於 weight > 100（255 - diff > 100）
        const weight = 255 - diff;
        m00 += weight;
        m10 += x * weight;
        m01 += y * weight;
      }
    }
  }

  if (m00 === 0) return null;
  return { cx: m10 / m00, cy: m01 / m00 };
}

/**
 * 逐幀 seek 的 Promise 封裝
 * @param {HTMLVideoElement} video - 影片元素
 * @param {number} time - 目標時間（秒）
 */
function seekTo(video, time) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
  });
}

/**
 * 執行自動追蹤
 * @param {object} params
 * @param {HTMLVideoElement} params.video - 影片元素
 * @param {HTMLCanvasElement} params.canvas - 畫布元素
 * @param {number} params.pxPerMeter - 像素/公尺比例
 * @param {function} params.onFrameUpdate - 每幀更新回呼
 * @param {function} params.isTrackingCheck - 檢查是否仍在追蹤中
 * @returns {Promise<Array>} - 追蹤資料陣列
 */
export async function runAutoTrack({ video, canvas, pxPerMeter, onFrameUpdate, isTrackingCheck }) {
  if (!pxPerMeter || !targetBBox || !targetColor) return [];

  const trackingData = [];
  const fps = 30;
  const frameDuration = 1 / fps;
  let frameIdx = 0;
  let currentBBox = { ...targetBBox };

  const roiWidth = targetBBox.width;
  const roiHeight = targetBBox.height;
  const offCanvas = new OffscreenCanvas(roiWidth, roiHeight);
  const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

  const totalFrames = Math.floor(video.duration / frameDuration);

  for (let t = 0; t < video.duration; t += frameDuration) {
    if (!isTrackingCheck()) break;

    await seekTo(video, t);

    const cropX = Math.max(0, Math.min(canvas.width - roiWidth, currentBBox.x));
    const cropY = Math.max(0, Math.min(canvas.height - roiHeight, currentBBox.y));

    offCtx.drawImage(video, cropX, cropY, roiWidth, roiHeight, 0, 0, roiWidth, roiHeight);
    const roiData = offCtx.getImageData(0, 0, roiWidth, roiHeight);
    const localCentroid = computeCentroid(roiData, targetColor);

    let cx = cropX + roiWidth / 2;
    let cy = cropY + roiHeight / 2;

    if (localCentroid) {
      cx = cropX + localCentroid.cx;
      cy = cropY + localCentroid.cy;

      currentBBox.x = Math.max(0, Math.min(canvas.width - roiWidth, Math.round(cx - roiWidth / 2)));
      currentBBox.y = Math.max(0, Math.min(canvas.height - roiHeight, Math.round(cy - roiHeight / 2)));
    }

    // 轉換座標原點至左下角
    const x_m = cx / pxPerMeter;
    const y_m = (canvas.height - cy) / pxPerMeter;

    const frameResult = {
      frame: frameIdx,
      time: t.toFixed(3),
      x_px: cx.toFixed(1),
      y_px: cy.toFixed(1),
      x_m: x_m.toFixed(4),
      y_m: y_m.toFixed(4)
    };

    trackingData.push(frameResult);

    // 每 5 幀或最後一幀觸發 UI 與 Chart 繪製（修復：renderChart 移入條件內）
    if (frameIdx % 5 === 0 || frameIdx === totalFrames - 1) {
      if (onFrameUpdate) {
        onFrameUpdate({
          frameIdx,
          totalFrames,
          currentBBox,
          currentPos: { x: cx, y: cy },
          trackingData
        });
      }

      // 每 15 幀讓出 CPU 讓瀏覽器處理 UI 更新與 GC
      if (frameIdx % 15 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    frameIdx++;
  }

  return trackingData;
}

export function getTargetBBox() {
  return targetBBox;
}

export function getTargetColor() {
  return targetColor;
}