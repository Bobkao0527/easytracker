// app.js
import {resetCalibration, addCalibrationPoint, getPxPerMeter, getCalibrationPoints, transformCoordinates, autoCalculateK1, calculateHomographyFrom4Points} from './standard.js';
import {resetTrackState, selectTarget, getTargetBBox, getTargetColor, setTargetCenter, runAutoTrack, drawTrackingGizmo, hitTestHandles, updateTemplatePatch, getTargetCenter, getTemplateSize, setSearchRadius, getSearchRadius, seekTo} from './track.js';
import {initChart, clearChart, renderChart} from './chart.js';
import { exportCSV } from './export.js';
import {initZoomPan, resetZoomPan} from './zoomPan.js';
import { initDistortionRenderer, renderDistortedVideo, setHomographyMatrix } from './distortion.js';

let video, canvas, ctx;
let mode = 'idle'; 

let trackingData = [];
let isTracking = false;
let isPaused = false; // ★ 追蹤暫停狀態
let renderLoopId = null;
let currentVideoUrl = null;
let roiStartPoint = null;

let activeDragMode = null;
let dragOffset = { x: 0, y: 0 };
let resolveTargetCorrection = null;
let mouseDownPos = { x: 0, y: 0 };
let hasMovedDuringDrag = false;
let pendingTargetSize = null;

let lastFpsCalcTime = 0;
let framesSinceLastCalc = 0;

let k1LinePoints = [];
const K1_TARGET_POINTS = 6;
let rectCorners = [];
const CORNER_NAMES = ['【左上角 TL】', '【右上角 TR】', '【右下角 BR】', '【左下角 BL】'];
let currentHomography = [1,0,0, 0,1,0, 0,0,1];

const UI_UPDATE_INTERVAL = 1000 / 30;
const CHART_UPDATE_INTERVAL = 1000 / 10;
let lastUIUpdateTime = 0;
let lastChartUpdateTime = 0;

// ★ 時間軸與播放元素
let timeSlider, timeDisplay, btnPlayPause, btnPrevFrame, btnNextFrame;

window.onload = () => {
  video = document.getElementById('videoElement');
  canvas = document.getElementById('canvasOutput');
  ctx = canvas.getContext('2d');

  timeSlider = document.getElementById('timeSlider');
  timeDisplay = document.getElementById('timeDisplay');
  btnPlayPause = document.getElementById('btnPlayPause');
  btnPrevFrame = document.getElementById('btnPrevFrame');
  btnNextFrame = document.getElementById('btnNextFrame');

  const chartX = document.getElementById('chartCanvasX');
  const chartY = document.getElementById('chartCanvasY');
  if (chartX && chartY) initChart(chartX, chartY);
  initZoomPan(canvas);

  document.getElementById('videoInput').addEventListener('change', handleVideoUpload);

  const thresholdSlider = document.getElementById('matchThreshold');
  const thresholdVal = document.getElementById('thresholdValue');
  thresholdSlider?.addEventListener('input', (e) => {
    thresholdVal.innerText = parseFloat(e.target.value).toFixed(2);
  });

  // 暫停校正工具列按鈕 (NCC 門檻過低觸發時)
  document.getElementById('btnResumeTrack')?.addEventListener('click', () => {
    if (resolveTargetCorrection) {
      document.getElementById('lostTargetBar').style.display = 'none';
      const center = getTargetCenter();
      if (center) {
        renderCurrentFrame(false);
        updateTemplatePatch(ctx, center.cx, center.cy, getTemplateSize());
      }
      mode = 'idle';
      resolveTargetCorrection('continue');
      resolveTargetCorrection = null;
    }
  });

  document.getElementById('btnSkipFrame')?.addEventListener('click', () => {
    if (resolveTargetCorrection) {
      document.getElementById('lostTargetBar').style.display = 'none';
      mode = 'idle';
      resolveTargetCorrection('skip');
      resolveTargetCorrection = null;
    }
  });

  document.getElementById('btnStopTrack')?.addEventListener('click', () => {
    if (resolveTargetCorrection) {
      document.getElementById('lostTargetBar').style.display = 'none';
      mode = 'idle';
      resolveTargetCorrection('abort');
      resolveTargetCorrection = null;
    }
  });

  document.getElementById('btnCalibrate').addEventListener('click', () => {
    mode = 'calibrate';
    resetCalibration();
    document.getElementById('status').innerText = '請點擊影片上的兩點設定真實長度';
  });

  const start4PointMode = () => {
    mode = 'select4Point';
    rectCorners = [];
    currentHomography = [1,0,0, 0,1,0, 0,0,1];
    setHomographyMatrix(currentHomography);
    renderCurrentFrame(true);
    document.getElementById('status').innerText = `【4點矩形透視校正】請點選已知長方形的 ${CORNER_NAMES[0]} (1/4)`;
  };

  document.getElementById('btnAutoPerspective')?.addEventListener('click', start4PointMode);
  document.getElementById('btnAutoK1')?.addEventListener('click', () => {
    mode = 'selectK1Line';
    k1LinePoints = [];
    document.getElementById('status').innerText = `【k1 畸變校正】請點擊同一直線上 ${K1_TARGET_POINTS} 個點 (0/${K1_TARGET_POINTS})`;
  });

  document.getElementById('btnROI')?.addEventListener('click', () => {
    mode = 'selectROI';
    document.getElementById('status').innerText = '請在影片上拉框選取運動邊界 (ROI)';
  });

  document.getElementById('btnTrack').addEventListener('click', () => {
    mode = 'selectTarget';
    document.getElementById('status').innerText = '請點擊目標物體中心 (拖曳內部可平移，拖曳四角可縮放)';
  });

  // 追蹤主按鈕 (開始/暫停/繼續)
  document.getElementById('btnProcess').addEventListener('click', handleTrackButtonAction);
  document.getElementById('btnExport').addEventListener('click', handleExport);

  // ★ 時間軸控制項事件綁定
  initPlaybackEvents();

  canvas.addEventListener('mousedown', handleCanvasMouseDown);
  canvas.addEventListener('mousemove', handleCanvasMouseMove);
  canvas.addEventListener('mouseup', handleCanvasMouseUp);
  canvas.addEventListener('click', handleCanvasClick);
};

// 格式化時間 (mm:ss.SS)
function formatTime(sec) {
  if (isNaN(sec)) return '00:00.00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

function updateTimelineUI() {
  if (!video || !timeSlider) return;
  timeSlider.value = video.currentTime;
  if (timeDisplay) {
    timeDisplay.innerText = `${formatTime(video.currentTime)} / ${formatTime(video.duration || 0)}`;
  }
}

// 播放與時間軸事件設定
function initPlaybackEvents() {
  btnPlayPause?.addEventListener('click', () => {
    if (isTracking) {
      pauseAutoTrack();
      return;
    }
    if (video.paused) {
      video.play();
      btnPlayPause.innerText = '⏸';
    } else {
      video.pause();
      btnPlayPause.innerText = '▶';
    }
  });

  // 2. 拖曳時間軸
  timeSlider?.addEventListener('input', async (e) => {
    if (isTracking) pauseAutoTrack();
    const t = parseFloat(e.target.value);
    await seekTo(video, t);
    renderCurrentFrame(true);
    
    // ★ 關鍵：先同步該幀的歷史座標，再畫出 Gizmo
    syncGizmoToCurrentTime();
    if (getTargetColor()) redrawActiveGizmo();
    updateTimelineUI();
  });

  // 3. 上一幀微調
  btnPrevFrame?.addEventListener('click', async () => {
    if (isTracking) pauseAutoTrack();
    const newT = Math.max(0, video.currentTime - 1 / 30);
    await seekTo(video, newT);
    renderCurrentFrame(true);
    
    // ★ 關鍵：同步上一幀狀態
    syncGizmoToCurrentTime();
    if (getTargetColor()) redrawActiveGizmo();
    updateTimelineUI();
  });

  // 4. 下一幀微調
  btnNextFrame?.addEventListener('click', async () => {
    if (isTracking) pauseAutoTrack();
    const newT = Math.min(video.duration || 0, video.currentTime + 1 / 30);
    await seekTo(video, newT);
    renderCurrentFrame(true);
    
    // ★ 關鍵：同步下一幀狀態
    syncGizmoToCurrentTime();
    if (getTargetColor()) redrawActiveGizmo();
    updateTimelineUI();
  });
}

function getCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY
  };
}

function redrawActiveGizmo() {
  const targetCenter = getTargetCenter();
  if (!targetCenter) return;

  renderCurrentFrame(true);

  const tSize = pendingTargetSize || getTemplateSize();
  const halfT = Math.floor(tSize / 2);
  const searchRadius = getSearchRadius();
  const { cx, cy } = targetCenter;

  const searchX = Math.max(0, Math.min(canvas.width - searchRadius * 2, cx - searchRadius));
  const searchY = Math.max(0, Math.min(canvas.height - searchRadius * 2, cy - searchRadius));
  const searchW = Math.min(searchRadius * 2, canvas.width - searchX);
  const searchH = Math.min(searchRadius * 2, canvas.height - searchY);

  drawTrackingGizmo(ctx, {
    searchX, searchY, searchW, searchH,
    searchCenterX: cx, searchCenterY: cy,
    searchRadius,
    matchBox: {
      x: cx - halfT,
      y: cy - halfT,
      width: tSize,
      height: tSize
    },
    centerX: cx, centerY: cy,
    isLost: mode === 'pausedCorrection',
    showHandles: true
  });
}

function handleCanvasMouseDown(e) {
  const { x, y } = getCanvasCoords(e);
  mouseDownPos = { x, y };
  hasMovedDuringDrag = false;

  // 只要不是正在連續追蹤中，均允許選取或調整手柄
  if (getTargetColor() && (!isTracking || mode === 'pausedCorrection')) {
    const hit = hitTestHandles(x, y, canvas.width, canvas.height);
    if (hit) {
      activeDragMode = hit.type;
      const center = getTargetCenter();
      if (center) {
        dragOffset = { x: x - center.cx, y: y - center.cy };
      }
      return;
    }
  }

  if (mode === 'selectROI') {
    roiStartPoint = { x, y };
  }
}

function handleCanvasMouseMove(e) {
  const { x, y } = getCanvasCoords(e);

  if (activeDragMode) {
    if (Math.hypot(x - mouseDownPos.x, y - mouseDownPos.y) > 3) {
      hasMovedDuringDrag = true;
    }

    const targetCenter = getTargetCenter();
    if (!targetCenter) return;
    const { cx, cy } = targetCenter;

    if (activeDragMode === 'move') {
      const newCx = Math.max(10, Math.min(canvas.width - 10, x - dragOffset.x));
      const newCy = Math.max(10, Math.min(canvas.height - 10, y - dragOffset.y));
      setTargetCenter(newCx, newCy);
      redrawActiveGizmo();
      document.getElementById('status').innerText = `正在移動目標至: (${Math.round(newCx)}, ${Math.round(newCy)})`;
    } else if (activeDragMode === 'target') {
      const dist = Math.max(Math.abs(x - cx), Math.abs(y - cy));
      pendingTargetSize = Math.max(10, Math.min(dist * 2, getSearchRadius() * 2 - 6));
      redrawActiveGizmo();
      document.getElementById('status').innerText = `正在調整目標尺寸: ${Math.round(pendingTargetSize)} px`;
    } else if (activeDragMode === 'search') {
      const dist = Math.max(Math.abs(x - cx), Math.abs(y - cy));
      const newRadius = Math.max(getTemplateSize() / 2 + 5, dist);
      setSearchRadius(newRadius);
      redrawActiveGizmo();
      document.getElementById('status').innerText = `已調整搜尋範圍半徑為: ${Math.round(newRadius)} px`;
    }
    return;
  }

  if (getTargetColor() && (!isTracking || mode === 'pausedCorrection')) {
    const hit = hitTestHandles(x, y, canvas.width, canvas.height);
    canvas.style.cursor = hit ? hit.cursor : 'default';
  } else {
    canvas.style.cursor = 'default';
  }

  if (mode === 'selectROI' && roiStartPoint) {
    const minX = Math.min(roiStartPoint.x, x);
    const minY = Math.min(roiStartPoint.y, y);
    const width = Math.abs(x - roiStartPoint.x);
    const height = Math.abs(y - roiStartPoint.y);

    renderCurrentFrame(true);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(minX, minY, width, height);
    ctx.setLineDash([]);
  }
}

function handleCanvasMouseUp() {
  if (activeDragMode) {
    const center = getTargetCenter();
    if (center) {
      renderCurrentFrame(false);
      const finalSize = pendingTargetSize || getTemplateSize();
      updateTemplatePatch(ctx, center.cx, center.cy, finalSize);
      pendingTargetSize = null;

      // ★ 新增：微調完成後，將當前幀的座標回寫進 trackingData
      if (!isTracking) {
        updateCurrentFrameData(center.cx, center.cy);
      }
    }
    activeDragMode = null;
    redrawActiveGizmo();
    return;
  }

  if (mode === 'selectROI' && roiStartPoint) {
    mode = 'idle';
    roiStartPoint = null;
  }
}

function handleCanvasClick(e) {
  if (hasMovedDuringDrag) {
    hasMovedDuringDrag = false;
    return;
  }

  const { x, y } = getCanvasCoords(e);
  if (x < 0 || x > canvas.width || y < 0 || y > canvas.height) return;

  // 暫停校正時點擊空白處重設中心點
  if (mode === 'pausedCorrection') {
    renderCurrentFrame(false);
    updateTemplatePatch(ctx, x, y, getTemplateSize());
    redrawActiveGizmo();
    document.getElementById('status').innerText = `已校正目標至點位: (${Math.round(x)}, ${Math.round(y)})，可點擊「確認修正」或直接拖曳微調`;
    return;
  }

  if (mode === 'calibrate') {
    handleCalibrationClick(x, y);
  } else if (mode === 'selectTarget') {
    handleTargetSelection(x, y);
  } else if (mode === 'select4Point') {
    handle4PointClick(x, y);
  } else if (mode === 'selectK1Line') {
    handleK1LineClick(x, y);
  }
}

function handleTargetSelection(x, y) {
  renderCurrentFrame(false);
  selectTarget(x, y, ctx, 28);
  redrawActiveGizmo();

  document.getElementById('status').innerText = '目標已就緒！拖曳綠框可平移，拖曳四角可縮放。';
  document.getElementById('btnProcess').disabled = false;
  mode = 'idle';
}

function handleTrackingFrameUpdate(frameData, allData) {
  if (!frameData || !Array.isArray(allData)) return;

  updateTimelineUI();

  const now = performance.now();
  framesSinceLastCalc++;

  if (now - lastFpsCalcTime >= 500) {
    if (lastFpsCalcTime > 0) {
      const elapsedSec = (now - lastFpsCalcTime) / 1000;
      const currentFPS = (framesSinceLastCalc / elapsedSec).toFixed(1);
      const fpsDisplay = document.getElementById('fpsDisplay');
      if (fpsDisplay) fpsDisplay.innerText = `${currentFPS} FPS`;
    }
    lastFpsCalcTime = now;
    framesSinceLastCalc = 0;
  }

  if (now - lastUIUpdateTime >= UI_UPDATE_INTERVAL) {
    lastUIUpdateTime = now;
    updateTrackingUI(frameData, allData);
  }

  if (now - lastChartUpdateTime >= CHART_UPDATE_INTERVAL) {
    lastChartUpdateTime = now;
    renderChart(allData);
  }
}

function handleVideoUpload(e) {
  const file = e.target ? e.target.files[0] : e;
  if (!file) return;

  isTracking = false;
  isPaused = false;
  trackingData = [];
  mode = 'idle';

  resetCalibration();
  resetTrackState();
  resetZoomPan();

  const scaleDisplay = document.getElementById('scaleDisplay');
  if (scaleDisplay) scaleDisplay.innerText = '1000.00 px/m (預設)';
  const pointCount = document.getElementById('pointCount');
  if (pointCount) pointCount.innerText = '0';
  const posDisplay = document.getElementById('posDisplay');
  if (posDisplay) posDisplay.innerText = 'X: - m | Y: - m';
  const fpsDisplay = document.getElementById('fpsDisplay');
  if (fpsDisplay) fpsDisplay.innerText = '- FPS';

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

    if (timeSlider) {
      timeSlider.max = video.duration;
      timeSlider.value = 0;
    }
    updateTimelineUI();

    initDistortionRenderer(video.videoWidth, video.videoHeight);
    renderCurrentFrame(true);

    document.getElementById('btnCalibrate').disabled = false;
    document.getElementById('btnTrack').disabled = false;
    document.getElementById('btnProcess').disabled = true;
    document.getElementById('btnProcess').innerText = '3. 開始自動追蹤';
    document.getElementById('btnExport').disabled = true;

    document.getElementById('status').innerText = '影片載入成功，請進行定標或選取目標';
    startRenderLoop();
  };

  video.onerror = () => {
    document.getElementById('status').innerText = '影片無法讀取，請確認格式或重新選擇影片';
  };
  video.load();
}

function renderCurrentFrame(withGrid = true) {
  if (!video) return;
  const k1 = parseFloat(document.getElementById('k1Distortion')?.value) || 0;
  const tiltAngle = parseFloat(document.getElementById('tiltAngle')?.value) || 0;
  const calPoints = getCalibrationPoints();
  const origin = calPoints[0] || { x: canvas.width / 2, y: canvas.height / 2 };

  const renderedWithWebGL = renderDistortedVideo(video, ctx, k1);
  if (!renderedWithWebGL && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }

  if (withGrid) {
    drawGrid(ctx, canvas.width, canvas.height, 50, tiltAngle, origin);
  }
}

function startRenderLoop() {
  if (renderLoopId !== null) cancelAnimationFrame(renderLoopId);

  function renderLoop() {
    if (!isTracking && !video.paused && !video.ended) {
      renderCurrentFrame();
      updateTimelineUI();
      if (getTargetColor() && mode === 'idle') {
        redrawActiveGizmo();
      }
    }
    renderLoopId = requestAnimationFrame(renderLoop);
  }
  renderLoopId = requestAnimationFrame(renderLoop);
}

// ★ 追蹤按鈕總控：開始 / 暫停 / 繼續
function handleTrackButtonAction() {
  if (isTracking) {
    pauseAutoTrack();
  } else {
    startAutoTrack();
  }
}

function pauseAutoTrack() {
  isTracking = false;
  isPaused = true;
  const btnProcess = document.getElementById('btnProcess');
  if (btnProcess) {
    btnProcess.innerText = '▶ 繼續追蹤';
    btnProcess.disabled = false;
  }
  document.getElementById('status').innerText = '已暫停追蹤！可拖動綠框調整位置或拖曳時間軸，確認後點擊「繼續追蹤」';
  renderCurrentFrame(true);
  redrawActiveGizmo();
  startRenderLoop();
}

async function startAutoTrack() {
  const pxPerMeter = getPxPerMeter();
  const searchRadius = getSearchRadius();
  const threshold = parseFloat(document.getElementById('matchThreshold')?.value) || 0.55;

  if (!getTargetBBox() || !getTargetColor()) {
    alert('請先點選畫面中的目標物體！');
    return;
  }

  // 若是從暫停接續，修剪當前時間之後的舊資料，避免產生時間回溯與重疊數據
  const currentSeekTime = video.currentTime;
  if (isPaused) {
    trackingData = trackingData.filter(d => parseFloat(d.time) < currentSeekTime - 0.001);
  } else {
    trackingData = [];
  }

  isTracking = true;
  isPaused = false;

  lastFpsCalcTime = performance.now();
  framesSinceLastCalc = 0;
  const trackStartTime = performance.now();

  const btnProcess = document.getElementById('btnProcess');
  btnProcess.innerText = '⏸ 暫停追蹤';
  btnProcess.disabled = false;

  document.getElementById('btnCalibrate').disabled = true;
  document.getElementById('btnTrack').disabled = true;
  document.getElementById('btnExport').disabled = true;

  const fpsDisplay = document.getElementById('fpsDisplay');
  if (fpsDisplay) fpsDisplay.innerText = '計算中...';
  document.getElementById('status').innerText = '正在進行逐幀自動追蹤...';

  if (renderLoopId !== null) {
    cancelAnimationFrame(renderLoopId);
    renderLoopId = null;
  }

  try {
    const result = await runAutoTrack({
      video,
      canvas,
      pxPerMeter,
      searchRadius,
      threshold,
      startTime: currentSeekTime,     // ★ 從當前時間點繼續
      initialData: trackingData,      // ★ 接續前面已追蹤的數據
      isTrackingCheck: () => isTracking,
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
          isAlreadyRectified: true
        });
      },
      onFrameUpdate: handleTrackingFrameUpdate,
      onTargetLost: (lostInfo) => {
        return new Promise((resolve) => {
          resolveTargetCorrection = resolve;
          mode = 'pausedCorrection';
          document.getElementById('lostTargetBar').style.display = 'flex';
          document.getElementById('status').innerText = `目標在第 ${lostInfo.frameIdx} 幀遺失！請直接「點選物體新位置」或拖曳綠框校正`;
          renderCurrentFrame(true);
          redrawActiveGizmo();
        });
      }
    });

    trackingData = Array.isArray(result) ? result : [];

    if (trackingData.length) {
      const last = trackingData[trackingData.length - 1];
      updateTrackingUI(last, trackingData);
      renderChart(trackingData);

      const totalElapsedSec = (performance.now() - trackStartTime) / 1000;
      const avgFPS = (trackingData.length / totalElapsedSec).toFixed(1);
      if (fpsDisplay) fpsDisplay.innerText = `均速 ${avgFPS} FPS`;
    }

    // 若非人為暫停，代表影片播放完畢
    if (!isPaused) {
      document.getElementById('status').innerText = `追蹤完成！共處理 ${trackingData.length} 幀`;
      btnProcess.innerText = '3. 重新追蹤';
    }
    document.getElementById('btnExport').disabled = trackingData.length === 0;
  } catch (err) {
    console.error('追蹤發生錯誤:', err);
    document.getElementById('status').innerText = `追蹤失敗：${err?.message || '未知錯誤'}`;
    if (fpsDisplay) fpsDisplay.innerText = '- FPS';
    btnProcess.innerText = '3. 開始自動追蹤';
  } finally {
    if (!isPaused) {
      isTracking = false;
      document.getElementById('btnCalibrate').disabled = false;
      document.getElementById('btnTrack').disabled = false;
    }
    document.getElementById('lostTargetBar').style.display = 'none';

    renderCurrentFrame(true);
    redrawActiveGizmo();
    startRenderLoop();
  }
}

// 其餘定標與幾何輔助函式保持原狀
function handleCalibrationClick(x, y) {
  const realLen = parseFloat(document.getElementById('scaleLength').value) || 1.0;
  const result = addCalibrationPoint(x, y, realLen);
  drawDot(x, y, '#ef4444');

  if (result.completed) {
    document.getElementById('scaleDisplay').innerText = `${result.pxPerMeter.toFixed(2)} px/m`;
    document.getElementById('status').innerText = '定標完成！';
    mode = 'idle';
  }
}

function drawDot(x, y, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function updateTrackingUI(frameData, allData) {
  if (!frameData) return;

  const pointCount = document.getElementById('pointCount');
  if (pointCount && Array.isArray(allData)) {
    pointCount.innerText = allData.length.toString();
  }

  const tiltAngle = parseFloat(document.getElementById('tiltAngle')?.value) || 0;
  const calPoints = getCalibrationPoints();
  const origin = calPoints[0] || { x: 0, y: canvas.height };

  try {
    const corrected = transformCoordinates(frameData.cx, frameData.cy, {
      imageWidth: canvas.width,
      imageHeight: canvas.height,
      tiltAngleDeg: tiltAngle,
      originX: origin.x,
      originY: origin.y,
      isAlreadyRectified: true
    });

    const posDisplay = document.getElementById('posDisplay');
    if (posDisplay && corrected && !isNaN(corrected.x_m) && !isNaN(corrected.y_m)) {
      posDisplay.innerText = `X: ${corrected.x_m.toFixed(3)} m | Y: ${corrected.y_m.toFixed(3)} m`;
    } else if (posDisplay) {
      posDisplay.innerText = `X: ${frameData.cx.toFixed(1)} px | Y: ${frameData.cy.toFixed(1)} px`;
    }
  } catch (e) {
    console.warn('座標轉換警告:', e);
  }
}

function handle4PointClick(x, y) {
  rectCorners.push({ x, y });
  const count = rectCorners.length;
  drawDot(x, y, '#38bdf8');

  if (count > 1) {
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(rectCorners[count - 2].x, rectCorners[count - 2].y);
    ctx.lineTo(rectCorners[count - 1].x, rectCorners[count - 1].y);
    ctx.stroke();
  }

  if (count < 4) {
    document.getElementById('status').innerText = `【4點矩形透視校正】請點選參考矩形的 ${CORNER_NAMES[count]} (${count + 1}/4)`;
  } else {
    ctx.beginPath();
    ctx.moveTo(rectCorners[3].x, rectCorners[3].y);
    ctx.lineTo(rectCorners[0].x, rectCorners[0].y);
    ctx.stroke();

    try {
      const result = calculateHomographyFrom4Points(rectCorners, canvas.width, canvas.height);
      currentHomography = result.homography;
      setHomographyMatrix(currentHomography);
      renderCurrentFrame(true);
      document.getElementById('status').innerText = '視角轉正成功！請點擊「定標」按鈕進行公尺標定。';
    } catch (err) {
      console.error(err);
      alert('校正計算失敗，請確保 4 個角點形成合理的凸四邊形！');
      renderCurrentFrame(true);
    }
    mode = 'idle';
    rectCorners = [];
  }
}

function handleK1LineClick(x, y) {
  k1LinePoints.push({ x, y });
  drawDot(x, y, '#38bdf8');

  const count = k1LinePoints.length;
  document.getElementById('status').innerText = `請點擊畫面上同一直線邊緣的 ${K1_TARGET_POINTS} 個點 (${count}/${K1_TARGET_POINTS})`;

  if (count >= K1_TARGET_POINTS) {
    const calculatedK1 = autoCalculateK1(k1LinePoints, canvas.width, canvas.height);
    const k1Input = document.getElementById('k1Distortion');
    const k1ValueDisplay = document.getElementById('k1Value');
    if (k1Input && k1ValueDisplay) {
      k1Input.value = calculatedK1;
      k1ValueDisplay.innerText = calculatedK1.toFixed(3);
    }

    renderCurrentFrame();
    document.getElementById('status').innerText = `k1 畸變計算完成：${calculatedK1.toFixed(4)}！`;
    mode = 'idle';
    k1LinePoints = [];
  }
}

function handleExport() {
  if (!trackingData.length) return;

  const tiltAngle = parseFloat(document.getElementById('tiltAngle')?.value) || 0;
  const calPoints = getCalibrationPoints();
  const origin = calPoints[0] || { x: 0, y: canvas.height };
  const hasScale = getPxPerMeter() > 0;

  const exportData = trackingData.map(item => {
    const corrected = transformCoordinates(item.cx, item.cy, {
      imageWidth: canvas.width,
      imageHeight: canvas.height,
      tiltAngleDeg: tiltAngle,
      originX: origin.x,
      originY: origin.y,
      isAlreadyRectified: true
    });

    return {
      ...item,
      x_m: hasScale ? corrected.x_m.toFixed(4) : corrected.x.toFixed(1),
      y_m: hasScale ? corrected.y_m.toFixed(4) : corrected.y.toFixed(1)
    };
  });

  exportCSV(exportData);
}

function drawGrid(ctx, width, height, baseStep = 50, tiltAngleDeg = 0, origin = { x: width / 2, y: height / 2 }) {
  ctx.save();
  ctx.translate(origin.x, origin.y);
  const rad = (tiltAngleDeg * Math.PI) / 180;
  ctx.rotate(rad);

  const maxDim = Math.hypot(width, height) * 2;
  const step = baseStep;

  ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let x = -maxDim; x <= maxDim; x += step) {
    ctx.moveTo(x, -maxDim); ctx.lineTo(x, maxDim);
  }
  for (let y = -maxDim; y <= maxDim; y += step) {
    ctx.moveTo(-maxDim, y); ctx.lineTo(maxDim, y);
  }
  ctx.stroke();

  ctx.lineWidth = 1.2;
  ctx.strokeStyle = 'rgba(239, 68, 68, 0.75)';
  ctx.beginPath();
  ctx.moveTo(-maxDim, 0); ctx.lineTo(maxDim, 0);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(34, 197, 94, 0.75)';
  ctx.beginPath();
  ctx.moveTo(0, -maxDim); ctx.lineTo(0, maxDim);
  ctx.stroke();
  ctx.restore();
}

// 根據當前影片時間，尋找歷史追蹤點並將選取框移至該狀態
function syncGizmoToCurrentTime() {
  if (!trackingData || trackingData.length === 0) return;
  
  const curTime = video.currentTime;
  const fps = 30;
  const tolerance = (1 / fps) * 0.7; // 容許誤差約半幀多一點

  // 尋找時間最接近當前時間的點
  let closestPoint = null;
  let minDiff = Infinity;

  for (const pt of trackingData) {
    const diff = Math.abs(parseFloat(pt.time) - curTime);
    if (diff < minDiff) {
      minDiff = diff;
      closestPoint = pt;
    }
  }

  // 如果找到足夠接近的歷史影格
  if (closestPoint && minDiff <= tolerance) {
    setTargetCenter(closestPoint.cx, closestPoint.cy);
    updateTrackingUI(closestPoint, trackingData);
    document.getElementById('status').innerText = `已載入第 ${closestPoint.frame} 幀記錄 (時間: ${closestPoint.time}s)，可拖曳微調`;
  }
}

// 當使用者手動調整了選取框位置，覆寫/更新該影格在 trackingData 中的數據
function updateCurrentFrameData(cx, cy) {
  if (!trackingData || trackingData.length === 0) return;

  const curTime = video.currentTime;
  const fps = 30;
  const tolerance = (1 / fps) * 0.7;

  let matchedIdx = -1;
  let minDiff = Infinity;

  for (let i = 0; i < trackingData.length; i++) {
    const diff = Math.abs(parseFloat(trackingData[i].time) - curTime);
    if (diff < minDiff) {
      minDiff = diff;
      matchedIdx = i;
    }
  }

  // 如果這幀是已經追蹤過的，覆寫它的資料
  if (matchedIdx !== -1 && minDiff <= tolerance) {
    const tiltAngle = parseFloat(document.getElementById('tiltAngle')?.value) || 0;
    const calPoints = getCalibrationPoints();
    const origin = calPoints[0] || { x: 0, y: canvas.height };
    const pxPerMeter = getPxPerMeter();

    const trans = transformCoordinates(cx, cy, {
      imageWidth: canvas.width,
      imageHeight: canvas.height,
      tiltAngleDeg: tiltAngle,
      originX: origin.x,
      originY: origin.y,
      isAlreadyRectified: true
    });

    const targetItem = trackingData[matchedIdx];
    targetItem.cx = cx;
    targetItem.cy = cy;
    targetItem.x_px = cx.toFixed(1);
    targetItem.y_px = cy.toFixed(1);
    targetItem.x_m = pxPerMeter ? trans.x_m.toFixed(4) : (cx / (pxPerMeter || 1)).toFixed(4);
    targetItem.y_m = pxPerMeter ? trans.y_m.toFixed(4) : ((canvas.height - cy) / (pxPerMeter || 1)).toFixed(4);
    targetItem.score = "1.000 (手動微調)";

    updateTrackingUI(targetItem, trackingData);
    renderChart(trackingData);
    document.getElementById('status').innerText = `第 ${targetItem.frame} 幀位置已手動校正覆寫！`;
  }
}