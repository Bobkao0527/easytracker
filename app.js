// 主入口模組：協調定標、追蹤、圖表、匯出各子模組

import { resetCalibration, addCalibrationPoint, getPxPerMeter, getCalibrationPoints } from './standard.js';
import { resetTrackState, selectTarget, getTargetBBox, getTargetColor, runAutoTrack } from './track.js';
import { initChart, clearChart, renderChart, resizeChart } from './chart.js';
import { exportCSV } from './export.js';
import { initZoomPan, setZoom, resetZoomPan, getZoomLevel } from './zoomPan.js';

// ===== 狀態變數 =====
let video, canvas, ctx;
let mode = 'idle'; // 'calibrate' | 'selectTarget' | 'idle'
let trackingData = [];
let isTracking = false;
let renderLoopId = null;
let currentVideoUrl = null;

// ===== 初始化 =====

window.onload = () => {
  video = document.getElementById('videoElement');
  canvas = document.getElementById('canvasOutput');
  ctx = canvas.getContext('2d');

  // 初始化圖表與縮放平移模組
  const chartX = document.getElementById('chartCanvasX');
  const chartY = document.getElementById('chartCanvasY');
  if (chartX && chartY) {
    initChart(chartX, chartY);
  }
  initZoomPan(canvas);

  // 綁定 UI 事件
  document.getElementById('videoInput').addEventListener('change', handleVideoUpload);

  document.getElementById('btnCalibrate').addEventListener('click', () => {
    mode = 'calibrate';
    resetCalibration();
    document.getElementById('status').innerText = '請點擊影片上的兩點設定真實長度';
  });

  document.getElementById('btnTrack').addEventListener('click', () => {
    mode = 'selectTarget';
    document.getElementById('status').innerText = '請點擊目標物體中心';
  });

  document.getElementById('btnProcess').addEventListener('click', startAutoTrack);
  document.getElementById('btnExport').addEventListener('click', handleExport);
  canvas.addEventListener('click', handleCanvasClick);

  // 綁定縮放按鈕
  document.getElementById('btnZoomIn')?.addEventListener('click', () => setZoom(getZoomLevel() + 0.25));
  document.getElementById('btnZoomOut')?.addEventListener('click', () => setZoom(getZoomLevel() - 0.25));
  document.getElementById('btnZoomReset')?.addEventListener('click', () => resetZoomPan());

  window.addEventListener('resize', () => {
    resizeChart();
  });
};

// ===== 影片載入 =====

function handleVideoUpload(e) {
  const file = e.target ? e.target.files[0] : e;
  if (!file) return;

  isTracking = false;
  trackingData = [];
  mode = 'idle';
  resetCalibration();
  resetTrackState();
  resetZoomPan();

  const scaleDisplay = document.getElementById('scaleDisplay');
  if (scaleDisplay) scaleDisplay.innerText = '未設定';
  const pointCount = document.getElementById('pointCount');
  if (pointCount) pointCount.innerText = '0';
  const posDisplay = document.getElementById('posDisplay');
  if (posDisplay) posDisplay.innerText = 'X: - m | Y: - m';

  clearChart();

  if (currentVideoUrl) {
    URL.revokeObjectURL(currentVideoUrl);
    currentVideoUrl = null;
  }

  if (renderLoopId !== null) {
    cancelAnimationFrame(renderLoopId);
    renderLoopId = null;
  }

  currentVideoUrl = URL.createObjectURL(file);
  video.src = currentVideoUrl;

  video.onloadeddata = () => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    document.getElementById('btnCalibrate').disabled = false;
    document.getElementById('btnTrack').disabled = false;
    document.getElementById('btnProcess').disabled = true;
    document.getElementById('btnExport').disabled = true;
    document.getElementById('status').innerText = '影片讀取成功';

    startRenderLoop();
  };
}

function startRenderLoop() {
  if (renderLoopId !== null) {
    cancelAnimationFrame(renderLoopId);
  }
  function renderLoop() {
    if (!video.paused && !video.ended) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
    renderLoopId = requestAnimationFrame(renderLoop);
  }
  renderLoopId = requestAnimationFrame(renderLoop);
}

// ===== 畫布點擊處理（精確轉譯 Transform 後的實際畫素座標） =====

function handleCanvasClick(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;

  // 避免點擊到 Canvas 外邊界
  if (x < 0 || x > canvas.width || y < 0 || y > canvas.height) return;

  if (mode === 'calibrate') {
    handleCalibrationClick(x, y);
  } else if (mode === 'selectTarget') {
    handleTargetSelection(x, y);
  }
}

function handleCalibrationClick(x, y) {
  const realLen = parseFloat(document.getElementById('scaleLength').value) || 1.0;
  const result = addCalibrationPoint(x, y, realLen);

  drawDot(x, y, '#ef4444');

  if (result.completed) {
    document.getElementById('scaleDisplay').innerText = `${result.pxPerMeter.toFixed(2)} px/m`;
    document.getElementById('status').innerText = '定標完成！';
    if (getTargetBBox()) document.getElementById('btnProcess').disabled = false;
    mode = 'idle';
  }
}

function handleTargetSelection(x, y) {
  const { targetBBox } = selectTarget(x, y, ctx);

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const calPoints = getCalibrationPoints();
  if (calPoints.length === 2) {
    drawDot(calPoints[0].x, calPoints[0].y, '#ef4444');
    drawDot(calPoints[1].x, calPoints[1].y, '#ef4444');
  }

  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.strokeRect(targetBBox.x, targetBBox.y, targetBBox.width, targetBBox.height);

  document.getElementById('status').innerText = '目標與特徵顏色已選定';
  if (getPxPerMeter()) document.getElementById('btnProcess').disabled = false;
  mode = 'idle';
}

// ===== 繪圖工具 =====

function drawDot(x, y, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
}

// ===== 自動追蹤 =====

async function startAutoTrack() {
  const pxPerMeter = getPxPerMeter();
  if (!pxPerMeter || !getTargetBBox() || !getTargetColor()) return;

  trackingData = [];
  isTracking = true;
  document.getElementById('btnProcess').disabled = true;
  document.getElementById('btnCalibrate').disabled = true;
  document.getElementById('btnTrack').disabled = true;
  document.getElementById('status').innerText = '正在進行逐幀追蹤...';

  if (renderLoopId !== null) {
    cancelAnimationFrame(renderLoopId);
    renderLoopId = null;
  }

  let lastDrawnIndex = 0;

  try {
    const result = await runAutoTrack({
      video,
      canvas,
      pxPerMeter,
      isTrackingCheck: () => isTracking,
      onFrameUpdate: ({ frameIdx, totalFrames, currentBBox, currentPos, trackingData: data }) => {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        if (data.length > 1) {
          ctx.strokeStyle = '#06b6d4';
          ctx.lineWidth = 2;
          ctx.beginPath();

          const startIdx = Math.max(0, lastDrawnIndex - 1);
          const startPt = data[startIdx];
          ctx.moveTo(parseFloat(startPt.x_px), parseFloat(startPt.y_px));

          for (let i = startIdx + 1; i < data.length; i++) {
            ctx.lineTo(parseFloat(data[i].x_px), parseFloat(data[i].y_px));
          }
          ctx.stroke();

          if (startIdx > 0) {
            ctx.strokeStyle = 'rgba(6, 182, 212, 0.4)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(parseFloat(data[0].x_px), parseFloat(data[0].y_px));
            for (let i = 1; i <= startIdx; i++) {
              ctx.lineTo(parseFloat(data[i].x_px), parseFloat(data[i].y_px));
            }
            ctx.stroke();
          }

          lastDrawnIndex = data.length;
        }

        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(currentBBox.x, currentBBox.y, currentBBox.width, currentBBox.height);
        drawDot(currentPos.x, currentPos.y, '#ef4444');

        document.getElementById('pointCount').innerText = data.length;
        document.getElementById('status').innerText = `追蹤中... (${frameIdx + 1}/${totalFrames} 幀)`;

        const lastPt = data[data.length - 1];
        const posDisplay = document.getElementById('posDisplay');
        if (posDisplay && lastPt) {
          posDisplay.innerText = `X: ${lastPt.x_m} m | Y: ${lastPt.y_m} m`;
        }

        renderChart(data);
      }
    });

    trackingData = result;
    document.getElementById('status').innerText = `追蹤完成！共處理 ${trackingData.length} 幀`;
    document.getElementById('btnExport').disabled = false;
  } catch (err) {
    console.error('追蹤發生錯誤:', err);
    document.getElementById('status').innerText = '追蹤過程發生錯誤';
  } finally {
    isTracking = false;
    document.getElementById('btnProcess').disabled = false;
    document.getElementById('btnCalibrate').disabled = false;
    document.getElementById('btnTrack').disabled = false;
    startRenderLoop();
  }
}

// ===== 匯出 =====

function handleExport() {
  exportCSV(trackingData);
}