// app.js
// 主入口模組：協調定標、追蹤、圖表、匯出各子模組

import {
  resetCalibration,
  addCalibrationPoint,
  getPxPerMeter,
  getCalibrationPoints
} from './standard.js';

import {
  resetTrackState,
  selectTarget,
  getTargetBBox,
  getTargetColor,
  setROI,
  getROI,
  estimateMemoryUsage,
  runAutoTrackParallel
} from './track.js';

import {
  initChart,
  clearChart,
  renderChart,
  resizeChart
} from './chart.js';

import { exportCSV } from './export.js';

import {
  initZoomPan,
  setZoom,
  resetZoomPan,
  getZoomLevel
} from './zoomPan.js';

// ============================================================
// 狀態變數
// ============================================================

let video;
let canvas;
let ctx;

let mode = 'idle';
// 'calibrate' | 'selectTarget' | 'selectROI' | 'idle'

let trackingData = [];
let isTracking = false;
let renderLoopId = null;
let currentVideoUrl = null;
let roiStartPoint = null;

// ============================================================
// 高速追蹤 UI 節流狀態
// ============================================================

// UI 最快約 30 FPS
const UI_UPDATE_INTERVAL = 1000 / 30;

// Chart 最快約 10 FPS
const CHART_UPDATE_INTERVAL = 1000 / 10;

let lastUIUpdateTime = 0;
let lastChartUpdateTime = 0;

// ============================================================
// 初始化
// ============================================================

window.onload = () => {
  video = document.getElementById('videoElement');
  canvas = document.getElementById('canvasOutput');
  ctx = canvas.getContext('2d');

  const chartX = document.getElementById('chartCanvasX');
  const chartY = document.getElementById('chartCanvasY');

  if (chartX && chartY) {
    initChart(chartX, chartY);
  }

  initZoomPan(canvas);

  // 影片
  document
    .getElementById('videoInput')
    .addEventListener('change', handleVideoUpload);

  // 定標
  document
    .getElementById('btnCalibrate')
    .addEventListener('click', () => {
      mode = 'calibrate';
      resetCalibration();
      document.getElementById('status').innerText =
        '請點擊影片上的兩點設定真實長度';
    });

  // ROI
  document
    .getElementById('btnROI')
    ?.addEventListener('click', () => {
      mode = 'selectROI';
      document.getElementById('status').innerText =
        '請在影片上拉框選取運動邊界 (ROI)';
    });

  // 目標
  document
    .getElementById('btnTrack')
    .addEventListener('click', () => {
      mode = 'selectTarget';
      document.getElementById('status').innerText =
        '請點擊目標物體中心';
    });

  // 開始處理
  document
    .getElementById('btnProcess')
    .addEventListener('click', startAutoTrack);

  // 匯出
  document
    .getElementById('btnExport')
    .addEventListener('click', handleExport);

  // Canvas mouse events
  canvas.addEventListener('mousedown', handleCanvasMouseDown);
  canvas.addEventListener('mousemove', handleCanvasMouseMove);
  canvas.addEventListener('mouseup', handleCanvasMouseUp);
  canvas.addEventListener('click', handleCanvasClick);

  // Zoom
  document
    .getElementById('btnZoomIn')
    ?.addEventListener('click', () => {
      setZoom(getZoomLevel() + 0.25);
    });

  document
    .getElementById('btnZoomOut')
    ?.addEventListener('click', () => {
      setZoom(getZoomLevel() - 0.25);
    });

  document
    .getElementById('btnZoomReset')
    ?.addEventListener('click', () => {
      resetZoomPan();
    });

  // Resize
  window.addEventListener('resize', () => {
    resizeChart();
  });
};

// ============================================================
// 影片載入
// ============================================================

function handleVideoUpload(e) {
  const file = e.target ? e.target.files[0] : e;

  if (!file) return;

  isTracking = false;
  trackingData = [];
  mode = 'idle';

  resetCalibration();
  resetTrackState();
  resetZoomPan();

  // 重設 UI
  const scaleDisplay = document.getElementById('scaleDisplay');
  if (scaleDisplay) scaleDisplay.innerText = '未設定';

  const pointCount = document.getElementById('pointCount');
  if (pointCount) pointCount.innerText = '0';

  const posDisplay = document.getElementById('posDisplay');
  if (posDisplay) {
    posDisplay.innerText = 'X: - m | Y: - m';
  }

  const memDisplay = document.getElementById('memDisplay');
  if (memDisplay) memDisplay.innerText = '0 MB';

  clearChart();

  // 清除舊 URL
  if (currentVideoUrl) {
    URL.revokeObjectURL(currentVideoUrl);
    currentVideoUrl = null;
  }

  // 停止舊 render loop
  if (renderLoopId !== null) {
    cancelAnimationFrame(renderLoopId);
    renderLoopId = null;
  }

  // 建立影片 URL
  currentVideoUrl = URL.createObjectURL(file);
  video.src = currentVideoUrl;

  // 影片載入
  video.onloadeddata = () => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    ctx.drawImage(
      video,
      0,
      0,
      canvas.width,
      canvas.height
    );

    document.getElementById('btnCalibrate').disabled = false;
    document.getElementById('btnROI').disabled = false;
    document.getElementById('btnTrack').disabled = false;
    document.getElementById('btnProcess').disabled = true;
    document.getElementById('btnExport').disabled = true;

    document.getElementById('status').innerText =
      '影片讀取成功';

    startRenderLoop();
  };
};

// ============================================================
// 一般影片預覽 Render Loop
//
// 注意：高速追蹤開始後會被停止。
// ============================================================

function startRenderLoop() {
  if (renderLoopId !== null) {
    cancelAnimationFrame(renderLoopId);
  }

  function renderLoop() {
    if (!isTracking && !video.paused && !video.ended) {
      ctx.drawImage(
        video,
        0,
        0,
        canvas.width,
        canvas.height
      );
    }

    renderLoopId = requestAnimationFrame(renderLoop);
  }

  renderLoopId = requestAnimationFrame(renderLoop);
}

// ============================================================
// Canvas Click
// ============================================================

function handleCanvasClick(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;

  if (
    x < 0 ||
    x > canvas.width ||
    y < 0 ||
    y > canvas.height
  ) {
    return;
  }

  if (mode === 'calibrate') {
    handleCalibrationClick(x, y);
  } else if (mode === 'selectTarget') {
    handleTargetSelection(x, y);
  }
}

// ============================================================
// 定標
// ============================================================

function handleCalibrationClick(x, y) {
  const realLen =
    parseFloat(
      document.getElementById('scaleLength').value
    ) || 1.0;

  const result = addCalibrationPoint(x, y, realLen);

  drawDot(x, y, '#ef4444');

  if (result.completed) {
    document.getElementById('scaleDisplay').innerText =
      `${result.pxPerMeter.toFixed(2)} px/m`;

    document.getElementById('status').innerText =
      '定標完成！';

    if (getTargetBBox()) {
      document.getElementById('btnProcess').disabled = false;
    }

    mode = 'idle';
  }
}

// ============================================================
// 目標選取
// ============================================================

function handleTargetSelection(x, y) {
  const { targetBBox } = selectTarget(x, y, ctx);

  // 重畫影片
  ctx.drawImage(
    video,
    0,
    0,
    canvas.width,
    canvas.height
  );

  // 保留定標點
  const calPoints = getCalibrationPoints();

  if (calPoints.length === 2) {
    drawDot(calPoints[0].x, calPoints[0].y, '#ef4444');
    drawDot(calPoints[1].x, calPoints[1].y, '#ef4444');
  }

  // 目標框
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;

  ctx.strokeRect(
    targetBBox.x,
    targetBBox.y,
    targetBBox.width,
    targetBBox.height
  );

  document.getElementById('status').innerText =
    '目標與特徵顏色已選定';

  if (getPxPerMeter()) {
    document.getElementById('btnProcess').disabled = false;
  }

  mode = 'idle';
}

// ============================================================
// ROI Mouse Down
// ============================================================

function handleCanvasMouseDown(e) {
  if (mode !== 'selectROI') return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  roiStartPoint = {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY
  };
}

// ============================================================
// ROI Mouse Up
// ============================================================

function handleCanvasMouseUp(e) {
  if (mode !== 'selectROI' || !roiStartPoint) return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  const endX = (e.clientX - rect.left) * scaleX;
  const endY = (e.clientY - rect.top) * scaleY;

  const x = Math.min(roiStartPoint.x, endX);
  const y = Math.min(roiStartPoint.y, endY);
  const width = Math.abs(endX - roiStartPoint.x);
  const height = Math.abs(endY - roiStartPoint.y);

  if (width > 10 && height > 10) {
    const roi = setROI(x, y, width, height);

    ctx.drawImage(
      video,
      0,
      0,
      canvas.width,
      canvas.height
    );

    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);

    ctx.strokeRect(
      roi.x,
      roi.y,
      roi.width,
      roi.height
    );

    ctx.setLineDash([]);

    updateMemoryEstimate(roi.width, roi.height);

    document.getElementById('status').innerText =
      'ROI 區域已選定';

    document.getElementById('btnTrack').disabled = false;

    mode = 'idle';
  }

  roiStartPoint = null;
}

// ============================================================
// Memory estimate
// ============================================================

function updateMemoryEstimate(roiWidth, roiHeight) {
  if (!video.duration) return;

  const totalFrames = Math.floor(video.duration * 30);

  const memMB = estimateMemoryUsage(
    roiWidth,
    roiHeight,
    totalFrames
  );

  const memDisplay = document.getElementById('memDisplay');

  if (memDisplay) {
    memDisplay.innerText = `${memMB} MB`;
  }
}

// ============================================================
// ROI Mouse Move
// ============================================================

function handleCanvasMouseMove(e) {
  if (mode !== 'selectROI' || !roiStartPoint) return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  const currentX = (e.clientX - rect.left) * scaleX;
  const currentY = (e.clientY - rect.top) * scaleY;

  const x = Math.min(roiStartPoint.x, currentX);
  const y = Math.min(roiStartPoint.y, currentY);
  const width = Math.abs(currentX - roiStartPoint.x);
  const height = Math.abs(currentY - roiStartPoint.y);

  ctx.drawImage(
    video,
    0,
    0,
    canvas.width,
    canvas.height
  );

  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 6]);

  ctx.strokeRect(
    x,
    y,
    width,
    height
  );

  ctx.setLineDash([]);
}

// ============================================================
// 畫點
// ============================================================

function drawDot(x, y, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
}

// ============================================================
// 高速自動追蹤
// ============================================================

async function startAutoTrack() {
  const pxPerMeter = getPxPerMeter();

  if (
    !pxPerMeter ||
    !getTargetBBox() ||
    !getTargetColor() ||
    !getROI()
  ) {
    return;
  }

  trackingData = [];
  isTracking = true;

  // UI
  document.getElementById('btnProcess').disabled = true;
  document.getElementById('btnCalibrate').disabled = true;
  document.getElementById('btnTrack').disabled = true;
  document.getElementById('btnROI').disabled = true;
  document.getElementById('btnExport').disabled = true;

  document.getElementById('status').innerText =
    '正在啟動高速 WebCodecs 多線程追蹤...';

  // 停止影片預覽 render loop
  if (renderLoopId !== null) {
    cancelAnimationFrame(renderLoopId);
    renderLoopId = null;
  }

  // 重設節流計時
  lastUIUpdateTime = 0;
  lastChartUpdateTime = 0;

  try {
    const fileInput = document.getElementById('videoInput');
    const videoFile = fileInput.files[0];

    if (!videoFile) {
      throw new Error('找不到影片檔案');
    }

    // Worker 數量
    const hardwareThreads =
      navigator.hardwareConcurrency || 4;

    const workerCount = Math.max(
      1,
      Math.min(hardwareThreads, 4)
    );

    console.log(`硬體執行緒: ${hardwareThreads}`);
    console.log(`使用 Worker 數量: ${workerCount}`);

    // 開始高速追蹤
    const result = await runAutoTrackParallel({
      videoFile,
      canvas,
      pxPerMeter,
      workerCount,
      isTrackingCheck: () => isTracking,
      onFrameUpdate: handleTrackingFrameUpdate
    });

    // 完整結果
    trackingData = Array.isArray(result) ? result : [];

    // 最後完整更新一次
    if (trackingData.length) {
      const last = trackingData[trackingData.length - 1];

      updateTrackingUI(
        last,
        trackingData,
        true
      );

      renderChart(trackingData);
    }

    document.getElementById('status').innerText =
      `追蹤完成！共處理 ${trackingData.length} 幀`;

    document.getElementById('btnExport').disabled =
      trackingData.length === 0;
  } catch (err) {
    console.error('追蹤發生錯誤:', err);

    document.getElementById('status').innerText =
      `追蹤失敗：${err?.message || '未知錯誤'}`;
  } finally {
    isTracking = false;

    document.getElementById('btnProcess').disabled = false;
    document.getElementById('btnCalibrate').disabled = false;
    document.getElementById('btnTrack').disabled = false;
    document.getElementById('btnROI').disabled = false;

    // 恢復一般影片預覽
    startRenderLoop();
  }
}

// ============================================================
// 高速追蹤 Frame Update
//
// track.js / Worker 可以高頻率回傳。
// 這裡負責限制 UI 更新頻率。
// ============================================================

function handleTrackingFrameUpdate(frameData, allData) {
  if (!frameData || !Array.isArray(allData)) return;

  const now = performance.now();

  // UI 約 30 FPS
  if (now - lastUIUpdateTime >= UI_UPDATE_INTERVAL) {
    lastUIUpdateTime = now;

    updateTrackingUI(
      frameData,
      allData,
      false
    );
  }

  // Chart 約 10 FPS
  if (now - lastChartUpdateTime >= CHART_UPDATE_INTERVAL) {
    lastChartUpdateTime = now;
    renderChart(allData);
  }
}

// ============================================================
// 更新追蹤 UI
// ============================================================

function updateTrackingUI(frameData, allData, force = false) {
  if (!frameData) return;

  // Canvas
  // 高速模式不要 drawImage(video)。
  // 只畫最後追蹤點。

  if (
    Number.isFinite(frameData.cx) &&
    Number.isFinite(frameData.cy)
  ) {
    drawDot(
      frameData.cx,
      frameData.cy,
      '#ef4444'
    );
  }

  // Point Count
  const pointCount = document.getElementById('pointCount');

  if (pointCount) {
    pointCount.innerText = allData.length;
  }

  // Position
  const posDisplay = document.getElementById('posDisplay');

  if (posDisplay) {
    posDisplay.innerText =
      `X: ${frameData.x_m} m | Y: ${frameData.y_m} m`;
  }

  // Status
  const status = document.getElementById('status');

  if (status) {
    status.innerText =
      `高速解碼追蹤中... 已處理 ${allData.length} 幀`;
  }
}

// ============================================================
// 匯出
// ============================================================

function handleExport() {
  if (!trackingData.length) return;

  exportCSV(trackingData);
}