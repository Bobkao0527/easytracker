let calibrationPoints = [];
let pxPerMeter = null;

export function resetCalibration() {
  calibrationPoints = [];
  pxPerMeter = null;
}

export function addCalibrationPoint(x, y, realLengthInMeters) {
  calibrationPoints.push({ x, y });

  if (calibrationPoints.length === 2) {
    const [p1, p2] = calibrationPoints;
    const distPx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const realLen = parseFloat(realLengthInMeters) || 1.0;
    pxPerMeter = distPx / realLen;
    return { completed: true, pxPerMeter, points: calibrationPoints };
  }

  return { completed: false, pxPerMeter: null, points: calibrationPoints };
}

export function getPxPerMeter() {
  return pxPerMeter;
}

export function getCalibrationPoints() {
  return calibrationPoints;
}