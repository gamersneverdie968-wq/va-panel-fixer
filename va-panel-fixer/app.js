/**
 * VA Panel Fixer — Core Engine
 * Real-time head/eye tracking + display correction
 * Target: sub-16ms response (60fps+)
 */

'use strict';

// ─── DOM REFS ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const overlay        = $('display-overlay');
const webcam         = $('webcam');
const faceCanvas     = $('face-canvas');
const ctx            = faceCanvas.getContext('2d');
const positionDot    = $('position-dot');
const noFaceMsg      = $('no-face-msg');
const statusDot      = $('status-dot');

// Pre-processing off-screen resources
const offCanvas = document.createElement('canvas');
const offCtx    = offCanvas.getContext('2d', { willReadFrequently: true });
offCanvas.style.display = 'none';
document.body.appendChild(offCanvas);
const statusText     = $('status-text');
const fpsDisplay     = $('fps-display');
const latencyDisplay = $('latency-display');
const vAngle         = $('v-angle');
const hAngle         = $('h-angle');
const dVal           = $('d-val');
const vFill          = $('v-fill');
const hFill          = $('h-fill');
const dFill          = $('d-fill');
const mBrightness    = $('m-brightness');
const mGamma         = $('m-gamma');
const mContrast      = $('m-contrast');
const mSat           = $('m-sat');
const valBrightness  = $('val-brightness');
const valGamma       = $('val-gamma');
const valContrast    = $('val-contrast');
const valSat         = $('val-sat');
const bsMode         = $('bs-mode');
const bsActive       = $('bs-active');
const bsStrength     = $('bs-strength');
const trackingStatus = $('tracking-status'); // NEW
const miniIris       = $('mini-iris');
const miniFps        = $('mini-fps');
const miniStatus     = $('mini-status');
const calFill        = $('cal-fill');
const calCount       = $('cal-count');
const calOverlay     = $('calibration-overlay');

// ─── STATE ───────────────────────────────────────────────────────────────────
const state = {
  active:       true,
  mode:         'auto',
  sensitivity:  4,      // ↓ lower default for stability
  smoothing:    4,      // ↓ smoother default
  maxCorrect:   35,     // ↓ safer default
  fov:          100,
  deadzone:     10,     // NEW: ±10% center deadzone
  invertV:      false,
  invertH:      false,
  deviceId:     '',
  faceDetected: false,

  // Smoother display values (used for final output)
  corrBrightness: 0,
  corrGamma:      1.0,
  corrContrast:   1.0,
  corrSaturation: 1.0,

  // raw tracking values (−1 to +1)
  rawVertical:   0,
  rawHorizontal: 0,
  rawDistance:   0.5,

  // smoothed values
  vertical:   0,
  horizontal: 0,
  distance:   0.5,

  // calibration origin (offset the "ideal" center)
  calVertical:   0,
  calHorizontal: 0,

  // correction output
  brightness: 0,
  gamma:      1.0,
  contrast:   1.0,
  saturation: 1.0,

  // Smoothed correction values (separate from position smoothing)
  // These are what actually get sent to the gamma server — they change
  // gradually even if the angle values spike suddenly.
  corrBrightness: 0,
  corrGamma:      1.0,
  corrContrast:   1.0,
  corrSaturation: 1.0,

  // tint (unused now but kept for future)
  tintWarm: 0,
  tintCool: 0,

  // perf
  lastFrameTime: 0,
  fps:           0,
  frameCount:    0,
  fpsUpdateTime: 0,
  latency:       0,
};

// ─── SETTINGS SLIDERS ────────────────────────────────────────────────────────
$('sensitivity').addEventListener('input', e => {
  state.sensitivity = +e.target.value;
  $('sensitivity-val').textContent = e.target.value;
});
$('smoothing').addEventListener('input', e => {
  state.smoothing = +e.target.value;
  $('smoothing-val').textContent = e.target.value;
});
$('max-correction').addEventListener('input', e => {
  state.maxCorrect = +e.target.value;
  $('max-correction-val').textContent = e.target.value + '%';
  // Update slider display immediately
  $('max-correction').setAttribute('value', e.target.value);
});

$('fov').addEventListener('input', e => {
  state.fov = +e.target.value;
  $('fov-val').textContent = e.target.value + '%';
  webcam.style.transform = `scaleX(-1) scale(${100 / state.fov})`;
});

// Sync slider initial display values
document.querySelectorAll('.slider').forEach(s => {
  const valEl = $(s.id + '-val') || s.parentElement.querySelector('.slider-val');
});
$('sensitivity-val').textContent    = state.sensitivity;
$('smoothing-val').textContent      = state.smoothing;
$('max-correction-val').textContent = state.maxCorrect + '%';
$('fov-val').textContent            = state.fov + '%';
// Also update slider positions
$('sensitivity').value    = state.sensitivity;
$('max-correction').value = state.maxCorrect;
$('fov').value            = state.fov;
webcam.style.transform = `scaleX(-1) scale(${100 / state.fov})`;

$('deadzone').addEventListener('input', e => {
  state.deadzone = +e.target.value;
  $('deadzone-val').textContent = e.target.value + '%';
});
$('invert-v').addEventListener('change', e => state.invertV = e.target.checked);
$('invert-h').addEventListener('change', e => state.invertH = e.target.checked);
// Initial sync
$('deadzone').value = state.deadzone;
$('deadzone-val').textContent = state.deadzone + '%';
$('sensitivity').value = state.sensitivity;
$('sensitivity-val').textContent = state.sensitivity;
$('smoothing').value = state.smoothing;
$('smoothing-val').textContent = state.smoothing;
$('max-correction').value = state.maxCorrect;
$('max-correction-val').textContent = state.maxCorrect + '%';

$('camera-select').addEventListener('change', e => {
  state.deviceId = e.target.value;
  startCamera(state.deviceId);
});

async function updateCameraList() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');
    const select = $('camera-select');
    const currentVal = select.value;
    select.innerHTML = '';
    
    videoDevices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Camera ${i + 1}`;
      select.appendChild(opt);
    });
    
    if (currentVal && [...select.options].some(o => o.value === currentVal)) {
      select.value = currentVal;
    }
  } catch (e) { console.error('Enumerate error', e); }
}

// ─── MODE BUTTONS ────────────────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
    bsMode.textContent = btn.dataset.mode.charAt(0).toUpperCase() + btn.dataset.mode.slice(1);
  });
});

// ─── TOGGLE / MINIMIZE ───────────────────────────────────────────────────────
$('btn-toggle').addEventListener('click', () => {
  state.active = !state.active;
  bsActive.textContent = state.active ? 'Yes' : 'No';
  if (!state.active) {
    // Reset Windows display to normal when disabled
    wsSend({ cmd: 'reset' });
  }
});

$('btn-minimize').addEventListener('click', () => {
  $('app').classList.add('hidden');
  $('mini-widget').classList.remove('hidden');
});

$('mini-expand').addEventListener('click', () => {
  $('app').classList.remove('hidden');
  $('mini-widget').classList.add('hidden');
});

// ─── CALIBRATION ─────────────────────────────────────────────────────────────
$('btn-calibrate').addEventListener('click', startCalibration);

function startCalibration() {
  if (!state.faceDetected) {
    alert('No face detected. Please make sure your camera is working!');
    return;
  }
  calOverlay.classList.remove('hidden');
  let progress = 0;
  let countdown = 3;
  calCount.textContent = countdown;
  calFill.style.width = '0%';

  const interval = setInterval(() => {
    progress += 2;
    calFill.style.width = progress + '%';
    if (progress % 34 === 0 && countdown > 1) {
      countdown--;
      calCount.textContent = countdown;
    }
    if (progress >= 100) {
      clearInterval(interval);
      // Lock current position as calibration origin
      state.calVertical   += state.rawVertical;
      state.calHorizontal += state.rawHorizontal;
      state.vertical = 0;
      state.horizontal = 0;
      calOverlay.classList.add('hidden');
    }
  }, 50);
}

// ─── WEBSOCKET — Windows Gamma Control ──────────────────────────────────────
// Connects to gamma_server.py which calls SetDeviceGammaRamp on Windows.
// This changes the ACTUAL display gamma, not just a browser filter.
let ws          = null;
let wsConnected = false;
let wsRetryTimer = null;

function connectWS() {
  try {
    ws = new WebSocket('ws://localhost:7891');

    ws.onopen = () => {
      wsConnected = true;
      clearTimeout(wsRetryTimer);
      setStatus('active', 'System Control Active');
      $('bs-active').textContent = 'System ✓';
      // Send a ping to confirm
      ws.send(JSON.stringify({ cmd: 'ping' }));
    };

    ws.onclose = () => {
      wsConnected = false;
      setStatus('loading', 'Run gamma_server.py for display control');
      $('bs-active').textContent = 'App only';
      // Auto-reconnect every 2s
      wsRetryTimer = setTimeout(connectWS, 2000);
    };

    ws.onerror = () => {
      wsConnected = false;
    };

  } catch(e) {
    wsRetryTimer = setTimeout(connectWS, 2000);
  }
}

function wsSend(data) {
  if (ws && wsConnected && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

// Start connecting immediately
connectWS();

// ─── MEDIAPIPE FACE MESH SETUP ───────────────────────────────────────────────
let faceMesh = null;
let camera   = null;

// Key landmark indices from MediaPipe FaceMesh 468-point model
const LM = {
  NOSE_TIP:       1,
  FOREHEAD:       10,
  CHIN:           152,
  LEFT_EAR:       234,
  RIGHT_EAR:      454,
  LEFT_EYE_L:     33,
  LEFT_EYE_R:     133,
  RIGHT_EYE_L:    362,
  RIGHT_EYE_R:    263,
  LEFT_IRIS:      468,   // only if iris tracking enabled
  RIGHT_IRIS:     473,
  NOSE_BRIDGE:    6,
  LEFT_CHEEK:     116,
  RIGHT_CHEEK:    345,
};

async function initFaceMesh() {
  setStatus('loading', 'Loading face model...');

  try {
    faceMesh = new FaceMesh({
      locateFile: file =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/${file}`
    });

    faceMesh.setOptions({
      maxNumFaces:            1,
      refineLandmarks:        true,
      minDetectionConfidence: 0.3,  // ↑ increase for more stable recognition
      minTrackingConfidence:  0.3,
    });

    faceMesh.onResults(onFaceMeshResults);

    await faceMesh.initialize();
    setStatus('loading', 'Starting camera...');
    await startCamera();
  } catch (err) {
    setStatus('error', 'Error: ' + err.message);
    console.error(err);
  }
}

async function startCamera(deviceId = '') {
  try {
    // Clean up old stream
    if (webcam.srcObject) {
      webcam.srcObject.getTracks().forEach(track => track.stop());
    }

    const videoConstraints = {
      width:       { ideal: 640 },
      height:      { ideal: 480 },
      frameRate:   { ideal: 60, max: 60 },
      facingMode:  'user',
    };
    if (deviceId) videoConstraints.deviceId = { exact: deviceId };

    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints
    });
    webcam.srcObject = stream;
    await new Promise(r => webcam.onloadedmetadata = r);
    await webcam.play();
    
    updateCameraList();
    
    // ──────────────────────────────────────────────────────
    // NEW STREAM LOOP (Manual instead of MediaPipe Camera helper)
    // This is more robust as it doesn't fight over the stream.
    // ──────────────────────────────────────────────────────
    let isProcessing = false;
    const processFrame = async () => {
      if (webcam.paused || webcam.ended) return;

      if (!isProcessing) {
        const t0 = performance.now();
        isProcessing = true;

        if (webcam.videoWidth > 0 && offCanvas.width > 0) {
          const boost = state.mode === 'dark' ? 1.8 : 1.4;
          offCtx.filter = `brightness(${boost}) contrast(1.15)`;
          
          // Disable FOV crop when searching for a face to prevent cropping it out!
          if (state.faceDetected && state.fov < 100) {
            const fovScale = state.fov / 100;
            const sw = offCanvas.width, sh = offCanvas.height;
            const cropW = sw * fovScale, cropH = sh * fovScale;
            // Center crop 
            offCtx.drawImage(webcam, (sw - cropW) / 2, (sh - cropH) / 2, cropW, cropH, 0, 0, sw, sh);
          } else {
            offCtx.drawImage(webcam, 0, 0, offCanvas.width, offCanvas.height);
          }
          offCtx.filter = 'none';

          await faceMesh.send({ image: offCanvas });
        }
        
        state.latency = Math.round(performance.now() - t0);
        isProcessing = false;
      }
      requestAnimationFrame(processFrame);
    };

    // Ensure offCanvas matches video size
    webcam.onresize = () => {
      offCanvas.width = webcam.videoWidth;
      offCanvas.height = webcam.videoHeight;
    };
    offCanvas.width = webcam.videoWidth || 640;
    offCanvas.height = webcam.videoHeight || 480;

    requestAnimationFrame(processFrame);
    setStatus('active', 'System Ready');
  } catch (err) {
    setStatus('error', 'Camera error: ' + err.message);
    noFaceMsg.classList.add('show');
  }
}

// ─── FACE MESH RESULTS ───────────────────────────────────────────────────────
function onFaceMeshResults(results) {
  const t0 = performance.now();

  // Use display dimensions — must match what the video element shows
  const w = faceCanvas.width;
  const h = faceCanvas.height;

  // Clear canvas
  ctx.clearRect(0, 0, w, h);

  if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
    state.faceDetected = false;
    noFaceMsg.classList.add('show');
    if (trackingStatus) {
      trackingStatus.textContent = "SEARCHING";
      const dot = $('hud-dot');
      if (dot) { dot.className = 'hud-dot searching'; }
    }
    // Slowly decay correction toward zero — never jump suddenly
    // 0.97 per frame = ~1 second to reach near-zero at 30fps
    state.vertical   *= 0.97;
    state.horizontal *= 0.97;
    // Also decay the smoothed correction values
    state.corrBrightness = state.corrBrightness * 0.97;
    state.corrGamma      = state.corrGamma      * 0.97 + 1.0 * 0.03;
    state.corrContrast   = state.corrContrast   * 0.97 + 1.0 * 0.03;
    state.corrSaturation = state.corrSaturation * 0.97 + 1.0 * 0.03;
    applyCorrection();
    updateUI();
    return;
  }

  state.faceDetected = true;
  noFaceMsg.classList.remove('show');
  if (trackingStatus) {
    trackingStatus.textContent = "LOCK";
    const dot = $('hud-dot');
    if (dot) { dot.className = 'hud-dot active'; }
  }

  const lm = results.multiFaceLandmarks[0];


  // ── Draw face tracking overlay (clear, on-face) ──
  drawFaceOverlay(lm, w, h);


  // ── Extract head pose ──
  estimateHeadPose(lm, w, h);

  // ── Apply correction ──
  if (state.active) applyCorrection();

  // ── Update UI ──
  updateUI();

  // ── FPS counter ──
  state.frameCount++;
  const now = t0;
  if (now - state.fpsUpdateTime >= 500) {
    state.fps = Math.round(state.frameCount * 1000 / (now - state.fpsUpdateTime));
    state.frameCount   = 0;
    state.fpsUpdateTime = now;
    fpsDisplay.textContent  = state.fps + ' fps';
    latencyDisplay.textContent = state.latency + ' ms';
    miniFps.textContent     = state.fps + ' fps';
  }
}

// ─── HEAD POSE ESTIMATION ────────────────────────────────────────────────────
function estimateHeadPose(lm, w, h) {
  // Use absolute position of the eyes in the camera frame
  // This correctly detects when the whole body moves up/down/left/right 
  // without needing head rotation, giving a much better response.
  let eyeX = 0, eyeY = 0;
  
  // Try to use precisely tracked irises if available, else fallback to eyes
  if (lm[468] && lm[473]) {
    eyeX = (lm[468].x + lm[473].x) / 2;
    eyeY = (lm[468].y + lm[473].y) / 2;
  } else {
    eyeX = (lm[33].x + lm[263].x) / 2;
    eyeY = (lm[33].y + lm[263].y) / 2;
  }

  // Offset from screen center (0.5)
  // Positive Y = moving down
  const offsetX = eyeX - 0.5;
  const offsetY = eyeY - 0.5;

  // Face width (proxy for distance)
  const leftEar  = lm[234];
  const rightEar = lm[454];
  const faceWidth = Math.abs(rightEar.x - leftEar.x);

  // Normalize vertical: typical sitting movement spans ±15% of the frame
  // When zoomed in (lower FOV), the usable frame percentage shrinks.
  // We divide the normalization range by (100/FOV) to maintain 
  // consistent response or even increase sensitivity.
  const zoomFactor = 100 / state.fov; 
  const rawV = offsetY / (0.12 / zoomFactor);  // Increased base sensitivity
  const rawH = offsetX / (0.22 / zoomFactor);

  state.rawVertical   = clamp(rawV - state.calVertical,   -1, 1);
  state.rawHorizontal = clamp(rawH - state.calHorizontal, -1, 1);
  state.rawDistance   = clamp(faceWidth / 0.35, 0.2, 2.0); // 1.0 = normal dist

  // ── Exponential smoothing (lower = faster response, higher = smoother) ──
  const alpha = 1 / (1 + state.smoothing * 0.5); // smoothing 1→10 maps to alpha 0.67→0.17
  state.vertical   += alpha * (state.rawVertical   - state.vertical);
  state.horizontal += alpha * (state.rawHorizontal - state.horizontal);
  state.distance   += 0.1  * (state.rawDistance    - state.distance);
}

// ─── APPLY DISPLAY CORRECTION ────────────────────────────────────────────────
/**
 * VA Panel characteristic:
 *   - Viewing slightly from above → image appears brighter / washed out → compensate: darken
 *   - Viewing slightly from below → image appears darker / crushed blacks → compensate: brighten
 *   - Horizontal offset → slight color cast & contrast loss → compensate: boost contrast + saturation
 *   - Too close → can look bright → adjust accordingly
 */
function applyCorrection() {
  let v = state.vertical;
  let h = state.horizontal;
  
  // Apply inversion switches
  if (state.invertV) v = -v;
  if (state.invertH) h = -h;

  const sens = state.sensitivity / 5.0;
  const maxC = state.maxCorrect / 100.0;
  const dead = state.deadzone / 100.0;
  
  // Environment mode (Auto/Dark/Bright)
  const modeGammaMultiplier = state.mode === 'dark' ? 0.9 : state.mode === 'bright' ? 1.15 : 1.0;

  // ── 1: NON-LINEAR RESPONSE (CUBIC) ──────────────────────────────────
  // Cubic curve (abs(x)^2.5) ensures the center "Sweet Spot" is rock-solid ("Stilled").
  // Small head movements ±3° will now produce almost ZERO display change.
  // Large angles produce a smooth, natural transition.
  const nv = Math.abs(v) < dead ? 0 : Math.sign(v) * Math.pow((Math.abs(v) - dead) / (1 - dead), 2.5);
  const nh = Math.abs(h) < dead ? 0 : Math.sign(h) * Math.pow((Math.abs(h) - dead) / (1 - dead), 2.5);

  // ── 2: VERTICAL CORRECTION (Viewing from Above vs Below) ────────────
  // NV > 0 (Sitting Low / Viewing from Below) -> Fixes Black Crush
  // NV < 0 (Sitting High / Viewing from Above) -> Fixes Wash-out
  
  // Brightest point: Extremely subtle boost
  let targetBright = nv * 0.15 * sens; 
  
  // Gamma Fix: Sitting Low (Below angle) needs Gamma > 1.0 to LIFT shadows.
  let targetGamma  = 1.0 + (nv * 0.35 * sens); 
  targetGamma *= modeGammaMultiplier;

  // Contrast Fix: 
  let targetContr = 1.0 - (nv * 0.20 * sens) + (Math.abs(nh) * 0.25 * sens);

  // Saturation Fix: VA Side-view color loss compensation
  const angle = Math.sqrt(nv * nv + nh * nh);
  let targetSat = 1.0 + angle * 0.32 * sens;

  // ── 3: DYNAMIC TRANSITION SPEED ─────────────────────────────────────
  // Higher smoothing = slower display changes. 
  // This helps make the compensation completely invisible to the eye.
  const speed = 1.0 / (1.0 + state.smoothing * 2.5); // smoothing 4 -> 0.09 SPEED
  
  state.corrBrightness += speed * (targetBright - state.corrBrightness);
  state.corrGamma      += speed * (targetGamma  - state.corrGamma);
  state.corrContrast   += speed * (targetContr  - state.corrContrast);
  state.corrSaturation += speed * (targetSat    - state.corrSaturation);

  // Final Safety Caps
  state.brightness = clamp(state.corrBrightness, -maxC, maxC);
  state.gamma      = clamp(state.corrGamma, 0.45, 2.40);
  state.contrast   = clamp(state.corrContrast, 0.72, 1.55);
  state.saturation = clamp(state.corrSaturation, 0.85, 1.75);

  // Apply using the SMOOTHED values
  applyFilter(state.brightness, state.gamma, state.contrast, state.saturation);

  const strength = Math.round(angle * 100 * sens);
  bsStrength.textContent = Math.min(strength, 100) + '%';
}

function applyFilter(brightness, gamma, contrast, saturation) {
  // ── FINAL HARD CLAMP before sending to Python ──
  // Even if something slips through the smoothers, these limits
  // guarantee the Python server never receives a value that could
  // black out the screen.
  // black out the screen.
  const safeB = clamp(brightness, -0.15, 0.25);
  const safeG = clamp(gamma,       0.70, 1.65);
  const safeC = clamp(contrast,    0.80, 1.35);
  const safeS = clamp(saturation,  0.85, 1.50);

  if (state.active) {
    wsSend({
      cmd:        'apply',
      brightness: parseFloat(safeB.toFixed(4)),
      gamma:      parseFloat(safeG.toFixed(4)),
      contrast:   parseFloat(safeC.toFixed(4)),
      saturation: parseFloat(safeS.toFixed(4)),
    });
  } else {
    wsSend({ cmd: 'reset' });
  }

  // Keep overlay invisible — NO tinting, NO filter on the app UI
  overlay.style.background = 'transparent';
  overlay.style.opacity    = '0';
}


// ─── DRAW FACE OVERLAY ───────────────────────────────────────────────────────
function drawFaceOverlay(lm, w, h) {
  if (!lm || lm.length === 0) return;

  ctx.save();

  // Helper: landmark to canvas pixel
  const px = idx => lm[idx].x * w;
  const py = idx => lm[idx].y * h;

  // ── 1: FACE BOUNDING BOX ──
  // Compute from a handful of edge landmarks
  const edgePts = [10, 152, 234, 454, 67, 297];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  edgePts.forEach(i => {
    minX = Math.min(minX, px(i)); maxX = Math.max(maxX, px(i));
    minY = Math.min(minY, py(i)); maxY = Math.max(maxY, py(i));
  });
  const padX = (maxX - minX) * 0.12;
  const padY = (maxY - minY) * 0.10;
  const bx = minX - padX, by = minY - padY;
  const bw = (maxX - minX) + padX * 2;
  const bh = (maxY - minY) + padY * 2;

  // Glowing bounding box
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 12);
  ctx.strokeStyle = 'rgba(99,102,241,0.5)';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Corner brackets on bounding box
  const bracketLen = 14;
  const corners = [
    [bx, by, 1, 1], [bx + bw, by, -1, 1],
    [bx, by + bh, 1, -1], [bx + bw, by + bh, -1, -1]
  ];
  corners.forEach(([cx2, cy2, dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(cx2 + dx * bracketLen, cy2);
    ctx.lineTo(cx2, cy2);
    ctx.lineTo(cx2, cy2 + dy * bracketLen);
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth   = 2.5;
    ctx.stroke();
  });

  // ── 2: FACE OVAL ──
  // Hide the face oval as requested ("shift whole face tracking to eyes only")
  // We'll skip the stroke and only show iris/box if needed
  /*
  const ovalPts = [10,338,297,332,284,251,389,356,454,
                   323,361,288,397,365,379,378,400,377,
                   152,148,176,149,150,136,172,58,132,
                   93,234,127,162,21,54,103,67,109];

  ctx.beginPath();
  ovalPts.forEach((idx, i) => {
    const x = px(idx), y = py(idx);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.closePath();

  // Glow effect: draw wide stroke first, then thin bright stroke
  ctx.strokeStyle = 'rgba(99,102,241,0.18)';
  ctx.lineWidth   = 6;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(99,102,241,0.65)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
  */

  // ── 3: EYE OVALS ──
  // Left eye contour indices (person's left)
  const leftEyePts  = [33, 160, 158, 133, 153, 144];
  const rightEyePts = [362, 385, 387, 263, 373, 380];

  const drawEyeOval = (pts, color) => {
    let ex = 0, ey = 0;
    pts.forEach(i => { ex += px(i); ey += py(i); });
    ex /= pts.length; ey /= pts.length;

    // Width from outer–inner corner, height from top–bottom pts
    const rw = Math.abs(px(pts[0]) - px(pts[3])) / 2 + 3;
    const rh = Math.abs(py(pts[1]) - py(pts[4])) / 2 + 2;

    ctx.beginPath();
    ctx.ellipse(ex, ey, Math.max(rw, 8), Math.max(rh, 4), 0, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.stroke();
    // Inner glow
    ctx.beginPath();
    ctx.ellipse(ex, ey, Math.max(rw, 8), Math.max(rh, 4), 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth   = 4;
    ctx.stroke();
  };

  drawEyeOval(leftEyePts,  'rgba(99,102,241,0.9)');
  drawEyeOval(rightEyePts, 'rgba(99,102,241,0.9)');

  // ── 4: IRIS DOTS (refined landmarks: indices 468–477) ──
  if (lm.length > 468) {
    const drawIris = (irisIdx, eyePts) => {
      const iris = lm[irisIdx];
      if (!iris) return;
      const ix = iris.x * w;
      const iy = iris.y * h;

      // Iris glow ring
      const gradient = ctx.createRadialGradient(ix, iy, 0, ix, iy, 8);
      gradient.addColorStop(0, 'rgba(236,72,153,1)');
      gradient.addColorStop(0.4, 'rgba(236,72,153,0.6)');
      gradient.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(ix, iy, 8, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();

      // Iris ring
      ctx.beginPath();
      ctx.arc(ix, iy, 6, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(236,72,153,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Pupil center
      ctx.beginPath();
      ctx.arc(ix, iy, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();

      // Update mini widget iris
      const nx = (iris.x - 0.5) * 8;
      const ny = (iris.y - 0.5) * 5;
      miniIris.style.transform = `translate(${clamp(nx, -5, 5)}px, ${clamp(ny, -3, 3)}px)`;
    };

    drawIris(468); // left iris
    drawIris(473); // right iris
  }

  // ── 5: NOSE TIP DOT ──
  const noseTipIdx = 4; // nose bridge — very stable landmark
  const nx2 = px(noseTipIdx), ny2 = py(noseTipIdx);
  ctx.beginPath();
  ctx.arc(nx2, ny2, 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(34,211,163,0.9)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(nx2, ny2, 7, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(34,211,163,0.4)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // ── 6: FACE CENTER CROSSHAIR ──
  const fcx = (px(234) + px(454)) / 2;  // left+right ear center
  const fcy = (py(10)  + py(152)) / 2;  // forehead+chin center
  const cSize = 10;
  ctx.beginPath();
  ctx.moveTo(fcx - cSize, fcy); ctx.lineTo(fcx + cSize, fcy);
  ctx.moveTo(fcx, fcy - cSize); ctx.lineTo(fcx, fcy + cSize);
  ctx.strokeStyle = 'rgba(245,158,11,0.8)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(fcx, fcy, 3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(245,158,11,0.9)';
  ctx.fill();

  ctx.restore();
}


// ─── UI UPDATE ───────────────────────────────────────────────────────────────
function updateUI() {
  const v    = state.vertical;
  const h    = state.horizontal;
  const dist = state.distance;

  // ── Position dot on grid ──
  const grid   = $('position-grid');
  const gridW  = grid.offsetWidth;
  const gridH  = grid.offsetHeight;
  const cx = gridW / 2;
  const cy = gridH / 2;
  const dotX = clamp(cx + h * cx * 0.85, 12, gridW - 12);
  const dotY = clamp(cy + v * cy * 0.85, 12, gridH - 12);
  positionDot.style.left = dotX + 'px';
  positionDot.style.top  = dotY + 'px';

  // Color the dot by severity
  const severity = Math.sqrt(v * v + h * h);
  if (severity < 0.15) {
    positionDot.style.background = 'radial-gradient(circle, #22d3a3, #6366f1)';
    positionDot.style.boxShadow  = '0 0 16px rgba(34,211,163,0.6)';
  } else if (severity < 0.45) {
    positionDot.style.background = 'radial-gradient(circle, #f59e0b, #ef4444)';
    positionDot.style.boxShadow  = '0 0 16px rgba(245,158,11,0.6)';
  } else {
    positionDot.style.background = 'radial-gradient(circle, #ef4444, #a855f7)';
    positionDot.style.boxShadow  = '0 0 16px rgba(239,68,68,0.7)';
  }

  // ── Angle readouts ──
  const vDeg = Math.round(v * 30);
  const hDeg = Math.round(h * 25);
  vAngle.textContent = (vDeg >= 0 ? '+' : '') + vDeg + '°';
  hAngle.textContent = (hDeg >= 0 ? '+' : '') + hDeg + '°';

  const distCm = Math.round(dist * 60);
  dVal.textContent   = distCm + ' cm';

  // ── Angle bars ──
  const vPct = Math.abs(v) * 50;
  vFill.style.width = vPct + '%';
  vFill.style.left  = v >= 0 ? '50%' : (50 - vPct) + '%';

  const hPct = Math.abs(h) * 50;
  hFill.style.width = hPct + '%';
  hFill.style.left  = h >= 0 ? '50%' : (50 - hPct) + '%';

  const dPct = clamp((dist - 0.2) / 1.8 * 100, 0, 100);
  dFill.style.width = dPct + '%';

  // ── Correction meters ──
  const brightPct = state.brightness * 100;
  const mBrightPx = Math.abs(brightPct) / 2;
  mBrightness.style.width = mBrightPx + '%';
  mBrightness.style.left  = brightPct >= 0 ? '50%' : (50 - mBrightPx) + '%';
  valBrightness.textContent = (brightPct >= 0 ? '+' : '') + Math.round(brightPct) + '%';

  const gammaPct = Math.min(Math.abs(state.gamma - 1.0) * 33, 50);
  mGamma.style.width = gammaPct + '%';
  mGamma.style.left  = state.gamma >= 1 ? (50 - gammaPct) + '%' : '50%';
  valGamma.textContent = state.gamma.toFixed(2);
  
  // Ensure the vertical alignment of the gamma bar is physically correct
  // centering the fill specifically in the track
  mGamma.style.top = '0';

  const contrastPct = Math.abs(state.contrast - 1.0) * 50;
  mContrast.style.width = contrastPct + '%';
  mContrast.style.left  = '50%';
  valContrast.textContent = Math.round(state.contrast * 100) + '%';

  const satPct = Math.abs(state.saturation - 1.0) * 50;
  mSat.style.width = satPct + '%';
  mSat.style.left  = '50%';
  valSat.textContent = Math.round(state.saturation * 100) + '%';

  // ── Mini status ──
  miniStatus.textContent = state.faceDetected ? 'Tracking' : 'No Face';
}

// ─── STATUS ──────────────────────────────────────────────────────────────────
function setStatus(type, text) {
  statusText.textContent = text;
  statusDot.className    = 'status-dot';
  if (type === 'active')  statusDot.classList.add('active');
  if (type === 'error')   statusDot.classList.add('error');
}

// ─── UTILS ───────────────────────────────────────────────────────────────────
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

// ─── MINI WIDGET DRAG ────────────────────────────────────────────────────────
(function makeDraggable(el) {
  let dx = 0, dy = 0, sx = 0, sy = 0;
  el.addEventListener('mousedown', e => {
    e.preventDefault();
    sx = e.clientX - el.getBoundingClientRect().left;
    sy = e.clientY - el.getBoundingClientRect().top;
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', () => document.removeEventListener('mousemove', drag));
  });
  function drag(e) {
    el.style.right  = 'auto';
    el.style.bottom = 'auto';
    el.style.left   = (e.clientX - sx) + 'px';
    el.style.top    = (e.clientY - sy) + 'px';
  }
})($('mini-widget'));

// ─── CANVAS RESIZE OBSERVER ──────────────────────────────────────────────────
// Re-sync canvas display size whenever the camera wrap is resized
new ResizeObserver(() => {
  const rect = faceCanvas.getBoundingClientRect();
  if (rect.width > 0) {
    faceCanvas.width  = rect.width;
    faceCanvas.height = rect.height;
  }
}).observe(faceCanvas);

// ─── KEYBOARD SHORTCUTS ──────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
  if (e.key === ' ')  { e.preventDefault(); $('btn-toggle').click(); }
  if (e.key === 'c')  startCalibration();
  if (e.key === 'm')  $('btn-minimize').click();
  if (e.key === 'Escape') $('mini-expand').click();
});

// ─── BOOT ────────────────────────────────────────────────────────────────────
// Stagger init to not block first paint
requestAnimationFrame(() => {
  setTimeout(initFaceMesh, 100);
});

console.log('%c VA Panel Fixer ', 'background:#6366f1;color:#fff;font-size:14px;padding:4px 8px;border-radius:4px;');
console.log('Shortcuts: [Space] toggle | [C] calibrate | [M] minimize | [Esc] expand');
