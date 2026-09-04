// chart.js：多目標運動學示波器繪製引擎 (支援多軌同圖疊加與單一目標過濾)

let canvasX = null, ctxX = null;
let canvasY = null, ctxY = null;

// 每個資料點在圖表上的最小水平像素距離（支援長時序橫向捲動）
const PX_PER_POINT = 14;

export function initChart(elX, elY) {
  canvasX = elX;
  ctxX = canvasX.getContext('2d');
  canvasY = elY;
  ctxY = canvasY.getContext('2d');
  resizeChart();
}

export function resizeChart() {
  if (!canvasX || !canvasY) return;
  clearChart();
}

export function clearChart() {
  const charts = [
    { canvas: canvasX, ctx: ctxX, title: 'CH-1: X-DISPLACEMENT (m)', color: '#38bdf8' },
    { canvas: canvasY, ctx: ctxY, title: 'CH-2: Y-DISPLACEMENT (m)', color: '#f87171' }
  ];

  charts.forEach(item => {
    if (!item.ctx) return;
    const parent = item.canvas.parentElement;
    const w = parent.clientWidth || 300;
    const h = parent.clientHeight || 180;
    
    item.canvas.width = w;
    item.canvas.height = h;

    drawFrameBackground(item.ctx, w, h, item.title, item.color);
  });
}

/**
 * 繪製示波器背景網格、軸刻度與多目標色票圖例 (Legends)
 */
function drawFrameBackground(ctx, w, h, title, defaultColor, minV = null, maxV = null, maxT = null, activeSeries = []) {
  const padLeft = 45, padRight = 25, padTop = 24, padBottom = 22;
  const plotW = Math.max(10, w - padLeft - padRight);
  const plotH = Math.max(10, h - padTop - padBottom);

  // 1. 底色
  ctx.fillStyle = '#090d12';
  ctx.fillRect(0, 0, w, h);

  // 2. 示波器輕量背景網格
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

  // 3. 繪圖區外框
  ctx.strokeStyle = '#272f38';
  ctx.strokeRect(padLeft, padTop, plotW, plotH);

  // 4. 通道標題
  ctx.fillStyle = defaultColor;
  ctx.font = 'bold 10px "JetBrains Mono", Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, padLeft + 6, padTop - 12);

  // 4-1. 右上方繪製多目標色票圖例 (Legend)
  if (activeSeries && activeSeries.length > 0) {
    let legendX = padLeft + plotW;
    ctx.font = '9px "JetBrains Mono", Consolas, monospace';
    ctx.textBaseline = 'middle';

    for (let i = activeSeries.length - 1; i >= 0; i--) {
      const s = activeSeries[i];
      const textWidth = ctx.measureText(s.name).width;
      legendX -= (textWidth + 16);

      // 色點
      ctx.beginPath();
      ctx.arc(legendX + 4, padTop - 12, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();

      // 文字
      ctx.fillStyle = '#cbd5e1';
      ctx.textAlign = 'left';
      ctx.fillText(s.name, legendX + 11, padTop - 12);
    }
  }

  // 5. 繪製數值刻度 (Y 軸)
  ctx.fillStyle = '#6e7681';
  ctx.font = '9px "JetBrains Mono", Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  if (minV !== null && maxV !== null) {
    ctx.fillText(maxV.toFixed(2), padLeft - 6, padTop);
    ctx.fillText(((minV + maxV) / 2).toFixed(2), padLeft - 6, padTop + plotH / 2);
    ctx.fillText(minV.toFixed(2), padLeft - 6, padTop + plotH);
  }

  // 時間軸標記 (X 軸)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('0.0s', padLeft, padTop + plotH + 5);
  if (maxT !== null) {
    ctx.textAlign = 'right';
    ctx.fillText(`${maxT.toFixed(2)}s`, padLeft + plotW, padTop + plotH + 5);
  }
}

/**
 * 手動求極值避免呼叫棧溢位
 */
function getMinMax(arr) {
  let min = arr[0], max = arr[0];
  for (let i = 1; i < arr.length; i++) {
    const v = arr[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/**
 * 渲染多目標追蹤資料
 * @param {Array} targetsData - 包含所有目標物件的陣列 [ { id, name, color, trajectory } ] 或舊版單點軌跡
 * @param {string} filterTargetId - 篩選顯示模式: 'all' (全部疊加) 或 特定目標的 id
 */
export function renderChart(targetsData, filterTargetId = 'all') {
  if (!ctxX || !ctxY || !targetsData) return;

  // 兼顧舊版單一 target trajectory 陣列傳入
  let seriesList = [];
  if (Array.isArray(targetsData) && targetsData.length > 0) {
    if (targetsData[0].trajectory !== undefined) {
      // 多目標物件結構
      if (filterTargetId === 'all') {
        seriesList = targetsData.filter(t => t.trajectory && t.trajectory.length > 0);
      } else {
        seriesList = targetsData.filter(t => t.id === filterTargetId && t.trajectory && t.trajectory.length > 0);
      }
    } else if (targetsData[0].time !== undefined) {
      // 傳統單點 flat trajectory
      seriesList = [{
        id: 'default',
        name: 'P1',
        color: '#38bdf8',
        trajectory: targetsData
      }];
    }
  }

  if (seriesList.length === 0) {
    clearChart();
    return;
  }

  // 1. 計算所有顯示系列中的全域邊界（讓同圖內的曲線在同一物理坐標尺規下對齊）
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

  const padLeft = 45, padRight = 25, padTop = 24, padBottom = 22;

  // 2. 單一軸圖表渲染閉包函式
  const renderMultiSeriesGraph = (canvas, ctx, axisKey, title, defaultColor, valMin, valMax) => {
    const parent = canvas.parentElement;
    const minW = parent.clientWidth || 300;
    
    // 依長時序長度擴展寬度 (支援橫向捲動)
    const targetW = Math.max(minW, padLeft + padRight + maxPointsCount * PX_PER_POINT);
    const targetH = parent.clientHeight || 180;

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

    // 繪製背景、標題刻度與色票
    drawFrameBackground(ctx, canvas.width, canvas.height, title, defaultColor, minV, maxV, globalMaxT, seriesList);

    const rangeT = globalMaxT || 1;
    const rangeV = maxV - minV || 1;
    const mapX = (t) => padLeft + (t / rangeT) * plotW;
    const mapY = (val) => padTop + plotH - ((val - minV) / rangeV) * plotH;

    // 逐一繪製每個目標的軌跡曲線
    seriesList.forEach(series => {
      const traj = series.trajectory;
      if (traj.length === 0) return;

      const curveColor = (filterTargetId === 'all') ? series.color : defaultColor;

      // 折線
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

      // 數據點 (降採樣保證 60FPS)
      ctx.fillStyle = curveColor;
      const step = traj.length > 250 ? Math.ceil(traj.length / 250) : 1;
      for (let i = 0; i < traj.length; i += step) {
        const px = mapX(parseFloat(traj[i].time));
        const py = mapY(parseFloat(traj[i][axisKey]));
        ctx.beginPath();
        ctx.arc(px, py, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // 最新時間點外光暈實心錨點
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

    // 自動捲動到最右端最新時間點
    parent.scrollLeft = parent.scrollWidth;
  };

  renderMultiSeriesGraph(canvasX, ctxX, 'x_m', 'CH-1: X-DISPLACEMENT (m)', '#38bdf8', globalMinX, globalMaxX);
  renderMultiSeriesGraph(canvasY, ctxY, 'y_m', 'CH-2: Y-DISPLACEMENT (m)', '#f87171', globalMinY, globalMaxY);
}