// track.js
// 追蹤模組
// 高速版：MP4Box + WebCodecs + Dynamic Worker Queue
//
// 搭配：trackWorker.js
//
// 架構：
// MP4Box → Samples → GOP Queue → Dynamic Worker Pool
// → Worker 完成 GOP → 立即取得下一個 GOP → 最後依 timestamp 排序

// ============================================================
// 全域追蹤狀態
// ============================================================

let targetBBox = null;
let targetColor = null;
let roiBox = null;

// ============================================================
// 重置追蹤與 ROI
// ============================================================

export function resetTrackState() {
  targetBBox = null;
  targetColor = null;
  roiBox = null;
}

// ============================================================
// ROI
// ============================================================

export function setROI(x, y, width, height) {
  roiBox = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  };

  return roiBox;
}

export function getROI() {
  return roiBox;
}

// ============================================================
// 記憶體預估
// ============================================================

export function estimateMemoryUsage(roiWidth, roiHeight, totalFrames) {
  if (!roiWidth || !roiHeight || !totalFrames) return 0;

  const bytesPerFrame = roiWidth * roiHeight * 4;
  const totalBytes = bytesPerFrame * totalFrames;

  return (totalBytes / (1024 * 1024)).toFixed(2);
}

// ============================================================
// 選取目標
// ============================================================

export function selectTarget(x, y, ctx) {
  const boxSize = 36;

  targetBBox = {
    x: Math.round(x - boxSize / 2),
    y: Math.round(y - boxSize / 2),
    width: boxSize,
    height: boxSize
  };

  const pixel = ctx.getImageData(
    Math.round(x),
    Math.round(y),
    1,
    1
  ).data;

  targetColor = {
    r: pixel[0],
    g: pixel[1],
    b: pixel[2]
  };

  return { targetBBox, targetColor };
}

// ============================================================
// 高速自動追蹤入口
// ============================================================

export async function runAutoTrackParallel({
  videoFile,
  canvas,
  pxPerMeter,
  workerCount = 4,
  onFrameUpdate,
  isTrackingCheck
}) {
  if (!pxPerMeter || !targetBBox || !targetColor || !roiBox || !videoFile) {
    return [];
  }

  // ----------------------------------------------------------
  // 確認 WebCodecs
  // ----------------------------------------------------------

  const webCodecsAvailable =
    typeof VideoDecoder !== 'undefined' &&
    typeof EncodedVideoChunk !== 'undefined';

  // ----------------------------------------------------------
  // 確認 MP4Box
  // ----------------------------------------------------------

  const mp4BoxAvailable = typeof MP4Box !== 'undefined';

  // ----------------------------------------------------------
  // 優先高速引擎
  // ----------------------------------------------------------

  if (webCodecsAvailable && mp4BoxAvailable) {
    try {
      return await demuxAndTrackWithWebCodecs({
        videoFile,
        canvas,
        pxPerMeter,
        workerCount,
        onFrameUpdate,
        isTrackingCheck
      });
    } catch (err) {
      console.warn(
        'WebCodecs / MP4Box 高速引擎失敗，切換 HTML5 Video fallback:',
        err
      );
    }
  }

  // ----------------------------------------------------------
  // HTML5 Video fallback
  // ----------------------------------------------------------

  return await runAutoTrackCanvasFallback({
    canvas,
    pxPerMeter,
    onFrameUpdate,
    isTrackingCheck
  });
}

// ============================================================
// WebCodecs + MP4Box + Dynamic Worker Pool
// ============================================================

async function demuxAndTrackWithWebCodecs({
  videoFile,
  canvas,
  pxPerMeter,
  workerCount,
  onFrameUpdate,
  isTrackingCheck
}) {
  // ----------------------------------------------------------
  // Worker 數量限制
  // ----------------------------------------------------------

  const hardwareConcurrency = navigator.hardwareConcurrency || 4;

  const actualWorkerCount = Math.max(
    1,
    Math.min(
      Number(workerCount) || 4,
      hardwareConcurrency,
      6
    )
  );

  console.log(`[Track] 使用 ${actualWorkerCount} 個 Worker`);

  // ----------------------------------------------------------
  // 取得完整影片 ArrayBuffer
  // ----------------------------------------------------------

  const buffer = await videoFile.arrayBuffer();
  buffer.fileStart = 0;

  // ----------------------------------------------------------
  // 建立 MP4Box
  // ----------------------------------------------------------

  const mp4boxfile = MP4Box.createFile();

  // ----------------------------------------------------------
  // Worker 狀態
  // ----------------------------------------------------------

  const workers = [];
  const workerStates = [];

  for (let i = 0; i < actualWorkerCount; i++) {
    workers.push(null);
    workerStates.push({
      index: i,
      busy: false,
      taskId: null
    });
  }

  // ----------------------------------------------------------
  // GOP Queue
  // ----------------------------------------------------------

  const gopQueue = [];
  let gopBuildBuffer = [];
  let gopCounter = 0;
  let demuxReady = false;
  let demuxFinished = false;
  let processingStarted = false;
  let finishedWorkers = 0;
  let failed = false;

  // ----------------------------------------------------------
  // 所有結果
  // ----------------------------------------------------------

  const trackingData = [];

  // ----------------------------------------------------------
  // Promise
  // ----------------------------------------------------------

  return await new Promise((resolve, reject) => {
    // ========================================================
    // 清理
    // ========================================================

    function cleanup() {
      workers.forEach(worker => {
        if (worker) {
          try {
            worker.postMessage({ type: 'CLOSE' });
          } catch (_) {}

          try {
            worker.terminate();
          } catch (_) {}
        }
      });
    }

    // ========================================================
    // 失敗
    // ========================================================

    function fail(err) {
      if (failed) return;

      failed = true;
      cleanup();

      reject(
        err instanceof Error
          ? err
          : new Error(String(err))
      );
    }

    // ========================================================
    // 是否繼續追蹤
    // ========================================================

    function trackingActive() {
      try {
        return typeof isTrackingCheck !== 'function'
          ? true
          : isTrackingCheck();
      } catch (_) {
        return false;
      }
    }

    // ========================================================
    // 建立 Worker
    // ========================================================

    function createWorker(index) {
      const worker = new Worker('trackWorker.js', {
        type: 'module'
      });

      workers[index] = worker;

      worker.onmessage = event => {
        const { type, payload } = event.data || {};

        // Worker READY
        if (type === 'READY') {
          workerStates[index].ready = true;
          tryDispatch();
          return;
        }

        // GOP 完成
        if (type === 'GOP_COMPLETE') {
          handleGOPComplete(index, payload);
          return;
        }

        // Worker Error
        if (type === 'ERROR') {
          fail(
            new Error(
              payload?.message || `Worker ${index} 發生錯誤`
            )
          );
        }
      };

      worker.onerror = event => {
        fail(
          new Error(
            `Worker ${index} 發生錯誤: ${
              event.message || 'Unknown error'
            }`
          )
        );
      };

      return worker;
    }

    // ========================================================
    // 初始化所有 Worker
    // ========================================================

    for (let i = 0; i < actualWorkerCount; i++) {
      createWorker(i);
    }

    // ========================================================
    // MP4Box onReady
    // ========================================================

    mp4boxfile.onReady = info => {
      try {
        const videoTrack = info.videoTracks?.[0];

        if (!videoTrack) {
          fail(new Error('影片檔案中未找到支援的視訊軌'));
          return;
        }

        // Decoder Config
        const decoderConfig = {
          codec: videoTrack.codec,
          codedWidth: videoTrack.video.width,
          codedHeight: videoTrack.video.height
        };

        // ExtraData
        const description = getDecoderDescription(
          mp4boxfile,
          videoTrack.id
        );

        if (description) {
          decoderConfig.description = description;
        }

        // 發送 INIT
        workers.forEach(worker => {
          worker.postMessage({
            type: 'INIT',
            payload: {
              decoderConfig,
              roi: roiBox,
              targetColor,
              pxPerMeter,
              canvasHeight: canvas.height
            }
          });
        });

        // 設定 extraction
        mp4boxfile.setExtractionOptions(
          videoTrack.id,
          null,
          { nbSamples: 500 }
        );

        demuxReady = true;

        // 開始 extraction
        mp4boxfile.start();
      } catch (err) {
        fail(err);
      }
    };

    // ========================================================
    // MP4Box Samples
    // ========================================================

    mp4boxfile.onSamples = (trackId, ref, samples) => {
      if (failed || !samples?.length) return;

      // 建立 GOP
      for (const sample of samples) {
        if (sample.is_sync && gopBuildBuffer.length > 0) {
          gopQueue.push({
            id: gopCounter++,
            samples: gopBuildBuffer
          });

          gopBuildBuffer = [];
        }

        gopBuildBuffer.push(sample);
      }

      tryDispatch();
    };

    // ========================================================
    // MP4Box Error
    // ========================================================

    mp4boxfile.onError = err => {
      console.warn('MP4Box:', err);

      if (gopQueue.length === 0 && gopBuildBuffer.length === 0) {
        fail(new Error(`MP4Box 無法解析影片：${err}`));
      }
    };

    // ========================================================
    // 開始讀檔
    // ========================================================

    try {
      mp4boxfile.appendBuffer(buffer);
      mp4boxfile.flush();
    } catch (err) {
      fail(err);
    }

    // ========================================================
    // Demux 結束檢查
    // ========================================================

    queueMicrotask(() => {
      if (failed) return;

      if (gopBuildBuffer.length > 0) {
        gopQueue.push({
          id: gopCounter++,
          samples: gopBuildBuffer
        });

        gopBuildBuffer = [];
      }

      demuxFinished = true;

      console.log(
        `[Track] Demux 完成，共 ${gopQueue.length} GOP`
      );

      tryDispatch();
      checkComplete();
    });

    // ========================================================
    // 動態派工
    // ========================================================

    function tryDispatch() {
      if (failed || !demuxReady) return;

      // 使用者取消追蹤
      if (!trackingActive()) {
        cleanup();
        resolve(trackingData);
        return;
      }

      // 找閒置 Worker
      for (let i = 0; i < workerStates.length; i++) {
        const state = workerStates[i];

        if (state.busy || !state.ready) continue;
        if (gopQueue.length === 0) break;

        // 取得下一個 GOP
        const gop = gopQueue.shift();

        // 建立 Transferable buffers
        const samples = [];
        const transferList = [];

        for (const sample of gop.samples) {
          const sampleBuffer = sample.data.buffer.slice(
            sample.data.byteOffset,
            sample.data.byteOffset + sample.data.byteLength
          );

          samples.push({
            type: sample.is_sync ? 'key' : 'delta',
            timestamp:
              (sample.cts * 1_000_000) / sample.timescale,
            duration:
              (sample.duration * 1_000_000) / sample.timescale,
            data: sampleBuffer
          });

          transferList.push(sampleBuffer);
        }

        const taskId = gop.id;

        state.busy = true;
        state.taskId = taskId;

        // 傳給 Worker
        try {
          workers[i].postMessage(
            {
              type: 'DECODE_GOP',
              payload: {
                taskId,
                samples
              }
            },
            transferList
          );
        } catch (err) {
          state.busy = false;
          state.taskId = null;
          fail(err);
          return;
        }
      }

      checkComplete();
    }

    // ========================================================
    // GOP 完成
    // ========================================================

    function handleGOPComplete(workerIndex, payload) {
      const state = workerStates[workerIndex];

      state.busy = false;
      state.taskId = null;

      const results = payload?.results || [];

      // 收集結果
      for (const result of results) {
        trackingData.push(result);
      }

      // UI 更新節流
      if (onFrameUpdate && results.length > 0) {
        const last = results[results.length - 1];

        onFrameUpdate(last, trackingData);
      }

      // Worker 馬上拿下一個 GOP
      tryDispatch();
      checkComplete();
    }

    // ========================================================
    // 完成判斷
    // ========================================================

    function checkComplete() {
      if (failed || !demuxFinished) return;
      if (gopQueue.length > 0) return;

      // 還有 Worker 正在處理
      for (const state of workerStates) {
        if (state.busy) return;
      }

      // 全部完成
      trackingData.sort(
        (a, b) => Number(a.timestamp) - Number(b.timestamp)
      );

      // 清理 Worker
      cleanup();

      // 最後通知 UI
      if (onFrameUpdate && trackingData.length > 0) {
        onFrameUpdate(
          trackingData[trackingData.length - 1],
          trackingData
        );
      }

      resolve(trackingData);
    }
  });
}

// ============================================================
// Decoder Description
// ============================================================

function getDecoderDescription(mp4boxfile, trackId) {
  try {
    const track = mp4boxfile.getTrackById(trackId);

    if (
      !track?.mdia?.minf?.stbl?.stsd?.entries?.[0]
    ) {
      return null;
    }

    const entry = track.mdia.minf.stbl.stsd.entries[0];

    const box =
      entry.avcC ||
      entry.hvcC ||
      entry.vpcC ||
      entry.av1C;

    if (!box) return null;

    const stream = new MP4Box.DataStream(
      undefined,
      0,
      MP4Box.DataStream.BIG_ENDIAN
    );

    box.write(stream);

    return new Uint8Array(stream.buffer, 8);
  } catch (e) {
    console.warn('提取 ExtraData 失敗:', e);
    return null;
  }
}

// ============================================================
// HTML5 Video fallback
// ============================================================

async function runAutoTrackCanvasFallback({
  canvas,
  pxPerMeter,
  onFrameUpdate,
  isTrackingCheck
}) {
  const video = document.getElementById('videoElement');
  const ctx = canvas.getContext('2d');
  const trackingData = [];

  video.currentTime = 0;

  await new Promise(resolve => setTimeout(resolve, 200));

  const fps = 30;
  const frameDuration = 1 / fps;

  while (
    video.currentTime < video.duration &&
    isTrackingCheck()
  ) {
    ctx.drawImage(
      video,
      0,
      0,
      canvas.width,
      canvas.height
    );

    const imgData = ctx.getImageData(
      roiBox.x,
      roiBox.y,
      roiBox.width,
      roiBox.height
    );

    const centroid = computeCentroid(
      imgData,
      targetColor
    );

    if (centroid) {
      const cx = roiBox.x + centroid.cx;
      const cy = roiBox.y + centroid.cy;

      const x_m = cx / pxPerMeter;
      const y_m = (canvas.height - cy) / pxPerMeter;

      const frameRes = {
        time: video.currentTime.toFixed(3),
        x_px: cx.toFixed(1),
        y_px: cy.toFixed(1),
        x_m: x_m.toFixed(4),
        y_m: y_m.toFixed(4),
        cx,
        cy,
        timestamp: video.currentTime * 1_000_000
      };

      trackingData.push(frameRes);

      if (onFrameUpdate) {
        onFrameUpdate(frameRes, trackingData);
      }
    }

    video.currentTime += frameDuration;

    await new Promise(resolve => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };

      video.addEventListener('seeked', onSeeked);
    });
  }

  return trackingData;
}

// ============================================================
// Worker / 舊版共用質心計算
// ============================================================

export function computeCentroid(imageData, colorTarget) {
  const data = imageData.data;
  const w = imageData.width;
  const h = imageData.height;

  const tr = colorTarget.r;
  const tg = colorTarget.g;
  const tb = colorTarget.b;

  let m00 = 0;
  let m10 = 0;
  let m01 = 0;

  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;

    for (let x = 0; x < w; x++) {
      const idx = (rowOffset + x) << 2;

      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      const diff =
        Math.abs(r - tr) +
        Math.abs(g - tg) +
        Math.abs(b - tb);

      if (diff < 155) {
        const weight = 255 - diff;

        m00 += weight;
        m10 += x * weight;
        m01 += y * weight;
      }
    }
  }

  if (m00 === 0) return null;

  return {
    cx: m10 / m00,
    cy: m01 / m00
  };
}

// ============================================================
// 舊版逐幀追蹤
// 保留，避免其他程式引用時壞掉
// ============================================================

function seekTo(video, time) {
  return new Promise(resolve => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };

    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
  });
}

export async function runAutoTrack({
  video,
  canvas,
  pxPerMeter,
  onFrameUpdate,
  isTrackingCheck
}) {
  if (!pxPerMeter || !targetBBox || !targetColor) {
    return [];
  }

  const trackingData = [];

  const fps = 30;
  const frameDuration = 1 / fps;

  let frameIdx = 0;

  let currentBBox = {
    ...targetBBox
  };

  const roiWidth = targetBBox.width;
  const roiHeight = targetBBox.height;

  const offCanvas = new OffscreenCanvas(
    roiWidth,
    roiHeight
  );

  const offCtx = offCanvas.getContext('2d', {
    willReadFrequently: true
  });

  const totalFrames = Math.floor(
    video.duration / frameDuration
  );

  for (
    let t = 0;
    t < video.duration;
    t += frameDuration
  ) {
    if (!isTrackingCheck()) break;

    await seekTo(video, t);

    const cropX = Math.max(
      0,
      Math.min(
        canvas.width - roiWidth,
        currentBBox.x
      )
    );

    const cropY = Math.max(
      0,
      Math.min(
        canvas.height - roiHeight,
        currentBBox.y
      )
    );

    offCtx.drawImage(
      video,
      cropX,
      cropY,
      roiWidth,
      roiHeight,
      0,
      0,
      roiWidth,
      roiHeight
    );

    const roiData = offCtx.getImageData(
      0,
      0,
      roiWidth,
      roiHeight
    );

    const localCentroid = computeCentroid(
      roiData,
      targetColor
    );

    let cx = cropX + roiWidth / 2;
    let cy = cropY + roiHeight / 2;

    if (localCentroid) {
      cx = cropX + localCentroid.cx;
      cy = cropY + localCentroid.cy;

      currentBBox.x = Math.max(
        0,
        Math.min(
          canvas.width - roiWidth,
          Math.round(cx - roiWidth / 2)
        )
      );

      currentBBox.y = Math.max(
        0,
        Math.min(
          canvas.height - roiHeight,
          Math.round(cy - roiHeight / 2)
        )
      );
    }

    const x_m = cx / pxPerMeter;
    const y_m = (canvas.height - cy) / pxPerMeter;

    const frameResult = {
      frame: frameIdx,
      time: t.toFixed(3),
      x_px: cx.toFixed(1),
      y_px: cy.toFixed(1),
      x_m: x_m.toFixed(4),
      y_m: y_m.toFixed(4),
      cx,
      cy,
      timestamp: t * 1_000_000
    };

    trackingData.push(frameResult);

    if (
      frameIdx % 5 === 0 ||
      frameIdx === totalFrames - 1
    ) {
      if (onFrameUpdate) {
        onFrameUpdate(
          frameResult,
          trackingData
        );
      }

      if (frameIdx % 15 === 0) {
        await new Promise(resolve =>
          setTimeout(resolve, 0)
        );
      }
    }

    frameIdx++;
  }

  return trackingData;
}

// ============================================================
// Getters
// ============================================================

export function getTargetBBox() {
  return targetBBox;
}

export function getTargetColor() {
  return targetColor;
}