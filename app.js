// app.js
import { resetCalibration, addCalibrationPoint, getPxPerMeter, getCalibrationPoints, transformCoordinates, autoCalculateK1, calculateHomographyFrom4Points, calculateHomographyFrom8Points} from './standard.js';
import { resetTrackState, addTargetPoint, getAllTargets, getActiveTarget, setActiveTargetId,removeTarget, setTargetCenter, setSearchRadius, updateTemplatePatch, hitTestHandles, drawAllGizmos, runAutoTrack, seekTo} from './track.js';
import { initChart, clearChart, renderChart, renderAngleChart } from './chart.js';
import { exportCSV } from './export.js';
import { initZoomPan, resetZoomPan} from './zoomPan.js';
import { initDistortionRenderer, renderDistortedVideo, setHomographyMatrix } from './distortion.js';
import { addLine, addAngle, hitTestLine, drawGeometryGizmos, calculateAngleBetweenLines, getLineEndpoints, getAllLines, getAllAngles, resetGeometryState} from './geometry.js';

let video, canvas, ctx;
let mode = 'idle'; // 'idle' | 'calibrate' | 'selectTarget' | 'pausedCorrection' | ...

let isTracking = false;
let isPaused = false;
let renderLoopId = null;
let currentVideoUrl = null;

let activeDragMode = null;
let dragOffset = { x: 0, y: 0 };
let resolveTargetCorrection = null;
let mouseDownPos = { x: 0, y: 0 };
let hasMovedDuringDrag = false;
let pendingTargetSize = null;

let lastFpsCalcTime = 0;
let framesSinceLastCalc = 0;
let lostTargetObj = null;

let k1LinePoints = [];
const K1_TARGET_POINTS = 6;
let rectCorners = [];
const CORNER_NAMES = ['【遠處左角】', '【遠處右角】', '【近處右角】', '【近處左角】'];
let currentHomography = [1,0,0, 0,1,0, 0,0,1];

const UI_UPDATE_INTERVAL = 1000 / 30;
const CHART_UPDATE_INTERVAL = 1000 / 10;
let lastUIUpdateTime = 0;
let lastChartUpdateTime = 0;
let currentTargetFilter = 'all'; // 'all' 或質點 id
let currentAngleFilter = 'all';  // 'all' 或角度 id

let pendingLineP1 = null;    // 連線模式：暫存第 1 個點
let pendingAngleLine1 = null; // 夾角模式：暫存第 1 條線
let pendingAngleLine2 = null;

let timeSlider, timeDisplay, btnPlayPause, btnPrevFrame, btnNextFrame;

let perspective8Points = [];
const LINE8_DESCS = [
  '第 1 條「鉛直線」起點 (1/8)',
  '第 1 條「鉛直線」終點 (2/8)',
  '第 2 條「鉛直線」起點 (3/8)',
  '第 2 條「鉛直線」終點 (4/8)',
  '第 1 條「水平線」起點 (5/8)',
  '第 1 條「水平線」終點 (6/8)',
  '第 2 條「水平線」起點 (7/8)',
  '第 2 條「水平線」終點 (8/8)'
];

window.onload = () => {
  video = document.getElementById('videoElement');
  canvas = document.getElementById('canvasOutput');
  ctx = canvas.getContext('2d');

  timeSlider = document.getElementById('timeSlider');
  timeDisplay = document.getElementById('timeDisplay');
  btnPlayPause = document.getElementById('btnPlayPause');
  btnPrevFrame = document.getElementById('btnPrevFrame');
  btnNextFrame = document.getElementById('btnNextFrame');

  // 統一在此完整初始化三組示波器 (X / Y / Angle)
  const chartX = document.getElementById('chartCanvasX');
  const chartY = document.getElementById('chartCanvasY');
  const chartAngle = document.getElementById('chartCanvasAngle');
  if (chartX && chartY) initChart(chartX, chartY, chartAngle);

  initZoomPan(canvas);

  document.getElementById('videoInput').addEventListener('change', handleVideoUpload);

  const thresholdSlider = document.getElementById('matchThreshold');
  const thresholdVal = document.getElementById('thresholdValue');
  thresholdSlider?.addEventListener('input', (e) => {
    thresholdVal.innerText = parseFloat(e.target.value).toFixed(2);
  });

  // 暫停校正工具列
  document.getElementById('btnResumeTrack')?.addEventListener('click', () => {
    if (resolveTargetCorrection) {
      document.getElementById('lostTargetBar').style.display = 'none';
      const active = getActiveTarget();
      if (active && active.center) {
        renderCurrentFrame(false);
        updateTemplatePatch(ctx, active.center.cx, active.center.cy, active.templateSize, active.id);
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
      resolveTargetCorrection('continue');
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

  // --- 徑向畸變 k1 滑桿監聽 ---
  const k1Slider = document.getElementById('k1Distortion');
  const k1Value = document.getElementById('k1Value');
  k1Slider?.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    if (k1Value) k1Value.innerText = val.toFixed(3);
    // 即時更新畫布畫面與幾何標註
    renderCurrentFrame(true);
    redrawActiveGizmo();
  });

  // --- 水平補償角 tiltAngle 監聽 ---
  const tiltInput = document.getElementById('tiltAngle');
  tiltInput?.addEventListener('input', () => {
    renderCurrentFrame(true);
    redrawActiveGizmo();

    // 若已有追蹤軌跡，同步重新計算各點物理座標並重繪圖表
    const targets = getAllTargets();
    const tiltAngle = parseFloat(tiltInput.value) || 0;
    const calPoints = getCalibrationPoints();
    const origin = calPoints[0] || { x: 0, y: canvas.height };

    targets.forEach(t => {
      t.trajectory.forEach(pt => {
        const trans = transformCoordinates(pt.cx, pt.cy, {
          imageWidth: canvas.width,
          imageHeight: canvas.height,
          tiltAngleDeg: tiltAngle,
          originX: origin.x,
          originY: origin.y,
          isAlreadyRectified: true
        });
        pt.x_m = trans.x_m.toFixed(4);
        pt.y_m = trans.y_m.toFixed(4);
      });
    });

    if (targets.some(t => t.trajectory.length > 0)) {
      renderChart(targets, currentTargetFilter);
    }
  });

  document.getElementById('btnCalibrate').addEventListener('click', () => {
    mode = 'calibrate';
    resetCalibration();
    document.getElementById('status').innerText = '請在畫面點選兩基準點設定實體公尺距離';
  });

  document.getElementById('btnAutoPerspective')?.addEventListener('click', () => {
    mode = 'select4Point';
    rectCorners = [];
    currentHomography = [1,0,0, 0,1,0, 0,0,1];
    setHomographyMatrix(currentHomography);
    renderCurrentFrame(true);
    document.getElementById('status').innerText = `【4點矩形透視校正】請點選已知長方形的 ${CORNER_NAMES[0]} (1/4)`;
  });

  document.getElementById('btnAutoK1')?.addEventListener('click', () => {
    mode = 'selectK1Line';
    k1LinePoints = [];
    document.getElementById('status').innerText = `【k1 畸變校正】請點擊同一直線上 ${K1_TARGET_POINTS} 個點 (0/${K1_TARGET_POINTS})`;
  });

  document.getElementById('btnAutoPerspective8')?.addEventListener('click', () => {
    mode = 'select8Point';
    perspective8Points = [];
    currentHomography = [1,0,0, 0,1,0, 0,0,1];
    setHomographyMatrix(currentHomography);
    renderCurrentFrame(true);
    document.getElementById('status').innerText = `【直立平面校正】請點選已知垂直地面的 ${LINE8_DESCS[0]}`;
  });

  // 多追蹤點按鈕事件
  document.getElementById('btnTrack').addEventListener('click', () => {
    mode = 'selectTarget';
    document.getElementById('status').innerText = '【新增追蹤點】請直接在畫布上點選欲追蹤的目標中心（可連續點選加入多點）';
  });

  // 合併監聽器：確認後連同幾何狀態與圖表一併清空
  document.getElementById('btnClearTargets')?.addEventListener('click', () => {
    if (confirm('確定要清除所有追蹤點與幾何連線嗎？')) {
      resetTrackState();
      resetGeometryState();
      renderCurrentFrame(true);
      updateTargetListUI();
      updateChartFilterUI();
      clearChart();
      document.getElementById('btnProcess').disabled = true;
      document.getElementById('status').innerText = '已清除所有追蹤目標與幾何標註';
    }
  });

  // 幾何工具按鈕事件
  document.getElementById('btnCreateLine')?.addEventListener('click', () => {
    mode = 'createLine';
    pendingLineP1 = null;
    document.getElementById('status').innerText = '【建立連線】步驟 1：請在畫面上點選「第 1 個追蹤點」';
  });

  document.getElementById('btnCreateAngle')?.addEventListener('click', () => {
    const lines = getAllLines();
    if (lines.length < 2) {
      alert('請先建立至少兩條線段！');
      return;
    }
    mode = 'createAngle';
    pendingAngleLine1 = null;
    document.getElementById('status').innerText = '【建立夾角】步驟 1：請在畫面上點選「第 1 條線」';
  });

  document.getElementById('btnProcess').addEventListener('click', handleTrackButtonAction);
  document.getElementById('btnExport').addEventListener('click', handleExport);

  initPlaybackEvents();

  canvas.addEventListener('mousedown', handleCanvasMouseDown);
  canvas.addEventListener('mousemove', handleCanvasMouseMove);
  canvas.addEventListener('mouseup', handleCanvasMouseUp);
  canvas.addEventListener('click', handleCanvasClick);
};

function findTargetAt(x, y, radius = 16) {
  const targets = getAllTargets();
  for (const t of targets) {
    if (!t.center) continue;
    if (Math.hypot(x - t.center.cx, y - t.center.cy) <= radius) {
      return t;
    }
  }
  return null;
}

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

  timeSlider?.addEventListener('input', async (e) => {
    if (isTracking) pauseAutoTrack();
    const t = parseFloat(e.target.value);
    await seekTo(video, t);
    renderCurrentFrame(true);
    syncAllGizmosToCurrentTime();
    redrawActiveGizmo();
    updateTimelineUI();
  });

  btnPrevFrame?.addEventListener('click', async () => {
    if (isTracking) pauseAutoTrack();
    const newT = Math.max(0, video.currentTime - 1 / 30);
    await seekTo(video, newT);
    renderCurrentFrame(true);
    syncAllGizmosToCurrentTime();
    redrawActiveGizmo();
    updateTimelineUI();
  });

  btnNextFrame?.addEventListener('click', async () => {
    if (isTracking) pauseAutoTrack();
    const newT = Math.min(video.duration || 0, video.currentTime + 1 / 30);
    await seekTo(video, newT);
    renderCurrentFrame(true);
    syncAllGizmosToCurrentTime();
    redrawActiveGizmo();
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
  renderCurrentFrame(true);
  drawAllGizmos(ctx, lostTargetObj ? lostTargetObj.id : null, true);
  drawGeometryGizmos(ctx, getAllTargets(), getPxPerMeter());
}

function handleCanvasMouseDown(e) {
  const { x, y } = getCanvasCoords(e);
  mouseDownPos = { x, y };
  hasMovedDuringDrag = false;

  if (getAllTargets().length > 0 && (!isTracking || mode === 'pausedCorrection')) {
    const hit = hitTestHandles(x, y, canvas.width, canvas.height);
    if (hit) {
      if (hit.type === 'switchTarget') {
        setActiveTargetId(hit.targetId);
        updateTargetListUI();
        redrawActiveGizmo();
        return;
      }
      activeDragMode = hit.type;
      const active = getActiveTarget();
      if (active && active.center) {
        dragOffset = { x: x - active.center.cx, y: y - active.center.cy };
      }
      return;
    }
  }
}

function handleCanvasMouseMove(e) {
  const { x, y } = getCanvasCoords(e);

  if (activeDragMode) {
    if (Math.hypot(x - mouseDownPos.x, y - mouseDownPos.y) > 3) {
      hasMovedDuringDrag = true;
    }

    const active = getActiveTarget();
    if (!active || !active.center) return;
    const { cx, cy } = active.center;

    if (activeDragMode === 'move') {
      const newCx = Math.max(10, Math.min(canvas.width - 10, x - dragOffset.x));
      const newCy = Math.max(10, Math.min(canvas.height - 10, y - dragOffset.y));
      setTargetCenter(newCx, newCy, active.id);
      redrawActiveGizmo();
      document.getElementById('status').innerText = `正在移動目標 [${active.name}] 至: (${Math.round(newCx)}, ${Math.round(newCy)})`;
    } else if (activeDragMode === 'target') {
      const dist = Math.max(Math.abs(x - cx), Math.abs(y - cy));
      pendingTargetSize = Math.max(10, Math.min(dist * 2, active.searchRadius * 2 - 6));
      active.templateSize = pendingTargetSize;
      redrawActiveGizmo();
      document.getElementById('status').innerText = `正在調整 [${active.name}] 尺寸: ${Math.round(pendingTargetSize)} px`;
    } else if (activeDragMode === 'search') {
      const dist = Math.max(Math.abs(x - cx), Math.abs(y - cy));
      const newRadius = Math.max(active.templateSize / 2 + 5, dist);
      setSearchRadius(newRadius);
      redrawActiveGizmo();
      document.getElementById('status').innerText = `已調整 [${active.name}] 搜尋半徑: ${Math.round(newRadius)} px`;
    }
    return;
  }

  // 滑鼠懸浮樣式檢測
  if (getAllTargets().length > 0 && (!isTracking || mode === 'pausedCorrection')) {
    const hit = hitTestHandles(x, y, canvas.width, canvas.height);
    canvas.style.cursor = hit ? hit.cursor : 'default';
  } else {
    canvas.style.cursor = 'default';
  }
}

function handleCanvasMouseUp() {
  if (activeDragMode) {
    const active = getActiveTarget();
    if (active && active.center) {
      renderCurrentFrame(false);
      const finalSize = pendingTargetSize || active.templateSize;
      updateTemplatePatch(ctx, active.center.cx, active.center.cy, finalSize, active.id);
      pendingTargetSize = null;

      if (!isTracking) {
        updateCurrentFrameData(active.id, active.center.cx, active.center.cy);
      }
    }
    activeDragMode = null;
    redrawActiveGizmo();
    return;
  }
}

function handleCanvasClick(e) {
  if (hasMovedDuringDrag) {
    hasMovedDuringDrag = false;
    return;
  }

  const { x, y } = getCanvasCoords(e);
  if (x < 0 || x > canvas.width || y < 0 || y > canvas.height) return;

  if (mode === 'createLine') {
    const hitTarget = findTargetAt(x, y);

    if (!pendingLineP1) {
      if (!hitTarget) {
        document.getElementById('status').innerText = '請先點選一個追蹤點作為起點！';
        return;
      }
      pendingLineP1 = hitTarget;
      document.getElementById('status').innerText = `已選中起點 [${hitTarget.name}]。請點「第二個追蹤點」或「畫布空白處」自動建立鉛直/水平參考線`;
    } else {
      if (hitTarget && hitTarget.id !== pendingLineP1.id) {
        const res = addLine(pendingLineP1, hitTarget);
        document.getElementById('status').innerText = res.message;
      } else if (!hitTarget) {
        const res = addLine(pendingLineP1, null, { x, y });
        document.getElementById('status').innerText = res.message;
      }
      pendingLineP1 = null;
      mode = 'idle';
      redrawActiveGizmo();
    }
    return;
  }

  if (mode === 'createAngle') {
    const targetsMap = {};
    getAllTargets().forEach(t => { targetsMap[t.id] = t; });
    const clickedLine = hitTestLine(x, y, targetsMap);

    if (!pendingAngleLine1) {
      if (!clickedLine) {
        document.getElementById('status').innerText = '未點中線段，請靠近第 1 條線點擊！';
        return;
      }
      pendingAngleLine1 = clickedLine;
      document.getElementById('status').innerText = `已選中 [${clickedLine.name}]，請點選「第 2 條線」`;
      return;
    }

    if (!pendingAngleLine2) {
      if (!clickedLine || clickedLine.id === pendingAngleLine1.id) {
        document.getElementById('status').innerText = '請點選與第 1 條不同的「第 2 條線」！';
        return;
      }
      pendingAngleLine2 = clickedLine;
      document.getElementById('status').innerText = `已選中兩線！請點選「該角欲量測的一側空白處」（小角側或大角側）`;
      return;
    }

    const res = addAngle(pendingAngleLine1, pendingAngleLine2, { x, y }, targetsMap);
    document.getElementById('status').innerText = res.message;

    pendingAngleLine1 = null;
    pendingAngleLine2 = null;
    mode = 'idle';
    updateChartFilterUI();
    redrawActiveGizmo();
    return;
  }

  if (mode === 'pausedCorrection') {
    const active = getActiveTarget();
    if (active) {
      renderCurrentFrame(false);
      updateTemplatePatch(ctx, x, y, active.templateSize, active.id);
      redrawActiveGizmo();
      document.getElementById('status').innerText = `已修正 [${active.name}] 至 (${Math.round(x)}, ${Math.round(y)})，請按「確認修正」繼續`;
    }
    return;
  }

  if (mode === 'calibrate') {
    handleCalibrationClick(x, y);
  } else if (mode === 'selectTarget') {
    handleTargetSelection(x, y);
    updateChartFilterUI();
  } else if (mode === 'select4Point') {
    handle4PointClick(x, y);
  } else if (mode === 'select8Point') {
    handle8PointClick(x, y);
  } else if (mode === 'selectK1Line') {
    handleK1LineClick(x, y);
  }
}

function handle8PointClick(x, y) {
  perspective8Points.push({ x, y });
  const count = perspective8Points.length;

  // 鉛直組使用綠色 (#22c55e)，水平組使用藍色 (#38bdf8)
  const isVerticalGroup = count <= 4;
  const strokeColor = isVerticalGroup ? '#22c55e' : '#38bdf8';

  drawDot(x, y, strokeColor);

  // 兩兩成線時，繪製對應線段並標註類別
  if (count % 2 === 0) {
    const pPrev = perspective8Points[count - 2];
    ctx.save();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pPrev.x, pPrev.y);
    ctx.lineTo(x, y);
    ctx.stroke();

    const tagText = isVerticalGroup ? `鉛直線 ${count / 2}` : `水平線 ${(count - 4) / 2}`;
    ctx.fillStyle = strokeColor;
    ctx.font = '11px monospace';
    ctx.fillText(tagText, (pPrev.x + x) / 2 + 5, (pPrev.y + y) / 2 - 5);
    ctx.restore();
  }

  if (count < 8) {
    document.getElementById('status').innerText = `【直立平面校正】請點選 ${LINE8_DESCS[count]}`;
  } else {
    try {
      const result = calculateHomographyFrom8Points(perspective8Points, canvas.width, canvas.height);
      currentHomography = result.homography;
      setHomographyMatrix(currentHomography);
      renderCurrentFrame(true);
      document.getElementById('status').innerText = '直立平面視角轉正成功！請點擊「尺規定標」標定實體長度。';
    } catch (err) {
      console.error(err);
      alert(`校正計算失敗: ${err.message}`);
      renderCurrentFrame(true);
    }
    mode = 'idle';
    perspective8Points = [];
  }
}

function handleTargetSelection(x, y) {
  renderCurrentFrame(false);
  const newTarget = addTargetPoint(x, y, ctx, 28);
  updateTargetListUI();
  redrawActiveGizmo();

  document.getElementById('status').innerText = `已加入目標 [${newTarget.name}]！可繼續點選新增更多點，或點擊「Step 3」開始追蹤`;
  document.getElementById('btnProcess').disabled = false;
}

// 動態更新側邊欄追蹤點清單 UI
function updateTargetListUI() {
  const container = document.getElementById('targetListContainer');
  if (!container) return;
  container.innerHTML = '';

  const targets = getAllTargets();
  const active = getActiveTarget();

  targets.forEach((t) => {
    const chip = document.createElement('div');
    chip.className = `target-chip ${active && active.id === t.id ? 'active' : ''}`;
    chip.style.borderColor = t.color;

    chip.innerHTML = `
      <span class="chip-color" style="background: ${t.color}"></span>
      <span class="chip-label">${t.name}</span>
      <button class="chip-del" title="刪除此點">&times;</button>
    `;

    chip.addEventListener('click', (e) => {
      if (e.target.classList.contains('chip-del')) {
        e.stopPropagation();
        removeTarget(t.id);
        updateTargetListUI();
        updateChartFilterUI();
        redrawActiveGizmo();
        if (getAllTargets().length === 0) {
          document.getElementById('btnProcess').disabled = true;
        }
        return;
      }
      setActiveTargetId(t.id);
      updateTargetListUI();
      redrawActiveGizmo();
      if (t.trajectory && t.trajectory.length) {
        renderChart(t.trajectory);
      }
    });

    container.appendChild(chip);
  });
}

function handleTrackingFrameUpdate(frameData, allTargets) {
  if (!frameData || !Array.isArray(allTargets)) return;

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

  const active = getActiveTarget();
  if (now - lastUIUpdateTime >= UI_UPDATE_INTERVAL) {
    lastUIUpdateTime = now;
    if (active && frameData.targets[active.id]) {
      updateTrackingUI(frameData.targets[active.id], active.trajectory);
    }
  }

  // 角度資料計算
  const lines = getAllLines();
  const angles = getAllAngles();
  const targetsAtFrame = {};
  allTargets.forEach(t => { targetsAtFrame[t.id] = t; });

  angles.forEach(a => {
    const l1 = lines.find(l => l.id === a.line1Id);
    const l2 = lines.find(l => l.id === a.line2Id);
    if (l1 && l2) {
      const deg = calculateAngleBetweenLines(l1, l2, targetsAtFrame, a);
      a.history.push({ time: parseFloat(frameData.time), deg: deg || 0 });
    }
  });

  // ★ 帶入 currentAngleFilter，只繪製角度
  renderAngleChart(angles, currentAngleFilter);

  // ★ 帶入 currentTargetFilter，只繪製質點，不再衝突
  if (now - lastChartUpdateTime >= CHART_UPDATE_INTERVAL) {
    lastChartUpdateTime = now;
    if (allTargets.length > 0) {
      renderChart(allTargets, currentTargetFilter);
    }
  }
}

function handleVideoUpload(e) {
  const file = e.target ? e.target.files[0] : e;
  if (!file) return;

  isTracking = false;
  isPaused = false;
  mode = 'idle';

  resetCalibration();
  resetTrackState();
  resetZoomPan();
  updateTargetListUI();

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
    document.getElementById('btnProcess').innerText = '3. 啟動多點追蹤';
    document.getElementById('btnExport').disabled = true;

    document.getElementById('status').innerText = '影片載入成功，請定標或點擊「Step 2」新增追蹤點';
    startRenderLoop();
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
      if (getAllTargets().length > 0 && mode === 'idle') {
        redrawActiveGizmo();
      }
    }
    renderLoopId = requestAnimationFrame(renderLoop);
  }
  renderLoopId = requestAnimationFrame(renderLoop);
}

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
  document.getElementById('status').innerText = '已暫停！可手動拖曳目標框微調或切換目標，確認後點擊「繼續追蹤」';
  renderCurrentFrame(true);
  redrawActiveGizmo();
  startRenderLoop();
}

async function startAutoTrack() {
  const targets = getAllTargets();
  if (targets.length === 0) {
    alert('請先點擊「Step 2」在畫面上選取至少一個目標點！');
    return;
  }

  const pxPerMeter = getPxPerMeter();
  const threshold = parseFloat(document.getElementById('matchThreshold')?.value) || 0.55;
  
  // ★ 若影片在結尾，重新追蹤時自動回歸開頭 0 秒
  let currentSeekTime = video.currentTime;
  if (!isPaused && (video.ended || currentSeekTime >= (video.duration - 0.1))) {
    currentSeekTime = 0;
    await seekTo(video, 0);
  }

  // 若接續追蹤，修剪掉當前時間之後的舊數據
  if (isPaused) {
    targets.forEach(t => {
      t.trajectory = t.trajectory.filter(d => parseFloat(d.time) < currentSeekTime - 0.001);
    });
    getAllAngles().forEach(a => {
      a.history = (a.history || []).filter(d => parseFloat(d.time) < currentSeekTime - 0.001);
    });
  } else {
    targets.forEach(t => { t.trajectory = []; });
    getAllAngles().forEach(a => { a.history = []; });
  }

  isTracking = true;
  isPaused = false;
  lostTargetObj = null;

  lastFpsCalcTime = performance.now();
  framesSinceLastCalc = 0;
  const trackStartTime = performance.now();

  const btnProcess = document.getElementById('btnProcess');
  btnProcess.innerText = '⏸ 暫停追蹤';

  document.getElementById('btnCalibrate').disabled = true;
  document.getElementById('btnTrack').disabled = true;
  document.getElementById('btnExport').disabled = true;

  const fpsDisplay = document.getElementById('fpsDisplay');
  if (fpsDisplay) fpsDisplay.innerText = '計算中...';
  document.getElementById('status').innerText = `正在同步追蹤 ${targets.length} 個點...`;

  if (renderLoopId !== null) {
    cancelAnimationFrame(renderLoopId);
    renderLoopId = null;
  }

  try {
    await runAutoTrack({
      video,
      canvas,
      pxPerMeter,
      threshold,
      startTime: currentSeekTime,
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
          lostTargetObj = lostInfo.target;
          resolveTargetCorrection = resolve;
          mode = 'pausedCorrection';
          const lostBar = document.getElementById('lostTargetBar');
          lostBar.style.display = 'flex';
          document.getElementById('lostTargetMsg').innerText = `目標 [${lostInfo.target.name}] 在第 ${lostInfo.frameIdx} 幀特徵遺失！`;
          document.getElementById('status').innerText = `目標 [${lostInfo.target.name}] 吻合度過低 (${lostInfo.score.toFixed(2)})，請於畫面修正點位`;
          renderCurrentFrame(true);
          redrawActiveGizmo();
        });
      }
    });

    const active = getActiveTarget();
    if (active && active.trajectory.length) {
      updateTrackingUI(active.trajectory[active.trajectory.length - 1], active.trajectory);
      // ★ 修復：追蹤完成後直接繪製最新圖表，移除不存在的 now 判斷
      renderChart(getAllTargets(), currentTargetFilter);
      renderAngleChart(getAllAngles(), currentAngleFilter);
      
      const totalElapsedSec = (performance.now() - trackStartTime) / 1000;
      const avgFPS = (active.trajectory.length / totalElapsedSec).toFixed(1);
      if (fpsDisplay) fpsDisplay.innerText = `均速 ${avgFPS} FPS`;
    }

    if (!isPaused) {
      document.getElementById('status').innerText = `全數追蹤完成！共同步完成 ${targets.length} 個軌跡點`;
      btnProcess.innerText = '3. 重新追蹤';
    }
    document.getElementById('btnExport').disabled = false;
  } catch (err) {
    console.error('追蹤發生錯誤:', err);
    document.getElementById('status').innerText = `追蹤中斷：${err?.message || '未知錯誤'}`;
    btnProcess.innerText = '3. 啟動多點追蹤';
  } finally {
    if (!isPaused) {
      isTracking = false;
      document.getElementById('btnCalibrate').disabled = false;
      document.getElementById('btnTrack').disabled = false;
    }
    document.getElementById('lostTargetBar').style.display = 'none';
    lostTargetObj = null;

    renderCurrentFrame(true);
    redrawActiveGizmo();
    startRenderLoop();
  }
}

// 影格時間軸拖曳時，同步將所有目標點位置還原到該幀歷史座標
function syncAllGizmosToCurrentTime() {
  const targets = getAllTargets();
  const curTime = video.currentTime;
  const fps = 30;
  const tolerance = (1 / fps) * 0.7;

  targets.forEach(t => {
    if (!t.trajectory || t.trajectory.length === 0) return;
    let closest = null;
    let minDiff = Infinity;
    for (const pt of t.trajectory) {
      const diff = Math.abs(parseFloat(pt.time) - curTime);
      if (diff < minDiff) {
        minDiff = diff;
        closest = pt;
      }
    }
    if (closest && minDiff <= tolerance) {
      setTargetCenter(closest.cx, closest.cy, t.id);
    }
  });

  const active = getActiveTarget();
  if (active && active.trajectory.length) {
    const activePt = active.trajectory.find(pt => Math.abs(parseFloat(pt.time) - curTime) <= tolerance);
    if (activePt) updateTrackingUI(activePt, active.trajectory);
  }
}

// 手動調整特定目標位置後，覆寫該幀記錄
function updateCurrentFrameData(targetId, cx, cy) {
  const target = getAllTargets().find(t => t.id === targetId);
  if (!target || !target.trajectory || target.trajectory.length === 0) return;

  const curTime = video.currentTime;
  const fps = 30;
  const tolerance = (1 / fps) * 0.7;

  let matchedIdx = -1;
  let minDiff = Infinity;

  for (let i = 0; i < target.trajectory.length; i++) {
    const diff = Math.abs(parseFloat(target.trajectory[i].time) - curTime);
    if (diff < minDiff) {
      minDiff = diff;
      matchedIdx = i;
    }
  }

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

    const item = target.trajectory[matchedIdx];
    item.cx = cx;
    item.cy = cy;
    item.x_px = cx.toFixed(1);
    item.y_px = cy.toFixed(1);
    item.x_m = pxPerMeter ? trans.x_m.toFixed(4) : (cx / (pxPerMeter || 1)).toFixed(4);
    item.y_m = pxPerMeter ? trans.y_m.toFixed(4) : ((canvas.height - cy) / (pxPerMeter || 1)).toFixed(4);
    item.score = "1.000 (手動修正)";

    updateTrackingUI(item, target.trajectory);
    renderChart(target.trajectory);
    document.getElementById('status').innerText = `目標 [${target.name}] 第 ${item.frame} 幀已被手動更新！`;
  }
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
    const active = getActiveTarget();
    const prefix = active ? `[${active.name}] ` : '';
    if (posDisplay && corrected && !isNaN(corrected.x_m) && !isNaN(corrected.y_m)) {
      posDisplay.innerText = `${prefix}X: ${corrected.x_m.toFixed(3)} m | Y: ${corrected.y_m.toFixed(3)} m`;
    }
  } catch (e) {
    console.warn('座標轉換警告:', e);
  }
}

// 導出所有追蹤點的完整遙測資料表
function handleExport() {
  const targets = getAllTargets();
  if (targets.length === 0 || !targets[0].trajectory.length) return;

  const tiltAngle = parseFloat(document.getElementById('tiltAngle')?.value) || 0;
  const calPoints = getCalibrationPoints();
  const origin = calPoints[0] || { x: 0, y: canvas.height };
  const pxPerMeter = getPxPerMeter();
  const hasScale = pxPerMeter > 0;

  const lines = getAllLines();
  const angles = getAllAngles();

  const baseTrajectory = targets[0].trajectory;
  const exportRows = [];

  for (let i = 0; i < baseTrajectory.length; i++) {
    const row = {
      frame: baseTrajectory[i].frame,
      time: baseTrajectory[i].time
    };

    // 1. 各追蹤點座標
    const targetsAtFrame = {};
    targets.forEach((t) => {
      const pt = t.trajectory[i] || {};
      const cx = pt.cx !== undefined ? pt.cx : 0;
      const cy = pt.cy !== undefined ? pt.cy : 0;

      targetsAtFrame[t.id] = { id: t.id, center: { cx, cy } };

      const corrected = transformCoordinates(cx, cy, {
        imageWidth: canvas.width,
        imageHeight: canvas.height,
        tiltAngleDeg: tiltAngle,
        originX: origin.x,
        originY: origin.y,
        isAlreadyRectified: true
      });

      row[`${t.name}_X_m`] = hasScale ? corrected.x_m.toFixed(4) : corrected.x.toFixed(1);
      row[`${t.name}_Y_m`] = hasScale ? corrected.y_m.toFixed(4) : corrected.y.toFixed(1);
      row[`${t.name}_X_px`] = pt.x_px || '0.0';
      row[`${t.name}_Y_px`] = pt.y_px || '0.0';
      row[`${t.name}_Score`] = pt.score || '0.000';
    });

    // 2. ★ 各線段長度 (物理長度 m 或像素 px)
    lines.forEach((l) => {
      const seg = getLineEndpoints(l, targetsAtFrame);
      if (seg) {
        const lenPx = Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
        row[`Line_${l.name}_len_px`] = lenPx.toFixed(1);
        if (hasScale) {
          row[`Line_${l.name}_len_m`] = (lenPx / pxPerMeter).toFixed(4);
        }
      } else {
        row[`Line_${l.name}_len_px`] = '0.0';
      }
    });

    // 3. ★ 各夾角度數 (度 deg, 0° ~ 180°)
    angles.forEach((a) => {
      const l1 = lines.find(l => l.id === a.line1Id);
      const l2 = lines.find(l => l.id === a.line2Id);
      if (l1 && l2) {
        const deg = calculateAngleBetweenLines(l1, l2, targetsAtFrame);
        row[`Angle_${a.name}_deg`] = deg !== null ? deg.toFixed(2) : '0.00';
      } else {
        row[`Angle_${a.name}_deg`] = '0.00';
      }
    });

    exportRows.push(row);
  }

  exportCSV(exportRows);
}

function handleCalibrationClick(x, y) {
  const realLen = parseFloat(document.getElementById('scaleLength').value) || 1.0;
  const result = addCalibrationPoint(x, y, realLen);
  drawDot(x, y, '#ef4444');

  if (result.completed) {
    document.getElementById('scaleDisplay').innerText = `${result.pxPerMeter.toFixed(2)} px/m`;
    document.getElementById('status').innerText = '定標完成！請點選「Step 2」指定追蹤目標';
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
      document.getElementById('status').innerText = '視角轉正成功！請點擊「尺規定標」標定公尺長度。';
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

function drawGrid(ctx, width, height, baseStep = 50, tiltAngleDeg = 0, origin = { x: width / 2, y: height / 2 }) {
  ctx.save();
  ctx.translate(origin.x, origin.y);
  const rad = (tiltAngleDeg * Math.PI) / 180;
  ctx.rotate(rad);

  const maxDim = Math.hypot(width, height) * 2;
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let x = -maxDim; x <= maxDim; x += baseStep) {
    ctx.moveTo(x, -maxDim); ctx.lineTo(x, maxDim);
  }
  for (let y = -maxDim; y <= maxDim; y += baseStep) {
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

// 動態更新圖表切換按鈕清單
export function updateChartFilterUI() {
  const container = document.getElementById('chartFilterPills');
  if (!container) return;

  const targets = getAllTargets();
  const angles = getAllAngles();

  let html = `
    <!-- 質點分組 -->
    <div class="filter-cluster">
      <span class="cluster-label">質點 (X/Y):</span>
      <button class="pill-btn ${currentTargetFilter === 'all' ? 'active' : ''}" data-cluster="target" data-id="all">
        <span class="pill-badge-all">ALL</span> 全部疊加
      </button>
  `;

  targets.forEach(t => {
    const isActive = (currentTargetFilter === t.id);
    html += `
      <button class="pill-btn ${isActive ? 'active' : ''}" data-cluster="target" data-id="${t.id}">
        <span class="chip-color" style="background: ${t.color}"></span>
        ${t.name}
      </button>
    `;
  });
  html += `</div>`;

  // 若有建立夾角，顯示夾角分組
  if (angles.length > 0) {
    html += `
      <div class="filter-divider"></div>
      <div class="filter-cluster">
        <span class="cluster-label">夾角 (θ):</span>
        <button class="pill-btn ${currentAngleFilter === 'all' ? 'active' : ''}" data-cluster="angle" data-id="all">
          <span class="pill-badge-angle">ALL</span> 全部疊加
        </button>
    `;

    angles.forEach(a => {
      const isActive = (currentAngleFilter === a.id);
      html += `
        <button class="pill-btn ${isActive ? 'active' : ''}" data-cluster="angle" data-id="${a.id}" style="border-color: ${a.color || '#a855f7'}">
          <span class="chip-color" style="background: ${a.color || '#a855f7'}"></span>
          <span class="pill-badge-angle">θ</span>
          <span>${a.name}</span>
        </button>
      `;
    });
    html += `</div>`;
  }

  container.innerHTML = html;

  // 綁定獨立分組切換
  container.querySelectorAll('.pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cluster = btn.getAttribute('data-cluster');
      const id = btn.getAttribute('data-id');

      if (cluster === 'target') {
        currentTargetFilter = id;
        updateChartFilterUI();
        renderChart(getAllTargets(), currentTargetFilter);
      } else if (cluster === 'angle') {
        currentAngleFilter = id;
        updateChartFilterUI();
        renderAngleChart(getAllAngles(), currentAngleFilter);
      }
    });
  });
}