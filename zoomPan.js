// zoomPan.js：支援動態錨點 (游標/雙指中心/畫面中心) 的縮放與平移模組

let zoomLevel = 1.0;
let panX = 0;
let panY = 0;

// 觸控螢幕 (Touchscreen) 雙指狀態
let initialTouchDist = 0;
let initialZoom = 1.0;
let initialTouchCenterContent = { x: 0, y: 0 }; // 雙指中心在 Canvas 內容空間的座標

// Safari Gesture 狀態
let initialGestureZoom = 1.0;
let gestureCenter = { x: 0, y: 0 };

export function initZoomPan(canvas) {
  const container = canvas.parentElement;
  if (!container) return;

  container.style.overflow = 'hidden';
  container.style.position = 'relative';
  canvas.style.transformOrigin = '0 0';

  // ==========================================
  // 1. 筆電觸控板 (Trackpad) 與滾輪事件處理
  // ==========================================
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (e.ctrlKey) {
      // 觸控板雙指捏合 (Pinch-to-zoom)：以游標為中心縮放
      const zoomFactor = Math.pow(1.005, -e.deltaY);
      zoomTo(zoomLevel * zoomFactor, mouseX, mouseY);
    } else {
      // 觸控板雙指平移 (Two-finger Pan)
      panX -= e.deltaX;
      panY -= e.deltaY;
      applyTransform(canvas);
    }
  }, { passive: false });

  // ==========================================
  // 2. Safari 專用縮放手勢 (gesturechange)
  // ==========================================
  container.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    initialGestureZoom = zoomLevel;
    gestureCenter = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  });

  container.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    zoomTo(initialGestureZoom * e.scale, gestureCenter.x, gestureCenter.y);
  });

  // ==========================================
  // 3. 行動裝置觸控螢幕 (Touchscreen) 雙指縮放與平移
  // ==========================================
  container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const t1 = e.touches[0];
      const t2 = e.touches[1];

      // 計算雙指中心點 (容器空間)
      const centerContainerX = ((t1.clientX + t2.clientX) / 2) - rect.left;
      const centerContainerY = ((t1.clientY + t2.clientY) / 2) - rect.top;

      initialTouchDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      initialZoom = zoomLevel;

      // 紀錄起始時雙指中心相對 Canvas 內容的空間座標
      initialTouchCenterContent = {
        x: (centerContainerX - panX) / initialZoom,
        y: (centerContainerY - panY) / initialZoom
      };
    }
  }, { passive: false });

  container.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const t1 = e.touches[0];
      const t2 = e.touches[1];

      // 計算當前雙指中心點與距離
      const currentCenterX = ((t1.clientX + t2.clientX) / 2) - rect.left;
      const currentCenterY = ((t1.clientY + t2.clientY) / 2) - rect.top;
      const currentDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

      if (initialTouchDist > 0) {
        // 計算新縮放比例
        const factor = currentDist / initialTouchDist;
        zoomLevel = Math.max(0.5, Math.min(5.0, initialZoom * factor));

        // 同時更新 panX / panY，讓內容保持固定在雙指中心
        panX = currentCenterX - initialTouchCenterContent.x * zoomLevel;
        panY = currentCenterY - initialTouchCenterContent.y * zoomLevel;

        applyTransform(canvas);
      }
    }
  }, { passive: false });
}

// ==========================================
// 核心縮放演算法：以 (pivotX, pivotY) 為原點縮放
// ==========================================
export function zoomTo(targetZoom, pivotX, pivotY) {
  const canvas = document.getElementById('canvasOutput');
  if (!canvas) return;

  const container = canvas.parentElement;
  
  // 若未指定中心點，預設使用容器視窗中心
  if (pivotX === undefined || pivotY === undefined) {
    pivotX = container ? container.clientWidth / 2 : 0;
    pivotY = container ? container.clientHeight / 2 : 0;
  }

  const oldZoom = zoomLevel;
  const newZoom = Math.max(0.5, Math.min(5.0, targetZoom));
  if (newZoom === oldZoom) return;

  // 計算錨點偏移：確保 (pivotX, pivotY) 在縮放前後對應的 Canvas 內部點不變
  const scaleRatio = newZoom / oldZoom;
  panX = pivotX - (pivotX - panX) * scaleRatio;
  panY = pivotY - (pivotY - panY) * scaleRatio;
  zoomLevel = newZoom;

  applyTransform(canvas);
}

export function setZoom(level, pivotX, pivotY) {
  zoomTo(level, pivotX, pivotY);
  return zoomLevel;
}

export function resetZoomPan() {
  zoomLevel = 1.0;
  panX = 0;
  panY = 0;
  const canvas = document.getElementById('canvasOutput');
  if (canvas) applyTransform(canvas);
}

export function applyTransform(canvas) {
  canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
  const zoomDisplay = document.getElementById('zoomDisplay');
  if (zoomDisplay) zoomDisplay.innerText = `${Math.round(zoomLevel * 100)}%`;
}

export function getZoomLevel() {
  return zoomLevel;
}