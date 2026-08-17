export function exportCSV(trackingData) {
  if (!trackingData || trackingData.length === 0) return;

  let csv = "Frame,Time(s),X_px,Y_px,X_m,Y_m\n";
  trackingData.forEach(row => {
    csv += `${row.frame},${row.time},${row.x_px},${row.y_px},${row.x_m},${row.y_m}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `motion_track_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}