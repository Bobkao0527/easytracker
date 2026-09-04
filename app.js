// app.js
// 主入口模組：協調定標、追蹤、圖表、匯出各子模組

import {resetCalibration, addCalibrationPoint, getPxPerMeter, getCalibrationPoints, transformCoordinates, autoCalculateK1, autoCalculatePerspectiveAndK1} from './standard.js';
import {resetTrackState, selectTarget, getTargetBBox, getTargetColor, setROI, runAutoTrack, drawTrackingGizmo} from './track.js';
import {initChart, clearChart, renderChart, resizeChart} from './chart.js';
import { exportCSV } from './export.js';
import {initZoomPan, setZoom, resetZoomPan, getZoomLevel} from './zoomPan.js';
import { initDistortionRenderer, renderDistortedVideo, setHomographyMatrix } from './distortion.js';

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

let k1LinePoints = [];
const K1_TARGET_POINTS = 8; // 設定目標點數 (8點)

let currentLineIndex = 0; // 0, 1 (水平線) | 2, 3 (鉛直線)
let multiLinesPoints = [[], [], [], []]; // 儲存 4 條線的點
let currentHomography = [1,0,0, 0,1,0, 0,0,1];

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

  // 自動 k1 計算按鈕事件
  document.getElementById('btnAutoK1')?.addEventListener('click', () => {
    mode = 'selectK1Line';
    k1LinePoints = [];
    document.getElementById('status').innerText = `請點擊畫面上同一直線邊緣的 ${K1_TARGET_POINTS} 個點 (0/${K1_TARGET_POINTS})`;
  });

  document.getElementById('btnAutoPerspectiveK1')?.addEventListener('click', () => {
    mode = 'selectPerspectiveLines';
    currentLineIndex = 0;
    multiLinesPoints = [[], [], [], []];
    updatePerspectiveStatusUI();
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

  const k1Input = document.getElementById('k1Distortion');
  const k1ValueDisplay = document.getElementById('k1Value');
  const tiltInput = document.getElementById('tiltAngle');

  if (k1Input && k1ValueDisplay) {
    k1Input.addEventListener('input', (e) => {
      k1ValueDisplay.innerText = parseFloat(e.target.value).toFixed(3);
      renderCurrentFrame();
      if (trackingData.length > 0) {
        updateTrackingUI(trackingData[trackingData.length - 1], trackingData);
      }
    });
  }

  if (tiltInput) {
    tiltInput.addEventListener('input', () => {
      renderCurrentFrame();
      refreshCurrentPosDisplay(); // 調整傾角時同步更新數據
    });
  }

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

function updatePerspectiveStatusUI() {
  // 修正：邊界保護
  if (currentLineIndex >= 4 || !multiLinesPoints[currentLineIndex]) return;

  const lineTypes = ['第 1 條水平線', '第 2 條水平線', '第 1 條鉛直線', '第 2 條鉛直線'];
  const currentCount = multiLinesPoints[currentLineIndex].length;
  document.getElementById('status').innerText = 
    `請點選【${lineTypes[currentLineIndex]}】上的 6 個點 (${currentCount}/6)`;
}

// ============================================================
// 高速追蹤 Frame Update (含即時 FPS 計算)
// ============================================================

let lastFpsCalcTime = 0;
let framesSinceLastCalc = 0;

function handleTrackingFrameUpdate(frameData, allData) {
  if (!frameData || !Array.isArray(allData)) return;

  const now = performance.now();
  framesSinceLastCalc++;

  // 每約 500ms 計算一次即時處理 FPS，顯示更穩定不跳動
  if (now - lastFpsCalcTime >= 500) {
    if (lastFpsCalcTime > 0) {
      const elapsedSec = (now - lastFpsCalcTime) / 1000;
      const currentFPS = (framesSinceLastCalc / elapsedSec).toFixed(1);
      const fpsDisplay = document.getElementById('fpsDisplay');
      if (fpsDisplay) {
        fpsDisplay.innerText = `${currentFPS} FPS`;
      }
    }
    lastFpsCalcTime = now;
    framesSinceLastCalc = 0;
  }

  // UI 約 30 FPS 更新
  if (now - lastUIUpdateTime >= UI_UPDATE_INTERVAL) {
    lastUIUpdateTime = now;
    updateTrackingUI(frameData, allData);
  }

  // Chart 約 10 FPS 更新
  if (now - lastChartUpdateTime >= CHART_UPDATE_INTERVAL) {
    lastChartUpdateTime = now;
    renderChart(allData);
  }
}

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

  const fpsDisplay = document.getElementById('fpsDisplay');
  if (fpsDisplay) fpsDisplay.innerText = '- FPS';

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

    initDistortionRenderer(video.videoWidth, video.videoHeight);
    renderCurrentFrame(true);
    document.getElementById('btnCalibrate').disabled = false;
    
    const btnROI = document.getElementById('btnROI');
    if (btnROI) btnROI.disabled = false;

    document.getElementById('btnTrack').disabled = false;
    document.getElementById('btnProcess').disabled = true;
    document.getElementById('btnExport').disabled = true;

    document.getElementById('status').innerText =
      '影片讀取成功';

    startRenderLoop();
  };

  video.onerror = () => {
    document.getElementById('status').innerText =
      '影片無法讀取，請確認格式或重新選擇影片';
  };

  video.load();
};

// ============================================================
// 一般影片預覽 Render Loop
//
// 注意：高速追蹤開始後會被停止。
// ============================================================

function drawGrid(ctx, width, height, baseStep = 50, tiltAngleDeg = 0, origin = { x: width / 2, y: height / 2 }) {
  ctx.save();

  // 1. 平移至座標系原點，並依傾角角度進行旋轉
  ctx.translate(origin.x, origin.y);
  const rad = (tiltAngleDeg * Math.PI) / 180;
  ctx.rotate(rad);

  // 2. 計算涵蓋全畫布的最大對角半徑，確保旋轉後網格不會露白
  const maxDim = Math.hypot(width, height) * 2;

  // 3. 修正：採用固定 Canvas 圖片空間間距 (50px)，貼合影像座標，縮放時由 CSS Transform 無縫處理
  const step = baseStep;

  // 繪製半透明天藍色背景網格線
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
  ctx.lineWidth = 1;

  ctx.beginPath();
  for (let x = -maxDim; x <= maxDim; x += step) {
    ctx.moveTo(x, -maxDim);
    ctx.lineTo(x, maxDim);
  }
  for (let y = -maxDim; y <= maxDim; y += step) {
    ctx.moveTo(-maxDim, y);
    ctx.lineTo(maxDim, y);
  }
  ctx.stroke();

  // 4. 繪製傾斜後的座標主軸 (X軸: 紅色 | Y軸: 綠色)
  ctx.lineWidth = 2;

  // X 軸 (紅色)
  ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
  ctx.beginPath();
  ctx.moveTo(-maxDim, 0);
  ctx.lineTo(maxDim, 0);
  ctx.stroke();

  // Y 軸 (綠色)
  ctx.strokeStyle = 'rgba(34, 197, 94, 0.85)';
  ctx.beginPath();
  ctx.moveTo(0, -maxDim);
  ctx.lineTo(0, maxDim);
  ctx.stroke();

  ctx.restore();
}

function renderCurrentFrame(withGrid = true) {
  if (!video) return;
  const k1 = parseFloat(document.getElementById('k1Distortion')?.value) || 0;
  const tiltAngle = parseFloat(document.getElementById('tiltAngle')?.value) || 0;
  const calPoints = getCalibrationPoints();
  const origin = calPoints[0] || { x: canvas.width / 2, y: canvas.height / 2 };

  // 1. 透過 WebGL 渲染變形校正後的影格
  const renderedWithWebGL = renderDistortedVideo(video, ctx, k1);
  if (!renderedWithWebGL && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }

  // 2. 依需求疊加網格
  if (withGrid) {
    drawGrid(ctx, canvas.width, canvas.height, 50, tiltAngle, origin);
  }
}

function startRenderLoop() {
  if (renderLoopId !== null) {
    cancelAnimationFrame(renderLoopId);
  }

  function renderLoop() {
    if (!isTracking && !video.paused && !video.ended) {
      // 👇 替換原先的 ctx.drawImage，改由 WebGL 渲染畫面扭曲
      renderCurrentFrame();
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

  if (x < 0 || x > canvas.width || y < 0 || y > canvas.height) return;

  if (mode === 'calibrate') {
    handleCalibrationClick(x, y);
  } else if (mode === 'selectTarget') {
    handleTargetSelection(x, y);
  } else if (mode === 'selectPerspectiveLines') {
    handlePerspectiveLineClick(x, y);
  } else if (mode === 'selectK1Line') {
    handleK1LineClick(x, y);
  }
}

function handlePerspectiveLineClick(x, y) {
  // 修正：索引超出 4 條線時直接 return
  if (currentLineIndex >= 4 || !multiLinesPoints[currentLineIndex]) return;

  const lineColors = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6'];
  multiLinesPoints[currentLineIndex].push({ x, y });
  
  // 繪製標記點
  drawDot(x, y, lineColors[currentLineIndex]);

  // 同一條線點之間畫線連結
  const linePts = multiLinesPoints[currentLineIndex];
  if (linePts.length > 1) {
    ctx.strokeStyle = lineColors[currentLineIndex];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(linePts[linePts.length - 2].x, linePts[linePts.length - 2].y);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  if (linePts.length >= 6) {
    currentLineIndex++;
    if (currentLineIndex >= 4) {
      // 24 點收集完畢，開始計算
      const result = autoCalculatePerspectiveAndK1(multiLinesPoints, canvas.width, canvas.height);
      
      // 更新 k1
      const k1Input = document.getElementById('k1Distortion');
      const k1ValueDisplay = document.getElementById('k1Value');
      if (k1Input && k1ValueDisplay) {
        k1Input.value = result.k1;
        k1ValueDisplay.innerText = result.k1.toFixed(3);
      }

      // 更新 WebGL Homography 矩陣
      currentHomography = result.homography;
      setHomographyMatrix(currentHomography);

      renderCurrentFrame();
      document.getElementById('status').innerText = `校正完成！k1 = ${result.k1.toFixed(4)}，透視矩陣已套用`;
      mode = 'idle';
      return;
    }
  }
  updatePerspectiveStatusUI();
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

    mode = 'idle';
  }
}

// ============================================================
// 目標選取
// ============================================================

function handleTargetSelection(x, y) {
  // 1. 渲染無網格的原始畫面，避免網格進入特徵模板
  renderCurrentFrame(false);

  // 2. 擷取目標特徵模板 (32x32)
  const TEMPLATE_SIZE = 32;
  const { targetBBox } = selectTarget(x, y, ctx, TEMPLATE_SIZE);

  // 3. 取樣完成後，還原繪製網格
  renderCurrentFrame(true);

  // 4. 重繪定標點（若存在）
  const calPoints = getCalibrationPoints();
  if (calPoints.length === 2) {
    drawDot(calPoints[0].x, calPoints[0].y, '#ef4444');
    drawDot(calPoints[1].x, calPoints[1].y, '#ef4444');
  }

  // 5. 取得目前設定的搜尋半徑，計算預覽的搜尋矩形與半徑
  const searchRadius = parseFloat(document.getElementById('roiRadius')?.value) || 60;
  const cx = targetBBox.x + targetBBox.width / 2;
  const cy = targetBBox.y + targetBBox.height / 2;

  const searchX = Math.max(0, Math.min(canvas.width - searchRadius * 2, cx - searchRadius));
  const searchY = Math.max(0, Math.min(canvas.height - searchRadius * 2, cy - searchRadius));
  const searchW = Math.min(searchRadius * 2, canvas.width - searchX);
  const searchH = Math.min(searchRadius * 2, canvas.height - searchY);

  // ✨ 6. 呈現三層精準範圍：搜尋半徑區域 + 演算法計算區域 + 中心十字靶心
  drawTrackingGizmo(ctx, {
    searchX,
    searchY,
    searchW,
    searchH,
    searchCenterX: cx,
    searchCenterY: cy,
    searchRadius,
    matchBox: targetBBox,
    centerX: cx,
    centerY: cy,
    isLost: false
  });

  document.getElementById('status').innerText = '目標與搜尋範圍已就緒！可隨時調整半徑或點擊開始追蹤';
  document.getElementById('btnProcess').disabled = false;
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

    renderCurrentFrame(true);

    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(roi.x, roi.y, roi.width, roi.height);
    ctx.setLineDash([]);
    document.getElementById('status').innerText = 'ROI 區域已選定';
    document.getElementById('btnTrack').disabled = false;
    mode = 'idle';
  }
  roiStartPoint = null;
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

  renderCurrentFrame(true);

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
  if (!pxPerMeter || pxPerMeter <= 0) {
    alert('請先點選「定標 (點兩點)」設定真實尺度後再開始追蹤！');
    return;
  }
  const searchRadius = parseFloat(document.getElementById('roiRadius')?.value) || 60;

  if (!getTargetBBox() || !getTargetColor()) {
    return;
  }

  trackingData = [];
  isTracking = true;

  // 重設計時變數
  lastFpsCalcTime = performance.now();
  framesSinceLastCalc = 0;
  const trackStartTime = performance.now();

  // UI 狀態更新
  document.getElementById('btnProcess').disabled = true;
  document.getElementById('btnCalibrate').disabled = true;
  document.getElementById('btnTrack').disabled = true;
  document.getElementById('btnExport').disabled = true;

  const fpsDisplay = document.getElementById('fpsDisplay');
  if (fpsDisplay) fpsDisplay.innerText = '計算中...';

  document.getElementById('status').innerText = '正在進行逐幀自動追蹤...';

  // 暫停預覽繪製
  if (renderLoopId !== null) {
    cancelAnimationFrame(renderLoopId);
    renderLoopId = null;
  }

  lastUIUpdateTime = 0;
  lastChartUpdateTime = 0;

  try {
    const result = await runAutoTrack({
      video,
      canvas,
      pxPerMeter,
      searchRadius,
      isTrackingCheck: () => isTracking,
      // 👇 注入渲染器與座標轉換
      renderFrame: (withGrid) => renderCurrentFrame(withGrid),
      transformCoords: (cx, cy) => {
        const tiltAngle = parseFloat(document.getElementById('tiltAngle')?.value) || 0;
        const calPoints = getCalibrationPoints();
        const origin = calPoints[0] || { x: 0, y: canvas.height };
        return transformCoordinates(cx, cy, {
          imageWidth: canvas.width,
          imageHeight: canvas.height,
          tiltAngleDeg: tiltAngle,
          originX: origin.x,
          originY: origin.y,
          isAlreadyRectified: true // 標記已拉正，避免二次變形
        });
      },
      onFrameUpdate: handleTrackingFrameUpdate
    });

    trackingData = Array.isArray(result) ? result : [];

    if (trackingData.length) {
      const last = trackingData[trackingData.length - 1];
      updateTrackingUI(last, trackingData);
      renderChart(trackingData);

      // 計算整段追蹤的平均處理幀率
      const totalElapsedSec = (performance.now() - trackStartTime) / 1000;
      const avgFPS = (trackingData.length / totalElapsedSec).toFixed(1);
      if (fpsDisplay) {
        fpsDisplay.innerText = `均速 ${avgFPS} FPS`;
      }
    }

    document.getElementById('status').innerText = `追蹤完成！共處理 ${trackingData.length} 幀`;
    document.getElementById('btnExport').disabled = trackingData.length === 0;
  } catch (err) {
    console.error('追蹤發生錯誤:', err);
    document.getElementById('status').innerText = `追蹤失敗：${err?.message || '未知錯誤'}`;
    if (fpsDisplay) fpsDisplay.innerText = '- FPS';
  } finally {
    isTracking = false;
    document.getElementById('btnProcess').disabled = false;
    document.getElementById('btnCalibrate').disabled = false;
    document.getElementById('btnTrack').disabled = false;
    const btnROI = document.getElementById('btnROI');
    if (btnROI) btnROI.disabled = false;

    renderCurrentFrame(true); // 保證追蹤結束後畫面立即可見變形影像與網格
    startRenderLoop();
  }
}

// ============================================================
// 更新追蹤 UI
// ============================================================

function updateTrackingUI(frameData, allData) {
  if (!frameData) return;

  // 1. 補上已捕捉影幀數量更新
  const pointCount = document.getElementById('pointCount');
  if (pointCount && Array.isArray(allData)) {
    pointCount.innerText = allData.length.toString();
  }

  const tiltAngle = parseFloat(document.getElementById('tiltAngle')?.value) || 0;
  const k1 = parseFloat(document.getElementById('k1Distortion')?.value) || 0;
  const calPoints = getCalibrationPoints();
  const origin = calPoints[0] || { x: 0, y: canvas.height };

  try {
    const corrected = transformCoordinates(frameData.cx, frameData.cy, {
      imageWidth: canvas.width,
      imageHeight: canvas.height,
      k1: k1,
      tiltAngleDeg: tiltAngle,
      homography: currentHomography,
      originX: origin.x,
      originY: origin.y
    });

    const posDisplay = document.getElementById('posDisplay');
    if (posDisplay && corrected && !isNaN(corrected.x_m) && !isNaN(corrected.y_m)) {
      posDisplay.innerText = `X: ${corrected.x_m.toFixed(3)} m | Y: ${corrected.y_m.toFixed(3)} m`;
    } else if (posDisplay) {
      // 尚未定標時退回顯示像素座標
      posDisplay.innerText = `X: ${frameData.cx.toFixed(1)} px | Y: ${frameData.cy.toFixed(1)} px`;
    }
  } catch (e) {
    console.warn('座標轉換警告:', e);
  }
}

function refreshCurrentPosDisplay() {
  if (trackingData && trackingData.length > 0) {
    const lastFrame = trackingData[trackingData.length - 1];
    updateTrackingUI(lastFrame, trackingData);
  }
}

function handleK1LineClick(x, y) {
  k1LinePoints.push({ x, y });
  drawDot(x, y, '#38bdf8'); // 以天藍色標示直線點

  const count = k1LinePoints.length;
  document.getElementById('status').innerText = `請點擊畫面上同一直線邊緣的 ${K1_TARGET_POINTS} 個點 (${count}/${K1_TARGET_POINTS})`;

  if (count >= K1_TARGET_POINTS) {
    const calculatedK1 = autoCalculateK1(k1LinePoints, canvas.width, canvas.height);
    
    // 套用計算結果至 UI
    const k1Input = document.getElementById('k1Distortion');
    const k1ValueDisplay = document.getElementById('k1Value');
    if (k1Input && k1ValueDisplay) {
      k1Input.value = calculatedK1;
      k1ValueDisplay.innerText = calculatedK1.toFixed(3);
    }

    renderCurrentFrame();
    document.getElementById('status').innerText = `k1 自動計算完成：${calculatedK1.toFixed(4)}`;
    mode = 'idle';
    k1LinePoints = [];
  }
}

// ============================================================
// 匯出
// ============================================================

function handleExport() {
  if (!trackingData.length) return;

  const tiltAngle = parseFloat(document.getElementById('tiltAngle')?.value) || 0;
  const calPoints = getCalibrationPoints();
  const origin = calPoints[0] || { x: 0, y: canvas.height };

  const exportData = trackingData.map(item => {
    const corrected = transformCoordinates(item.cx, item.cy, {
      imageWidth: canvas.width,
      imageHeight: canvas.height,
      tiltAngleDeg: tiltAngle,
      originX: origin.x,
      originY: origin.y,
      isAlreadyRectified: true // 👈 避免重複做透視矩陣與 k1
    });

    return {
      ...item,
      x_m: corrected.x_m.toFixed(4),
      y_m: corrected.y_m.toFixed(4)
    };
  });

  exportCSV(exportData);
}