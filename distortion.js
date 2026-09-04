// distortion.js
// 透過 WebGL 實現高效能 GPU 影像扭曲 (桶狀 / 針墊畸變)

let gl = null;
let program = null;
let texture = null;
let offscreenCanvas = null;
let k1UniformLocation = null;
let aspectUniformLocation = null;

const vsSource = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  varying vec2 v_texCoord;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = vec2(a_texCoord.x, 1.0 - a_texCoord.y); // Canvas 與 WebGL Y軸轉換
  }
`;

let homographyUniformLocation = null;
let currentHomography = [1,0,0, 0,1,0, 0,0,1];

const fsSource = `
  precision mediump float;
  varying vec2 v_texCoord;
  uniform sampler2D u_image;
  uniform float u_k1;
  uniform float u_aspect;
  uniform mat3 u_homography;

  void main() {
    // 1. 套用透視變換 (Screen Pixel -> 原圖去畸變座標)
    vec3 proj = u_homography * vec3(v_texCoord, 1.0);
    if (proj.z == 0.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    vec2 uv_rect = proj.xy / proj.z;

    // 2. 逆向施加徑向畸變以取樣真實原圖紋理
    // 使用中心對角化歸一化空間，徹底解決 9:16 直向縱橫比失真
    vec2 st = uv_rect - vec2(0.5);
    
    // 修正：針對直向 (u_aspect < 1.0) 與橫向 (u_aspect >= 1.0) 正確等比縮放
    vec2 metricSt = vec2(st.x * u_aspect, st.y);
    float r2 = dot(metricSt, metricSt);

    // 逆向去畸變近似：原圖取樣點應除以 (1.0 + k1 * r2)
    vec2 distortedSt = st / (1.0 + u_k1 * r2);
    vec2 uv = distortedSt + vec2(0.5);

    // 超出邊界補黑邊
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    } else {
      gl_FragColor = texture2D(u_image, uv);
    }
  }
`;

function createShader(glContext, type, source) {
  const shader = glContext.createShader(type);
  glContext.shaderSource(shader, source);
  glContext.compileShader(shader);
  if (!glContext.getShaderParameter(shader, glContext.COMPILE_STATUS)) {
    console.error('Shader 編譯錯誤:', glContext.getShaderInfoLog(shader));
    glContext.deleteShader(shader);
    return null;
  }
  return shader;
}

export function initDistortionRenderer(width, height) {
  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = width;
  offscreenCanvas.height = height;

  gl = offscreenCanvas.getContext('webgl');
  if (!gl) return false;

  const vertShader = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fragShader = createShader(gl, gl.FRAGMENT_SHADER, fsSource);

  program = gl.createProgram();
  gl.attachShader(program, vertShader);
  gl.attachShader(program, fragShader);
  gl.linkProgram(program);
  gl.useProgram(program);

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1,  0, 0,
       1, -1,  1, 0,
      -1,  1,  0, 1,
      -1,  1,  0, 1,
       1, -1,  1, 0,
       1,  1,  1, 1,
    ]),
    gl.STATIC_DRAW
  );

  const FSIZE = Float32Array.BYTES_PER_ELEMENT;
  const a_position = gl.getAttribLocation(program, 'a_position');
  gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, FSIZE * 4, 0);
  gl.enableVertexAttribArray(a_position);

  const a_texCoord = gl.getAttribLocation(program, 'a_texCoord');
  gl.vertexAttribPointer(a_texCoord, 2, gl.FLOAT, false, FSIZE * 4, FSIZE * 2);
  gl.enableVertexAttribArray(a_texCoord);

  texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  k1UniformLocation = gl.getUniformLocation(program, 'u_k1');
  aspectUniformLocation = gl.getUniformLocation(program, 'u_aspect');
  homographyUniformLocation = gl.getUniformLocation(program, 'u_homography');
  return true;
}

export function setHomographyMatrix(matrix) {
  if (Array.isArray(matrix) && matrix.length === 9) {
    currentHomography = matrix;
  }
}

export function renderDistortedVideo(videoElement, targetCtx, k1 = 0) {
  if (!gl || !offscreenCanvas || !program || !texture) return false;

  try {
    if (offscreenCanvas.width !== videoElement.videoWidth || offscreenCanvas.height !== videoElement.videoHeight) {
      offscreenCanvas.width = videoElement.videoWidth;
      offscreenCanvas.height = videoElement.videoHeight;
      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    }

    gl.useProgram(program);
    gl.uniform1f(k1UniformLocation, k1);
    gl.uniform1f(aspectUniformLocation, videoElement.videoWidth / videoElement.videoHeight);
    // currentHomography is stored row-major; WebGL expects column-major data.
    const h = currentHomography;
    gl.uniformMatrix3fv(
      homographyUniformLocation,
      false,
      new Float32Array([
        h[0], h[3], h[6],
        h[1], h[4], h[7],
        h[2], h[5], h[8]
      ])
    );

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElement);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    targetCtx.drawImage(offscreenCanvas, 0, 0);
    return true;
  } catch (error) {
    console.warn('WebGL 影片渲染失敗，改用 Canvas 2D 預覽:', error);
    return false;
  }
}