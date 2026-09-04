// chart.js：負責 X/Y 位移-時間折線圖的繪製 (工程示波器風格)

let canvasX = null, ctxX = null;
let canvasY = null, ctxY = null;

// 每個資料點在圖表上的最小水平像素距離（支援長時序橫向捲動）
const PX_PER_POINT = 14;

/**
 * 初始化圖表 Canvas 元素
 */
export function initChart(elX, elY) {
  canvasX = elX;
  ctxX = canvasX.getContext('2d');
  canvasY = elY;
  ctxY = canvasY.getContext('2d');
  resizeChart();
}

/**
 * 響應視窗大小變更
 */
export function resizeChart() {
  if (!canvasX || !canvasY) return;
  clearChart();
}

/**
 * 清除並重繪初始空軸線
 */
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
 * 繪製示波器背景底網格與刻度框
 */
function drawFrameBackground(ctx, w, h, title, color, minV = null, maxV = null, maxT = null) {
  const padLeft = 45, padRight = 25, padTop = 22, padBottom = 22;
  const plotW = Math.max(10, w - padLeft - padRight);
  const plotH = Math.max(10, h - padTop - padBottom);

  // 1. 底色
  ctx.fillStyle = '#090d12';
  ctx.fillRect(0, 0, w, h);

  // 2. 示波器輕量背景網格 (Grid)
  ctx.strokeStyle = '#18202c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const vSteps = 4; // 垂直 4 格
  for (let i = 0; i <= vSteps; i++) {
    const y = padTop + (plotH / vSteps) * i;
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
  }
  const hSteps = Math.max(2, Math.floor(plotW / 80)); // 每 80px 一格時間線
  for (let i = 0; i <= hSteps; i++) {
    const x = padLeft + (plotW / hSteps) * i;
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + plotH);
  }
  ctx.stroke();

  // 3. 繪圖區外框
  ctx.strokeStyle = '#272f38';
  ctx.strokeRect(padLeft, padTop, plotW, plotH);

  // 4. 左上角通道標題
  ctx.fillStyle = color;
  ctx.font = '10px "JetBrains Mono", Consolas, monospace';
  ctx.fillText(title, padLeft + 6, padTop + 14);

  // 5. 繪製刻度數值 (數值範圍有效時)
  ctx.fillStyle = '#6e7681';
  ctx.font = '9px "JetBrains Mono", Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  if (minV !== null && maxV !== null) {
    ctx.fillText(maxV.toFixed(2), padLeft - 6, padTop);
    ctx.fillText(((minV + maxV) / 2).toFixed(2), padLeft - 6, padTop + plotH / 2);
    ctx.fillText(minV.toFixed(2), padLeft - 6, padTop + plotH);
  }

  // 時間軸標記
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
 * 渲染追蹤資料
 */
export function renderChart(trackingData) {
  if (!ctxX || !ctxY || !trackingData || trackingData.length === 0) return;

  const times = trackingData.map(d => parseFloat(d.time));
  const xVals = trackingData.map(d => parseFloat(d.x_m));
  const yVals = trackingData.map(d => parseFloat(d.y_m));

  const padLeft = 45, padRight = 25, padTop = 22, padBottom = 22;

  const renderSingleGraph = (canvas, ctx, values, title, color) => {
    const parent = canvas.parentElement;
    const minW = parent.clientWidth || 300;
    
    // 依據資料量動態拓展寬度 (保留示波器時間滾動能力)
    const targetW = Math.max(minW, padLeft + padRight + trackingData.length * PX_PER_POINT);
    const targetH = parent.clientHeight || 180;

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const plotW = canvas.width - padLeft - padRight;
    const plotH = canvas.height - padTop - padBottom;

    const minT = 0;
    const { max: maxT_raw } = getMinMax(times);
    const maxT = Math.max(maxT_raw || 0, 0.5);

    let { min: minV, max: maxV } = getMinMax(values);
    if (minV === maxV) { minV -= 0.5; maxV += 0.5; }
    const margin = (maxV - minV) * 0.12 || 0.05;
    minV -= margin;
    maxV += margin;

    // 繪製背景與網格刻度
    drawFrameBackground(ctx, canvas.width, canvas.height, title, color, minV, maxV, maxT);

    // 精確座標映射 (完全鎖在 plotW 與 plotH 邊界內)
    const rangeT = maxT - minT || 1;
    const rangeV = maxV - minV || 1;
    const mapX = (t) => padLeft + ((t - minT) / rangeT) * plotW;
    const mapY = (val) => padTop + plotH - ((val - minV) / rangeV) * plotH;

    // 1. 折線繪製
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < times.length; i++) {
      const px = mapX(times[i]);
      const py = mapY(values[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // 2. 數據點繪製 (超過 300 點降採樣，維護流暢度)
    ctx.fillStyle = color;
    const step = times.length > 300 ? Math.ceil(times.length / 300) : 1;
    for (let i = 0; i < times.length; i += step) {
      const px = mapX(times[i]);
      const py = mapY(values[i]);
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    // 必繪製最後一個最新錨點（空心外光暈）
    if (times.length > 0) {
      const lastIdx = times.length - 1;
      const px = mapX(times[lastIdx]);
      const py = mapY(values[lastIdx]);
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // 自動滾動至最右側最新時間點
    parent.scrollLeft = parent.scrollWidth;
  };

  renderSingleGraph(canvasX, ctxX, xVals, 'CH-1: X-DISPLACEMENT (m)', '#38bdf8');
  renderSingleGraph(canvasY, ctxY, yVals, 'CH-2: Y-DISPLACEMENT (m)', '#f87171');
}