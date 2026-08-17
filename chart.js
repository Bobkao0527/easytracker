// 圖表模組：負責 X/Y 位移-時間折線圖的繪製

let canvasX = null, ctxX = null;
let canvasY = null, ctxY = null;

// 每個資料點在圖表上的最小水平像素距離，避免長影片擠在一起
const PX_PER_POINT = 12;

/**
 * 初始化圖表 Canvas 元素
 * @param {HTMLCanvasElement} elX - X 位移圖表 canvas
 * @param {HTMLCanvasElement} elY - Y 位移圖表 canvas
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
 * 清除並重繪圖表軸線
 */
export function clearChart() {
  const charts = [
    { canvas: canvasX, ctx: ctxX, title: 'X 位移 (m)', color: '#06b6d4' },
    { canvas: canvasY, ctx: ctxY, title: 'Y 位移 (m)', color: '#22c55e' }
  ];

  charts.forEach(item => {
    if (!item.ctx) return;
    const parent = item.canvas.parentElement;
    item.canvas.width = parent.clientWidth || 400;
    item.canvas.height = parent.clientHeight || 250;
    item.ctx.fillStyle = '#090d16';
    item.ctx.fillRect(0, 0, item.canvas.width, item.canvas.height);
    drawAxes(item.ctx, item.canvas.width, item.canvas.height, item.title, item.color);
  });
}

/**
 * 繪製圖表軸線與標題
 */
function drawAxes(ctx, w, h, title, color) {
  const padding = 40;
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.strokeRect(padding, padding / 2, w - padding * 1.5, h - padding * 1.5);

  ctx.fillStyle = color;
  ctx.font = '12px sans-serif';
  ctx.fillText(title, padding + 10, 20);

  ctx.fillStyle = '#64748b';
  ctx.font = '11px sans-serif';
  ctx.fillText('Time (s)', w - 60, h - 10);
}

/**
 * 手動迴圈求最值，避免 Math.max(...bigArray) 的 stack overflow
 * @param {number[]} arr
 * @returns {{ min: number, max: number }}
 */
function getMinMax(arr) {
  let min = arr[0];
  let max = arr[0];
  for (let i = 1; i < arr.length; i++) {
    const v = arr[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/**
 * 渲染圖表資料
 * @param {Array} trackingData - 追蹤資料陣列
 */
export function renderChart(trackingData) {
  if (!ctxX || !ctxY || trackingData.length === 0) return;

  const times = trackingData.map(d => parseFloat(d.time));
  const xVals = trackingData.map(d => parseFloat(d.x_m));
  const yVals = trackingData.map(d => parseFloat(d.y_m));

  const padding = 40;

  const renderSingleGraph = (canvas, ctx, values, title, color) => {
    const parent = canvas.parentElement;
    const minW = parent.clientWidth || 400;
    const targetW = Math.max(minW, padding * 2 + trackingData.length * PX_PER_POINT);
    const targetH = parent.clientHeight || 250;

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const w = canvas.width - padding * 1.5;
    const h = canvas.height - padding * 1.5;

    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawAxes(ctx, canvas.width, canvas.height, title, color);

    const minT = 0;
    const { max: maxT_raw } = getMinMax(times);
    const maxT = maxT_raw || 1;

    let { min: minV, max: maxV } = getMinMax(values);
    if (minV === maxV) { minV -= 0.5; maxV += 0.5; }
    const margin = (maxV - minV) * 0.1 || 0.1;
    minV -= margin;
    maxV += margin;

    const rangeT = maxT - minT || 1;
    const rangeV = maxV - minV;
    const mapX = (t) => padding + ((t - minT) / rangeT) * w;
    const mapY = (val) => (padding / 2) + h - ((val - minV) / rangeV) * h;

    // 繪製折線
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < times.length; i++) {
      const px = mapX(times[i]);
      const py = mapY(values[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // 繪製資料點（資料量大時跳過部分點以保持效能）
    ctx.fillStyle = color;
    const step = times.length > 500 ? Math.ceil(times.length / 500) : 1;
    for (let i = 0; i < times.length; i += step) {
      const px = mapX(times[i]);
      const py = mapY(values[i]);
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // 確保最後一個點永遠被繪製
    if (step > 1 && times.length > 0) {
      const lastIdx = times.length - 1;
      const px = mapX(times[lastIdx]);
      const py = mapY(values[lastIdx]);
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 當資料超長時，自動向右滾動追蹤最新資料
    parent.scrollLeft = parent.scrollWidth;
  };

  renderSingleGraph(canvasX, ctxX, xVals, 'X 位移 (m)', '#06b6d4');
  renderSingleGraph(canvasY, ctxY, yVals, 'Y 位移 (m)', '#22c55e');
}