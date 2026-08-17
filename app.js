// 主入口模組：協調定標、追蹤、圖表、匯出各子模組

import { resetCalibration, addCalibrationPoint, getPxPerMeter, getCalibrationPoints } from './standard.js';
import { resetTrackState, selectTarget, getTargetBBox, getTargetColor, runAutoTrack } from './track.js';
import { initChart, clearChart, renderChart, resizeChart } from './chart.js';
import { exportCSV } from './export.js';

// ===== 狀態變數 =====
let video, canvas, ctx;
let mode = 'idle'; // 'calibrate' | 'selectTarget' | 'idle'
let trackingData = [];
let isTracking = false;
let zoomLevel = 1.0;
let renderLoopId = null; // 用於取消 requestAnimationFrame，防止記憶體洩漏
let currentVideoUrl = null; // 用於釋放 ObjectURL，防止記憶體洩漏

// ===== 縮放功能 =====

function setZoom(level) {
  zoomLevel = Math.max(0.5, Math.min(4.0, level));
  applyZoom();
  const zoomDisplay = document.getElementById('zoomDisplay');
  if (zoomDisplay) zoomDisplay.innerText = `${Math.round(zoomLevel * 100)}%`;
  return zoomLevel;
}

function resetZoom() {
  return setZoom(1.0);
}

function applyZoom() {
  if (!canvas || !video) return;
  const viewport = canvas.parentElement;
  if (!viewport) return;
  const baseWidth = viewport.clientWidth;
  const baseHeight = viewport.clientHeight;

  if (video.videoWidth && video.videoHeight) {
    const aspect = video.videoWidth / video.videoHeight;
    let displayW = baseWidth;
    let displayH = baseWidth / aspect;

    if (displayH > baseHeight) {
      displayH = baseHeight;
      displayW = baseHeight * aspect;
    }

    canvas.style.width = `${displayW * zoomLevel}px`;
    canvas.style.height = `${displayH * zoomLevel}px`;
  }
}

// ===== 初始化 =====

window.onload = () => {
  video = document.getElementById('videoElement');
  canvas = document.getElementById('canvasOutput');
  ctx = canvas.getContext('2d');

  // 初始化圖表模組
  const chartX = document.getElementById('chartCanvasX');
  const chartY = document.getElementById('chartCanvasY');
  if (chartX && chartY) {
    initChart(chartX, chartY);
  }

  // 綁定事件
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

  // 綁定縮放按鈕與視窗調整事件
  document.getElementById('btnZoomIn')?.addEventListener('click', () => setZoom(zoomLevel + 0.25));
  document.getElementById('btnZoomOut')?.addEventListener('click', () => setZoom(zoomLevel - 0.25));
  document.getElementById('btnZoomReset')?.addEventListener('click', () => resetZoom());

  // 視窗大小變更時同時更新縮放與圖表
  window.addEventListener('resize', () => {
    applyZoom();
    resizeChart();
  });
};

// ===== 影片載入 =====

function handleVideoUpload(e) {
  const file = e.target ? e.target.files[0] : e;
  if (!file) return;

  // 重置所有狀態
  isTracking = false;
  trackingData = [];
  mode = 'idle';
  resetCalibration();
  resetTrackState();

  // 重置 UI 顯示
  const scaleDisplay = document.getElementById('scaleDisplay');
  if (scaleDisplay) scaleDisplay.innerText = '未設定';
  const pointCount = document.getElementById('pointCount');
  if (pointCount) pointCount.innerText = '0';
  const posDisplay = document.getElementById('posDisplay');
  if (posDisplay) posDisplay.innerText = 'X: - m | Y: - m';

  // 清除圖表
  clearChart();

  // 釋放之前的 ObjectURL，防止記憶體洩漏
  if (currentVideoUrl) {
    URL.revokeObjectURL(currentVideoUrl);
    currentVideoUrl = null;
  }

  // 取消之前的 renderLoop，防止多個循環同時運行
  if (renderLoopId !== null) {
    cancelAnimationFrame(renderLoopId);
    renderLoopId = null;
  }

  currentVideoUrl = URL.createObjectURL(file);
  video.src = currentVideoUrl;

  video.onloadeddata = () => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    applyZoom();
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    document.getElementById('btnCalibrate').disabled = false;
    document.getElementById('btnTrack').disabled = false;
    document.getElementById('btnProcess').disabled = true;
    document.getElementById('btnExport').disabled = true;
    document.getElementById('status').innerText = '影片讀取成功';

    // 啟動渲染循環（只保留一個，影片暫停時停止渲染）
    startRenderLoop();
  };
}

/**
 * 啟動影片渲染循環
 * 修復：使用 cancelAnimationFrame 確保只有一個循環在運行
 * 修復：影片暫停時不執行繪製以節省 CPU
 */
function startRenderLoop() {
  function renderLoop() {
    if (!video.paused && !video.ended) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
    renderLoopId = requestAnimationFrame(renderLoop);
  }
  renderLoopId = requestAnimationFrame(renderLoop);
}

// ===== 畫布點擊處理 =====

function handleCanvasClick(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;

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

  // 重新繪製畫面與標記
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

  // 追蹤中暫停渲染循環，由追蹤函式控制繪製
  if (renderLoopId !== null) {
    cancelAnimationFrame(renderLoopId);
    renderLoopId = null;
  }

  // 用於增量繪製軌跡的上一個點座標
  let lastDrawnIndex = 0;

  const result = await runAutoTrack({
    video,
    canvas,
    pxPerMeter,
    isTrackingCheck: () => isTracking,
    onFrameUpdate: ({ frameIdx, totalFrames, currentBBox, currentPos, trackingData: data }) => {
      // 繪製影片當前幀
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // 增量繪製軌跡（不再每次 forEach 遍歷所有資料）
      if (data.length > 1) {
        ctx.strokeStyle = '#06b6d4';
        ctx.lineWidth = 2;
        ctx.beginPath();

        // 從上次已繪製的位置開始，但需要先 moveTo 上一個點作為連接起點
        const startIdx = Math.max(0, lastDrawnIndex - 1);
        const startPt = data[startIdx];
        ctx.moveTo(parseFloat(startPt.x_px), parseFloat(startPt.y_px));

        for (let i = startIdx + 1; i < data.length; i++) {
          ctx.lineTo(parseFloat(data[i].x_px), parseFloat(data[i].y_px));
        }
        ctx.stroke();

        // 同時繪製之前的完整軌跡（透明度較低，作為背景參考線）
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

      // 繪製當前追蹤框與中心點
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(currentBBox.x, currentBBox.y, currentBBox.width, currentBBox.height);
      drawDot(currentPos.x, currentPos.y, '#ef4444');

      // 更新 UI 資訊
      document.getElementById('pointCount').innerText = data.length;
      document.getElementById('status').innerText = `追蹤中... (${frameIdx + 1}/${totalFrames} 幀)`;

      // 更新底部位置顯示
      const lastPt = data[data.length - 1];
      const posDisplay = document.getElementById('posDisplay');
      if (posDisplay && lastPt) {
        posDisplay.innerText = `X: ${lastPt.x_m} m | Y: ${lastPt.y_m} m`;
      }

      // 更新圖表
      renderChart(data);
    }
  });

  trackingData = result;
  isTracking = false;

  document.getElementById('status').innerText = `追蹤完成！共處理 ${trackingData.length} 幀`;
  document.getElementById('btnExport').disabled = false;
  document.getElementById('btnProcess').disabled = false;
  document.getElementById('btnCalibrate').disabled = false;
  document.getElementById('btnTrack').disabled = false;

  // 追蹤結束後重新啟動渲染循環
  startRenderLoop();
}

// ===== 匯出 =====

function handleExport() {
  exportCSV(trackingData);
}