// export.js
export function exportCSV(trackingData) {
  if (!trackingData || trackingData.length === 0) return;

  // 1. 自動讀取第一列資料的所有 key 作為 CSV 表頭 (例如: frame, time, P1_X_m, P1_Y_m, P2_X_m...)
  const headers = Object.keys(trackingData[0]);
  let csv = headers.join(',') + '\n';

  // 2. 動態依照表頭填入每一行的數值
  trackingData.forEach(row => {
    const line = headers.map(key => {
      const val = row[key] !== undefined && row[key] !== null ? row[key] : '';
      // 若字串內含逗號，以雙引號包裹以符合標準 CSV 規範
      return typeof val === 'string' && val.includes(',') ? `"${val}"` : val;
    }).join(',');
    
    csv += line + '\n';
  });

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `motion_track_${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 延遲釋放 ObjectURL，確保各瀏覽器 (尤其是 Safari/iOS) 能穩定完成下載
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}