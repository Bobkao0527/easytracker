// trackWorker.js
// 高速影音解碼 Worker
//
// 設計：
// 1. Worker 長駐，不重建 VideoDecoder
// 2. 一次接收一個 GOP 任務
// 3. GOP 內依序送入 WebCodecs VideoDecoder
// 4. VideoFrame 在 Worker 內直接做 ROI + 質心計算
// 5. 結果批次回傳，降低 postMessage 次數
// 6. GOP 完成後回報 WORK_COMPLETE，等待下一個任務
//
// 注意：
// Worker 不負責決定下一個 GOP。
// 下一個 GOP 由 track.js 的 Worker Queue 分派。

// ============================================================
// Worker 狀態
// ============================================================

let videoDecoder = null;
let roiConfig = null;
let targetColorConfig = null;
let pxPerMeterConfig = 0;
let canvasHeightConfig = 0;
let decoderReady = false;
let currentTaskId = null;
let pendingResults = [];

// ============================================================
// Worker 內的 OffscreenCanvas
// ============================================================

let offscreenCanvas = null;
let offscreenCtx = null;

// ============================================================
// 初始化 ROI Canvas
// ============================================================

function initializeCanvas(roi) {
  if (!roi || roi.width <= 0 || roi.height <= 0) {
    throw new Error('ROI 尺寸無效');
  }

  offscreenCanvas = new OffscreenCanvas(
    roi.width,
    roi.height
  );

  offscreenCtx = offscreenCanvas.getContext('2d', {
    willReadFrequently: true
  });

  if (!offscreenCtx) {
    throw new Error('無法建立 OffscreenCanvas 2D Context');
  }
}

// ============================================================
// 顏色距離 + 質心
// ============================================================

function computeCentroidInWorker(imageData, colorTarget) {
  if (!imageData || !imageData.data || !colorTarget) {
    return null;
  }

  const data = imageData.data;
  const width = imageData.width;
  const height = imageData.height;

  const tr = colorTarget.r;
  const tg = colorTarget.g;
  const tb = colorTarget.b;

  let m00 = 0;
  let m10 = 0;
  let m01 = 0;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;

    for (let x = 0; x < width; x++) {
      const idx = (rowOffset + x) << 2;

      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      // Manhattan RGB distance
      const diff =
        Math.abs(r - tr) +
        Math.abs(g - tg) +
        Math.abs(b - tb);

      // 顏色門檻
      if (diff < 155) {
        const weight = 255 - diff;

        m00 += weight;
        m10 += x * weight;
        m01 += y * weight;
      }
    }
  }

  if (m00 <= 0) {
    return null;
  }

  return {
    cx: m10 / m00,
    cy: m01 / m00
  };
}

// ============================================================
// VideoFrame → ROI → Centroid
// ============================================================

function processVideoFrame(frame) {
  if (!offscreenCtx || !roiConfig || !targetColorConfig) {
    return null;
  }

  // ROI 裁切
  offscreenCtx.drawImage(
    frame,
    roiConfig.x,
    roiConfig.y,
    roiConfig.width,
    roiConfig.height,
    0,
    0,
    roiConfig.width,
    roiConfig.height
  );

  // 取得像素
  const imageData = offscreenCtx.getImageData(
    0,
    0,
    roiConfig.width,
    roiConfig.height
  );

  // 質心
  const centroid = computeCentroidInWorker(
    imageData,
    targetColorConfig
  );

  // 如果找不到目標
  let cx = roiConfig.x + roiConfig.width / 2;
  let cy = roiConfig.y + roiConfig.height / 2;

  if (centroid) {
    cx = roiConfig.x + centroid.cx;
    cy = roiConfig.y + centroid.cy;
  }

  // 時間
  const time = frame.timestamp / 1_000_000;

  // 座標轉換
  const x_m = cx / pxPerMeterConfig;
  const y_m =
    (canvasHeightConfig - cy) /
    pxPerMeterConfig;

  return {
    time,
    x_px: cx,
    y_px: cy,
    x_m,
    y_m,
    cx,
    cy,
    timestamp: frame.timestamp
  };
}

// ============================================================
// 建立 VideoDecoder
// ============================================================

function createDecoder(decoderConfig) {
  if (!decoderConfig) {
    throw new Error('缺少 VideoDecoderConfig');
  }

  if (typeof VideoDecoder === 'undefined') {
    throw new Error(
      '目前瀏覽器不支援 WebCodecs VideoDecoder'
    );
  }

  videoDecoder = new VideoDecoder({
    output(frame) {
      try {
        const result = processVideoFrame(frame);

        if (result) {
          pendingResults.push(result);
        }
      } catch (err) {
        self.postMessage({
          type: 'FRAME_ERROR',
          payload: {
            message: err?.message || String(err)
          }
        });
      } finally {
        // VideoFrame 使用完一定要 close()
        frame.close();
      }
    },

    error(err) {
      decoderReady = false;

      self.postMessage({
        type: 'ERROR',
        payload: {
          message: err?.message || String(err)
        }
      });
    }
  });

  try {
    videoDecoder.configure(decoderConfig);
    decoderReady = true;
  } catch (err) {
    decoderReady = false;
    throw err;
  }
}

// ============================================================
// INIT
// ============================================================

async function handleInit(payload) {
  const {
    decoderConfig,
    roi,
    targetColor,
    pxPerMeter,
    canvasHeight
  } = payload;

  if (!roi) {
    throw new Error('INIT 缺少 ROI');
  }

  if (!targetColor) {
    throw new Error('INIT 缺少 targetColor');
  }

  if (!pxPerMeter || pxPerMeter <= 0) {
    throw new Error('INIT 缺少有效 pxPerMeter');
  }

  if (!canvasHeight || canvasHeight <= 0) {
    throw new Error('INIT 缺少有效 canvasHeight');
  }

  roiConfig = {
    x: Math.round(roi.x),
    y: Math.round(roi.y),
    width: Math.round(roi.width),
    height: Math.round(roi.height)
  };

  targetColorConfig = {
    r: targetColor.r,
    g: targetColor.g,
    b: targetColor.b
  };

  pxPerMeterConfig = pxPerMeter;
  canvasHeightConfig = canvasHeight;

  initializeCanvas(roiConfig);

  // 如果已有 Decoder，先關掉
  if (videoDecoder) {
    try {
      videoDecoder.close();
    } catch (_) {}

    videoDecoder = null;
  }

  decoderReady = false;

  // 建立 Decoder
  createDecoder(decoderConfig);

  self.postMessage({
    type: 'READY'
  });
}

// ============================================================
// 解碼單一 GOP
// ============================================================
//
// payload:
// {
//   taskId,
//   samples: [
//     {
//       type,
//       timestamp,
//       duration,
//       data
//     },
//     ...
//   ]
// }
//
// ============================================================

async function handleDecodeGOP(payload) {
  if (!decoderReady || !videoDecoder) {
    throw new Error('VideoDecoder 尚未 READY');
  }

  const { taskId, samples } = payload;

  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('GOP 沒有有效 Samples');
  }

  currentTaskId = taskId;
  pendingResults = [];

  try {
    // 將 GOP 的所有 EncodedVideoChunk 放進 decoder queue
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];

      if (!sample) {
        continue;
      }

      const chunk = new EncodedVideoChunk({
        type: sample.type,
        timestamp: sample.timestamp,
        duration: sample.duration,
        data: sample.data
      });

      videoDecoder.decode(chunk);
    }

    // flush() 會等待目前 decoder queue 中的 frame 全部輸出
    await videoDecoder.flush();

    // 排序，增加穩定性
    pendingResults.sort(
      (a, b) => a.timestamp - b.timestamp
    );

    // 批次傳回主執行緒
    self.postMessage({
      type: 'GOP_COMPLETE',
      payload: {
        taskId,
        results: pendingResults
      }
    });

    pendingResults = [];
    currentTaskId = null;
  } catch (err) {
    pendingResults = [];
    currentTaskId = null;
    throw err;
  }
}

// ============================================================
// RESET
// ============================================================
//
// 如果未來 track.js 要重新使用 Worker，
// 可以先 RESET 再 INIT。
// ============================================================

function handleReset() {
  pendingResults = [];
  currentTaskId = null;

  if (videoDecoder) {
    try {
      videoDecoder.reset();
    } catch (_) {}
  }

  decoderReady = false;

  self.postMessage({
    type: 'RESET_COMPLETE'
  });
}

// ============================================================
// CLOSE
// ============================================================

function handleClose() {
  pendingResults = [];
  currentTaskId = null;

  if (videoDecoder) {
    try {
      videoDecoder.close();
    } catch (_) {}

    videoDecoder = null;
  }

  decoderReady = false;
  offscreenCanvas = null;
  offscreenCtx = null;

  self.postMessage({
    type: 'CLOSED'
  });
}

// ============================================================
// Worker Message Handler
// ============================================================

self.onmessage = async event => {
  const { type, payload } = event.data || {};

  try {
    // INIT
    if (type === 'INIT') {
      await handleInit(payload);
      return;
    }

    // DECODE_GOP
    if (type === 'DECODE_GOP') {
      await handleDecodeGOP(payload);
      return;
    }

    // RESET
    if (type === 'RESET') {
      handleReset();
      return;
    }

    // CLOSE
    if (type === 'CLOSE') {
      handleClose();
      return;
    }

    // 未知命令
    self.postMessage({
      type: 'ERROR',
      payload: {
        message: `未知 Worker 指令：${type}`
      }
    });
  } catch (err) {
    console.error(
      'trackWorker 發生錯誤:',
      err
    );

    self.postMessage({
      type: 'ERROR',
      payload: {
        taskId: payload?.taskId ?? null,
        message: err?.message || String(err)
      }
    });
  }
};