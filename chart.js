// chart.js：多目標運動學示波器繪製引擎 (解耦質點與夾角獨立通道)

let canvasX = null, ctxX = null;
let canvasY = null, ctxY = null;
let canvasAngle = null, ctxAngle = null;

const PX_PER_POINT = 14;

export function initChart(elX, elY, elAngle = null) {
  canvasX = elX;
  ctxX = canvasX.getContext('2d');
  canvasY = elY;
  ctxY = canvasY.getContext('2d');
  if (elAngle) {
    canvasAngle = elAngle;
    ctxAngle = canvasAngle.getContext('2d');
  }
  resizeChart();
}

export function resizeChart() {
  clearChart();
}

/** 僅清空 XY 位置圖 */
export function clearPositionCharts() {
  const charts = [
    { canvas: canvasX, ctx: ctxX, title: 'CH-1: X-DISPLACEMENT (m)', color: '#38bdf8' },
    { canvas: canvasY, ctx: ctxY, title: 'CH-2: Y-DISPLACEMENT (m)', color: '#f87171' }
  ];
  charts.forEach(item => {
    if (!item.ctx) return;
    const parent = item.canvas.parentElement;
    const w = parent ? (parent.clientWidth || 300) : 300;
    const h = parent ? (parent.clientHeight || 180) : 180;
    item.canvas.width = w;
    item.canvas.height = h;
    drawFrameBackground(item.ctx, w, h, item.title, item.color);
  });
}

/** 僅清空角度圖 */
export function clearAngleChart() {
  if (!canvasAngle || !ctxAngle) return;
  const parent = canvasAngle.parentElement;
  const w = parent ? (parent.clientWidth || 300) : 300;
  const h = parent ? (parent.clientHeight || 180) : 180;
  canvasAngle.width = w;
  canvasAngle.height = h;
  drawFrameBackground(ctxAngle, w, h, 'CH-3: ANGLE θ (deg)', '#a855f7');
}

/** 全清 */
export function clearChart() {
  clearPositionCharts();
  clearAngleChart();
}

/** 繪製背景網格與圖例 */
function drawFrameBackground(ctx, w, h, title, defaultColor, minV = null, maxV = null, maxT = null, activeSeries = []) {
  const padLeft = 45, padRight = 25, padTop = 24, padBottom = 22;
  const plotW = Math.max(10, w - padLeft - padRight);
  const plotH = Math.max(10, h - padTop - padBottom);

  ctx.fillStyle = '#090d12';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#18202c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const vSteps = 4;
  for (let i = 0; i <= vSteps; i++) {
    const y = padTop + (plotH / vSteps) * i;
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
  }
  const hSteps = Math.max(2, Math.floor(plotW / 80));
  for (let i = 0; i <= hSteps; i++) {
    const x = padLeft + (plotW / hSteps) * i;
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + plotH);
  }
  ctx.stroke();

  ctx.strokeStyle = '#272f38';
  ctx.strokeRect(padLeft, padTop, plotW, plotH);

  ctx.fillStyle = defaultColor;
  ctx.font = 'bold 10px "JetBrains Mono", Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, padLeft + 6, padTop - 12);

  if (activeSeries && activeSeries.length > 0) {
    let legendX = padLeft + plotW;
    ctx.font = '9px "JetBrains Mono", Consolas, monospace';
    ctx.textBaseline = 'middle';

    for (let i = activeSeries.length - 1; i >= 0; i--) {
      const s = activeSeries[i];
      const textWidth = ctx.measureText(s.name).width;
      legendX -= (textWidth + 16);

      ctx.beginPath();
      ctx.arc(legendX + 4, padTop - 12, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = s.color || defaultColor;
      ctx.fill();

      ctx.fillStyle = '#cbd5e1';
      ctx.textAlign = 'left';
      ctx.fillText(s.name, legendX + 11, padTop - 12);
    }
  }

  ctx.fillStyle = '#6e7681';
  ctx.font = '9px "JetBrains Mono", Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  if (minV !== null && maxV !== null) {
    ctx.fillText(maxV.toFixed(2), padLeft - 6, padTop);
    ctx.fillText(((minV + maxV) / 2).toFixed(2), padLeft - 6, padTop + plotH / 2);
    ctx.fillText(minV.toFixed(2), padLeft - 6, padTop + plotH);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('0.0s', padLeft, padTop + plotH + 5);
  if (maxT !== null) {
    ctx.textAlign = 'right';
    ctx.fillText(`${maxT.toFixed(2)}s`, padLeft + plotW, padTop + plotH + 5);
  }
}

function getMinMax(arr) {
  let min = arr[0], max = arr[0];
  for (let i = 1; i < arr.length; i++) {
    const v = arr[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** 繪製質點 X / Y 圖（只操作 canvasX 與 canvasY） */
export function renderChart(targetsData, filterTargetId = 'all') {
  if (!ctxX || !ctxY || !targetsData) return;

  let seriesList = [];
  if (Array.isArray(targetsData) && targetsData.length > 0) {
    if (filterTargetId === 'all') {
      seriesList = targetsData.filter(t => t.trajectory && t.trajectory.length > 0);
    } else {
      seriesList = targetsData.filter(t => t.id === filterTargetId && t.trajectory && t.trajectory.length > 0);
    }
  }

  if (seriesList.length === 0) {
    clearPositionCharts(); // ★ 關鍵：只清空位置圖，絕不碰角度圖！
    return;
  }

  let globalMaxT = 0.5;
  let maxPointsCount = 0;
  let globalMinX = Infinity, globalMaxX = -Infinity;
  let globalMinY = Infinity, globalMaxY = -Infinity;

  seriesList.forEach(s => {
    const traj = s.trajectory;
    if (traj.length > maxPointsCount) maxPointsCount = traj.length;

    const times = traj.map(d => parseFloat(d.time));
    const xVals = traj.map(d => parseFloat(d.x_m));
    const yVals = traj.map(d => parseFloat(d.y_m));

    const tMM = getMinMax(times);
    if (tMM.max > globalMaxT) globalMaxT = tMM.max;

    const xMM = getMinMax(xVals);
    if (xMM.min < globalMinX) globalMinX = xMM.min;
    if (xMM.max > globalMaxX) globalMaxX = xMM.max;

    const yMM = getMinMax(yVals);
    if (yMM.min < globalMinY) globalMinY = yMM.min;
    if (yMM.max > globalMaxY) globalMaxY = yMM.max;
  });

  renderMultiSeriesGraph(canvasX, ctxX, 'x_m', 'CH-1: X-DISPLACEMENT (m)', '#38bdf8', globalMinX, globalMaxX, seriesList, globalMaxT, maxPointsCount, filterTargetId);
  renderMultiSeriesGraph(canvasY, ctxY, 'y_m', 'CH-2: Y-DISPLACEMENT (m)', '#f87171', globalMinY, globalMaxY, seriesList, globalMaxT, maxPointsCount, filterTargetId);
}

/** 繪製角度 θ 圖（只操作 canvasAngle） */
export function renderAngleChart(anglesList, filterAngleId = 'all') {
  if (!canvasAngle || !ctxAngle || !anglesList || anglesList.length === 0) {
    clearAngleChart();
    return;
  }

  let validAngles = anglesList.filter(a => a.history && a.history.length > 0);
  if (filterAngleId !== 'all') {
    validAngles = validAngles.filter(a => a.id === filterAngleId);
  }

  if (validAngles.length === 0) {
    clearAngleChart(); // ★ 關鍵：只清空角度圖，絕不碰位置圖！
    return;
  }

  let maxPointsCount = 0;
  let globalMaxT = 0.5;
  let minDeg = Infinity;
  let maxDeg = -Infinity;

  const seriesList = validAngles.map(a => {
    const traj = a.history.map(h => ({ time: h.time, val: h.deg }));
    if (traj.length > maxPointsCount) maxPointsCount = traj.length;
    traj.forEach(pt => {
      const t = parseFloat(pt.time);
      if (t > globalMaxT) globalMaxT = t;
      if (pt.val < minDeg) minDeg = pt.val;
      if (pt.val > maxDeg) maxDeg = pt.val;
    });
    return {
      id: a.id,
      name: a.name,
      color: a.color || '#a855f7',
      trajectory: traj
    };
  });

  if (!isFinite(minDeg) || !isFinite(maxDeg)) {
    minDeg = 0;
    maxDeg = 180;
  }

  renderMultiSeriesGraph(canvasAngle, ctxAngle, 'val', 'CH-3: ANGLE θ (deg)', '#a855f7', minDeg, maxDeg, seriesList, globalMaxT, maxPointsCount, filterAngleId);
}

function renderMultiSeriesGraph(canvas, ctx, axisKey, title, defaultColor, valMin, valMax, seriesList, globalMaxT, maxPointsCount, currentFilter) {
  const padLeft = 45, padRight = 25, padTop = 24, padBottom = 22;
  const parent = canvas.parentElement;
  const minW = parent ? (parent.clientWidth || 300) : 300;
  
  const targetW = Math.max(minW, padLeft + padRight + maxPointsCount * PX_PER_POINT);
  const targetH = parent ? (parent.clientHeight || 180) : 180;

  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const plotW = canvas.width - padLeft - padRight;
  const plotH = canvas.height - padTop - padBottom;

  let minV = valMin;
  let maxV = valMax;
  if (minV === maxV || !isFinite(minV) || !isFinite(maxV)) { minV = -1; maxV = 1; }
  const margin = (maxV - minV) * 0.12 || 0.05;
  minV -= margin;
  maxV += margin;

  drawFrameBackground(ctx, canvas.width, canvas.height, title, defaultColor, minV, maxV, globalMaxT, seriesList);

  const rangeT = globalMaxT || 1;
  const rangeV = maxV - minV || 1;
  const mapX = (t) => padLeft + (t / rangeT) * plotW;
  const mapY = (val) => padTop + plotH - ((val - minV) / rangeV) * plotH;

  seriesList.forEach(series => {
    const traj = series.trajectory;
    if (traj.length === 0) return;

    const curveColor = (currentFilter === 'all') ? series.color : defaultColor;

    ctx.strokeStyle = curveColor;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < traj.length; i++) {
      const px = mapX(parseFloat(traj[i].time));
      const py = mapY(parseFloat(traj[i][axisKey]));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    ctx.fillStyle = curveColor;
    const step = traj.length > 250 ? Math.ceil(traj.length / 250) : 1;
    for (let i = 0; i < traj.length; i += step) {
      const px = mapX(parseFloat(traj[i].time));
      const py = mapY(parseFloat(traj[i][axisKey]));
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    const last = traj[traj.length - 1];
    const lx = mapX(parseFloat(last.time));
    const ly = mapY(parseFloat(last[axisKey]));
    ctx.beginPath();
    ctx.arc(lx, ly, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = curveColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  if (parent) {
    parent.scrollLeft = parent.scrollWidth;
  }
}