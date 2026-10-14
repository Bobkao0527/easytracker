// trackWorker.js
// EasyTracker 背景追蹤運算線程 (Web Worker)
// 優先使用 Rust Wasm (SIMD128) 核心，自動 Fallback 至純 JS 積分圖引擎

import { matchTemplateNCCIntegral } from './ncc.js';

let wasmInstance = null;

// 初始化載入 Wasm 核心
async function initWasm() {
  try {
    const response = await fetch('./easytracker_wasm.wasm');
    if (response.ok) {
      const bytes = await response.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      wasmInstance = instance;
      console.log('[TrackWorker] Wasm SIMD128 核心載入就緒！');
    } else {
      console.warn('[TrackWorker] Wasm fetch 響應異常，自動啟用高效率 JS 積分圖備援');
    }
  } catch (e) {
    console.warn('[TrackWorker] Wasm 載入略過，自動啟用高效率 JS 積分圖備援:', e?.message || e);
  }
}

initWasm();

self.onmessage = async function(e) {
  const { taskId, targetId, searchBuffer, searchW, searchH, templatePatch } = e.data;

  // 1. 若 Wasm 已就緒，走極速 Wasm + SIMD 算力管線
  if (wasmInstance && wasmInstance.exports && wasmInstance.exports.match_ncc) {
    try {
      const { alloc, dealloc, match_ncc, memory } = wasmInstance.exports;

      const rgbaBytes = new Uint8Array(searchBuffer);
      const rgbaLen = rgbaBytes.length;
      const tplLen = templatePatch.data.length;

      const rgbaPtr = alloc(rgbaLen);
      const tplPtr = alloc(tplLen * 4);
      const outPtr = alloc(12); // 3 * sizeof(f32)

      // 複製輸入至 Wasm 線性記憶體
      const memU8 = new Uint8Array(memory.buffer);
      memU8.set(rgbaBytes, rgbaPtr);

      const memF32 = new Float32Array(memory.buffer);
      memF32.set(templatePatch.data, tplPtr >> 2);

      const status = match_ncc(
        rgbaPtr,
        searchW,
        searchH,
        tplPtr,
        templatePatch.width,
        templatePatch.height,
        templatePatch.norm,
        outPtr
      );

      if (status === 0) {
        const resView = new Float32Array(memory.buffer, outPtr, 3);
        const bestScore = resView[0];
        const bestX = Math.round(resView[1]);
        const bestY = Math.round(resView[2]);

        dealloc(rgbaPtr, rgbaLen);
        dealloc(tplPtr, tplLen * 4);
        dealloc(outPtr, 12);

        self.postMessage({
          taskId,
          targetId,
          result: { score: bestScore, x: bestX, y: bestY }
        });
        return;
      }

      dealloc(rgbaPtr, rgbaLen);
      dealloc(tplPtr, tplLen * 4);
      dealloc(outPtr, 12);
    } catch (err) {
      // 容錯降級至 JS
    }
  }

  // 2. 備援線路：JS 積分圖高效率演算法
  const searchData = { data: new Uint8ClampedArray(searchBuffer) };
  const match = matchTemplateNCCIntegral(searchData, searchW, searchH, templatePatch);

  self.postMessage({
    taskId,
    targetId,
    result: match
  });
};
