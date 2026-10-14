// workerPool.js
// EasyTracker Web Worker 執行緒池調度器
// 支援 Transferable 零拷貝記憶體移交與主線程優雅降級

import { matchTemplateNCCIntegral } from './ncc.js';

class WorkerPool {
  constructor(size = null) {
    this.size = size || Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4));
    this.workers = [];
    this.taskCounter = 0;
    this.activeCallbacks = new Map();
    this.isSupported = typeof Worker !== 'undefined';
    this.initialized = false;
    // 預先嘗試初始化
    this.init();
  }

  init() {
    if (this.initialized || !this.isSupported) return;
    try {
      for (let i = 0; i < this.size; i++) {
        const worker = new Worker('./trackWorker.js', { type: 'module' });
        worker.onmessage = (e) => {
          const { taskId, targetId, result } = e.data;
          const cb = this.activeCallbacks.get(taskId);
          if (cb) {
            this.activeCallbacks.delete(taskId);
            cb.resolve({ targetId, result });
          }
        };
        worker.onerror = (err) => {
          console.warn('[WorkerPool] Worker 錯誤，可能影響並行運算:', err);
        };
        this.workers.push({
          id: i,
          worker,
          busy: false
        });
      }
      this.initialized = true;
      console.log(`%c[WorkerPool] 成功建立 ${this.workers.length} 個背景運算線程 (多質點並行就緒)`, 'color: #22c55e; font-weight: bold;');
    } catch (err) {
      console.warn('[WorkerPool] 無法建立 Web Worker，將自動降級為主線程純 JS 運算:', err);
      this.isSupported = false;
    }
  }

  /**
   * 並行調度多個目標的 NCC 模板匹配
   * @param {Array<{targetId: string, searchBuffer: ArrayBuffer, searchW: number, searchH: number, templatePatch: Object}>} tasks
   * @returns {Promise<Array<{targetId: string, result: {score: number, x: number, y: number}}>>}
   */
  async dispatchAll(tasks) {
    if (!tasks || tasks.length === 0) return [];

    // 若尚未初始化，先嘗試初始化
    if (this.isSupported && !this.initialized) {
      this.init();
    }

    // 若不支援 Web Worker 或初始化失敗，在主執行緒中以積分圖運算
    if (!this.isSupported || this.workers.length === 0) {
      return tasks.map(task => {
        const searchData = { data: new Uint8ClampedArray(task.searchBuffer) };
        const res = matchTemplateNCCIntegral(searchData, task.searchW, task.searchH, task.templatePatch);
        return { targetId: task.targetId, result: res };
      });
    }

    const promises = tasks.map((task, idx) => {
      const taskId = ++this.taskCounter;
      // 輪替指派給 Worker
      const workerItem = this.workers[idx % this.workers.length];

      return new Promise((resolve, reject) => {
        this.activeCallbacks.set(taskId, { resolve, reject });

        const payload = {
          taskId,
          targetId: task.targetId,
          searchBuffer: task.searchBuffer,
          searchW: task.searchW,
          searchH: task.searchH,
          templatePatch: task.templatePatch
        };

        // 以 Transferable Object 零拷貝轉移 ArrayBuffer 擁有權
        workerItem.worker.postMessage(payload, [payload.searchBuffer]);
      });
    });

    return Promise.all(promises);
  }

  terminate() {
    this.workers.forEach(w => w.worker.terminate());
    this.workers = [];
    this.activeCallbacks.clear();
    this.initialized = false;
  }
}

export const globalWorkerPool = new WorkerPool();
