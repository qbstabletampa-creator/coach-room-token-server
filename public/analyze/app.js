/**
 * QB Motion Capture v3 - MediaPipe Pose Analysis
 * Premium biomechanics analysis with split panel, kinematic sequence,
 * report card grading, stromotion composites, color-coded ranges,
 * upload state machine, session naming, and pinch-to-zoom.
 * All processing runs client-side in the browser.
 */

import { setupVideoZoom, cleanupZoom } from './zoom.js';
import { saveSession, getSession, getAllSessions, deleteSession, captureThumbnail } from './db.js';
import { init3D, resize3D, update3DPose, dispose3D, isWebGLAvailable } from './renderer3d.js';

// ==========================================
// Constants
// ==========================================

const LANDMARKS = {
  NOSE: 0,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
};

const LANDMARK_NAMES = [
  'nose', 'left_eye_inner', 'left_eye', 'left_eye_outer',
  'right_eye_inner', 'right_eye', 'right_eye_outer',
  'left_ear', 'right_ear', 'mouth_left', 'mouth_right',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_pinky', 'right_pinky',
  'left_index', 'right_index', 'left_thumb', 'right_thumb',
  'left_hip', 'right_hip', 'left_knee', 'right_knee',
  'left_ankle', 'right_ankle', 'left_heel', 'right_heel',
  'left_foot_index', 'right_foot_index',
];

const CONNECTIONS = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [0, 11], [0, 12],
];

// QB-specific ideal ranges (Sportsbox style color coding)
const IDEAL_RANGES = {
  elbow: { green: [90, 110], yellow: [70, 130], label: 'Elbow Angle at Release', unit: '\u00B0' },
  shoulder: { green: [80, 110], yellow: [60, 130], label: 'Shoulder Angle', unit: '\u00B0' },
  hip: { green: [30, 55], yellow: [20, 70], label: 'Hip-Shoulder Separation', unit: '\u00B0' },
  knee: { green: [150, 175], yellow: [135, 180], label: 'Front Knee Bend', unit: '\u00B0' },
  release: { green: [30, 60], yellow: [15, 75], label: 'Release Point Height', unit: '\u00B0' },
};

// Report Card categories
const REPORT_CATEGORIES = [
  { id: 'releaseTime', name: 'Release Time', desc: 'Ball pat to ball release', idealRange: [350, 425], idealDesc: '<400ms elite' },
  { id: 'hipShoulder', name: 'Hip-Shoulder Separation', desc: 'Peak separation degrees', idealRange: [35, 55], idealDesc: '35-55\u00B0' },
  { id: 'elbowRelease', name: 'Elbow Angle at Release', desc: 'Elbow extension at ball release', idealRange: [30, 40], idealDesc: '30-40\u00B0' },
  { id: 'strideLength', name: 'Stride Length', desc: 'Relative to estimated height', idealDesc: '60-80% height' },
  { id: 'frontKnee', name: 'Front Knee Bend', desc: 'Knee angle at plant foot contact', idealRange: [150, 175], idealDesc: '150-175\u00B0' },
  { id: 'trunkRotation', name: 'Trunk Rotation Speed', desc: 'Peak angular velocity of torso', idealDesc: '>800\u00B0/s elite' },
  { id: 'armSlot', name: 'Arm Slot Consistency', desc: 'Variation in release angle across frames', idealDesc: '<5\u00B0 variance' },
  { id: 'followThrough', name: 'Follow-Through Path', desc: 'Wrist path continuity after release', idealDesc: 'Smooth deceleration' },
];

// ==========================================
// State
// ==========================================

let poseData = [];
let angleData = [];
let velocityData = [];
let phaseData = null;
let videoElement = null;
let overlayCanvas = null;
let overlayCtx = null;
let skeletonCanvas = null;
let skeletonCtx = null;
let currentFrame = 0;
let totalFrames = 0;
let fps = 30;
let isPlaying = false;
let playbackSpeed = 1;
let animFrameId = null;
let viewMode = 'overlay';
let activeTab = 'analysis';
let poseLandmarker = null;
let currentBlobUrl = null;
let expandedTile = null;
let splitRatio = 0.5; // For draggable divider

// Processing state machine
const ProcessingState = {
  IDLE: 'idle',
  UPLOADING: 'uploading',
  DETECTING_FPS: 'detecting_fps',
  LOADING_MODEL: 'loading_model',
  ANALYZING: 'analyzing',
  COMPLETE: 'complete',
  ERROR: 'error',
};

let processingState = ProcessingState.IDLE;
let fileGeneration = 0;

let processingMeta = {
  fileName: '',
  fileSize: 0,
  duration: 0,
  detectedFps: null,
  analyzeProgress: 0,
};

// URL entry params (clip / athlete / title), parsed once at boot.
let urlParams = { clip: null, athlete: null, title: null };

// Session metadata (populated by naming modal)
let sessionMetadata = null;
let currentSessionId = null;
let hasLiveVideo = false;
let is3DActive = false;

// DOM refs
let els = {};

// ==========================================
// Initialization
// ==========================================

async function init() {
  // Batch DOM queries
  const ids = [
    'upload-screen', 'analysis-screen', 'error-screen', 'upload-zone',
    'video-input', 'btn-upload', 'btn-camera', 'btn-new-video',
    'btn-export-csv', 'btn-export-json', 'btn-retry', 'video-stage',
    'scrub-slider', 'btn-play', 'btn-prev-frame', 'btn-next-frame',
    'speed-select', 'current-time', 'total-time', 'frame-counter',
    'processing-overlay', 'processing-text', 'progress-fill', 'progress-label',
    'play-icon', 'pause-icon', 'source-video', 'overlay-canvas',
    'skeleton-canvas', 'video-panel', 'skeleton-panel', 'panel-divider',
    'data-tiles-strip', 'tile-detail-panel', 'tile-detail-title',
    'detail-current', 'detail-range', 'detail-peak-max', 'detail-peak-min',
    'detail-velocity', 'btn-close-detail', 'peak-badges',
    'tab-analysis', 'tab-kinematic', 'tab-report',
    'btn-stromotion', 'stromotion-modal', 'stromotion-canvas',
    'btn-close-stromotion', 'btn-download-stromotion', 'btn-export-pdf',
    'density-fps', 'density-frames', 'density-points', 'density-per-sec',
    'density-comparison', 'vel-elbow', 'vel-shoulder', 'vel-hip', 'vel-knee',
    'report-grid', 'report-grade-overall', 'kinematic-chart', 'kinematic-events',
    'error-detail',
    // Phase 1: processing state machine
    'processing-meta', 'meta-filename', 'meta-filesize', 'meta-duration', 'meta-fps',
    'processing-steps',
    // Phase 2: naming modal
    'naming-modal', 'naming-form', 'input-athlete-name', 'input-session-name',
    'input-session-date', 'input-session-notes', 'btn-skip-naming', 'btn-save-naming',
    'tag-selector',
    // Phase 3: zoom
    'btn-zoom-reset',
    // Phase 4-5: sessions
    'sessions-screen', 'sessions-grid', 'sessions-empty',
    'sessions-search', 'btn-sessions-nav', 'btn-view-sessions', 'btn-sessions-back',
  ];

  for (const id of ids) {
    els[id.replace(/-/g, '_')] = document.getElementById(id);
  }

  // Short aliases for frequent use
  videoElement = els.source_video;
  overlayCanvas = els.overlay_canvas;
  overlayCtx = overlayCanvas.getContext('2d');
  skeletonCanvas = els.skeleton_canvas;
  skeletonCtx = skeletonCanvas.getContext('2d');

  setupEventListeners();
  setViewMode('overlay');
  checkForSessions();

  // URL entry point: ?clip=<https url>&athlete=&title=
  // If a clip is present, skip the upload screen and auto-run the pipeline.
  parseUrlParams();
  if (urlParams.clip) {
    // Hide the upload UI immediately so it never flashes.
    els.upload_screen.classList.remove('active');
    loadFromUrl(urlParams.clip, urlParams.title);
  }
}

// Parse query params once. `clip` must be present to auto-run; `athlete`/`title`
// are display/session labels only. We accept absolute https URLs and
// same-origin relative paths (e.g. /analyze/_sample/test.mp4 for testing).
function parseUrlParams() {
  try {
    const q = new URLSearchParams(window.location.search);
    const clip = q.get('clip');
    if (clip) {
      const trimmed = clip.trim();
      // Allow https absolute URLs or same-origin relative paths only. Reject
      // anything else (javascript:, data:, http:) so the entry point can't be
      // abused to point the player at a dangerous source.
      const isHttps = /^https:\/\//i.test(trimmed);
      const isRelative = trimmed.startsWith('/') && !trimmed.startsWith('//');
      if (isHttps || isRelative) {
        urlParams.clip = trimmed;
      } else {
        console.warn('[analyze] ignoring unsupported clip URL scheme:', trimmed);
      }
    }
    urlParams.athlete = q.get('athlete') || null;
    urlParams.title = q.get('title') || null;
  } catch (err) {
    console.warn('[analyze] failed to parse URL params:', err);
  }
}

function setupEventListeners() {
  // Upload
  els.btn_upload.addEventListener('click', (e) => {
    e.stopPropagation();
    els.video_input.removeAttribute('capture');
    els.video_input.click();
  });
  els.btn_camera.addEventListener('click', (e) => {
    e.stopPropagation();
    els.video_input.setAttribute('capture', 'environment');
    els.video_input.click();
  });
  els.video_input.addEventListener('change', handleFileSelect);

  // Drag and drop
  els.upload_zone.addEventListener('click', () => els.video_input.click());
  els.upload_zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.upload_zone.classList.add('dragover');
  });
  els.upload_zone.addEventListener('dragleave', () => els.upload_zone.classList.remove('dragover'));
  els.upload_zone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.upload_zone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
  });

  // View mode buttons
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => setViewMode(btn.dataset.view));
  });

  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Actions
  els.btn_new_video.addEventListener('click', resetToUpload);
  els.btn_export_csv.addEventListener('click', exportCSV);
  els.btn_export_json.addEventListener('click', exportJSON);
  els.btn_export_pdf.addEventListener('click', generatePDFReport);
  els.btn_retry.addEventListener('click', () => {
    els.error_screen.classList.remove('active');
    els.upload_screen.classList.add('active');
  });

  // Sessions
  els.btn_view_sessions.addEventListener('click', showSessionsScreen);
  els.btn_sessions_nav.addEventListener('click', showSessionsScreen);
  els.btn_sessions_back.addEventListener('click', () => {
    els.sessions_screen.classList.remove('active');
    els.upload_screen.classList.add('active');
  });
  els.sessions_search.addEventListener('input', filterSessions);

  // Playback
  els.btn_play.addEventListener('click', togglePlay);
  els.btn_prev_frame.addEventListener('click', () => seekFrame(currentFrame - 1));
  els.btn_next_frame.addEventListener('click', () => seekFrame(currentFrame + 1));
  els.speed_select.addEventListener('change', (e) => {
    playbackSpeed = parseFloat(e.target.value);
    videoElement.playbackRate = playbackSpeed;
  });

  // Scrubber
  els.scrub_slider.addEventListener('input', handleScrub);
  els.scrub_slider.addEventListener('touchstart', () => pausePlayback(), { passive: true });

  // Data tile clicks
  document.querySelectorAll('.data-tile').forEach(tile => {
    tile.addEventListener('click', () => toggleTileDetail(tile.id.replace('tile-', '')));
    tile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleTileDetail(tile.id.replace('tile-', ''));
      }
    });
  });

  // Close detail panel
  els.btn_close_detail.addEventListener('click', closeTileDetail);

  // Peak badge clicks (delegated)
  els.peak_badges.addEventListener('click', (e) => {
    const badge = e.target.closest('.peak-badge');
    if (badge && badge.dataset.frame) {
      seekFrame(parseInt(badge.dataset.frame, 10));
    }
  });

  // Clickable peak values in detail panel
  els.detail_peak_max.addEventListener('click', () => {
    const frame = els.detail_peak_max.dataset.frame;
    if (frame) seekFrame(parseInt(frame, 10));
  });
  els.detail_peak_min.addEventListener('click', () => {
    const frame = els.detail_peak_min.dataset.frame;
    if (frame) seekFrame(parseInt(frame, 10));
  });

  // Stromotion
  els.btn_stromotion.addEventListener('click', generateStromotion);
  els.btn_close_stromotion.addEventListener('click', () => els.stromotion_modal.classList.remove('open'));
  els.btn_download_stromotion.addEventListener('click', downloadStromotion);

  // Panel divider drag
  setupDividerDrag();

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyboard);

  // Resize sync
  window.addEventListener('resize', () => {
    syncCanvasOverlay();
    if (is3DActive) resize3D();
  });
}

// ==========================================
// File Handling
// ==========================================

function handleFileSelect(e) {
  if (e.target.files.length > 0) handleFile(e.target.files[0]);
}

async function handleFile(file) {
  if (!file.type.startsWith('video/')) {
    alert('Please select a video file.');
    return;
  }

  const gen = ++fileGeneration;

  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }

  cleanupZoom();
  processingMeta = { fileName: '', fileSize: 0, duration: 0, detectedFps: null, analyzeProgress: 0 };

  const url = URL.createObjectURL(file);
  currentBlobUrl = url;
  // Local blob, same-origin: no crossOrigin needed.
  videoElement.crossOrigin = null;
  videoElement.src = url;

  setProcessingState(ProcessingState.UPLOADING, { fileName: file.name, fileSize: file.size });

  // Switch to analysis screen so the processing overlay is visible
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  els.analysis_screen.classList.add('active');

  videoElement.addEventListener('loadedmetadata', () => {
    runPipeline({ gen, fileName: file.name, fileSize: file.size });
  }, { once: true });
}

// ==========================================
// URL entry point (CoachTime "Analyze v1")
// ==========================================
//
// When the page is opened with ?clip=<https url>, we skip the upload screen and
// auto-load that clip into the SAME pipeline a manual upload uses. crossOrigin
// must be set BEFORE .src so the pose/canvas reads aren't tainted. If the remote
// host blocks CORS (video errors, or a SecurityError shows up during canvas
// reads), we retry ONCE through the same-origin proxy route.

// Track whether we already fell back to the proxy for the current load attempt,
// so a second failure surfaces an honest error instead of looping.
let urlProxyRetried = false;

async function loadFromUrl(rawUrl, displayName) {
  const gen = ++fileGeneration;

  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }

  cleanupZoom();
  processingMeta = { fileName: '', fileSize: 0, duration: 0, detectedFps: null, analyzeProgress: 0 };

  const fileName = displayName || deriveNameFromUrl(rawUrl);

  setProcessingState(ProcessingState.UPLOADING, { fileName, fileSize: 0 });

  // Show the analysis screen so the processing overlay is visible.
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  els.analysis_screen.classList.add('active');

  // CORS-safe: crossOrigin BEFORE src so frames can be read for pose analysis.
  videoElement.crossOrigin = 'anonymous';

  // One-shot error handler: a cross-origin load failure (CORS/network) fires
  // 'error' on the video. Retry once through the same-origin proxy.
  const onError = () => {
    if (gen !== fileGeneration) return;
    if (!urlProxyRetried) {
      urlProxyRetried = true;
      console.warn('[analyze] direct clip load failed, retrying via same-origin proxy');
      const proxied = '/analyze/proxy?url=' + encodeURIComponent(rawUrl);
      attemptLoad(proxied, fileName, gen, /*isProxy=*/true);
    } else {
      console.error('[analyze] clip load failed after proxy retry');
      setProcessingState(ProcessingState.ERROR);
      showError('Could not load the clip. The video host blocked cross-origin access and the proxy retry also failed.');
    }
  };

  attemptLoad(rawUrl, fileName, gen, /*isProxy=*/false, onError);
}

// Loads a URL into the video element and wires loadedmetadata -> runPipeline.
// On SecurityError during the pipeline (tainted canvas), falls back to proxy.
function attemptLoad(url, fileName, gen, isProxy, onErrorOverride) {
  // Replace any prior error listener for this attempt.
  videoElement.onerror = onErrorOverride || (() => {
    if (gen !== fileGeneration) return;
    console.error('[analyze] proxied clip load failed');
    setProcessingState(ProcessingState.ERROR);
    showError('Could not load the clip even through the proxy. Check that the clip URL is valid.');
  });

  videoElement.addEventListener('loadedmetadata', async () => {
    if (gen !== fileGeneration) return;
    try {
      await runPipeline({ gen, fileName, fileSize: 0 });
    } catch (err) {
      // A tainted-canvas SecurityError means CORS reads were blocked. If we
      // haven't already gone through the proxy, retry once same-origin.
      const isSecurity = err && (err.name === 'SecurityError' ||
        /tainted|cross-origin|securityerror/i.test(String(err.message || err)));
      if (isSecurity && !isProxy && !urlProxyRetried) {
        urlProxyRetried = true;
        console.warn('[analyze] SecurityError during pipeline, retrying via same-origin proxy');
        const proxied = '/analyze/proxy?url=' + encodeURIComponent(deriveOriginalFromVideoSrc(url));
        const retryGen = ++fileGeneration; // invalidate the failed attempt, claim a fresh gen
        attemptLoad(proxied, fileName, retryGen, /*isProxy=*/true);
        return;
      }
      // Not a CORS issue, or we already proxied: surface honestly.
      if (gen !== fileGeneration) return;
      console.error('[analyze] pipeline failed:', err);
      setProcessingState(ProcessingState.ERROR);
      showError(err && err.message ? err.message : 'Analysis failed.');
    }
  }, { once: true });

  videoElement.src = url;
  videoElement.load();
}

function deriveNameFromUrl(u) {
  try {
    const p = new URL(u, window.location.href).pathname;
    const last = p.split('/').filter(Boolean).pop() || 'clip.mp4';
    return decodeURIComponent(last);
  } catch {
    return 'clip.mp4';
  }
}

// When we proxied, the video src is /analyze/proxy?url=ORIGINAL. Pull the
// original back out so a second proxy wrap never happens.
function deriveOriginalFromVideoSrc(maybeProxied) {
  try {
    const u = new URL(maybeProxied, window.location.href);
    if (u.pathname === '/analyze/proxy' && u.searchParams.get('url')) {
      return u.searchParams.get('url');
    }
  } catch { /* fall through */ }
  return maybeProxied;
}

// ==========================================
// Shared post-load pipeline
// ==========================================
// Everything that used to live inside handleFile's loadedmetadata handler.
// Called by BOTH the file-upload path and the URL path so there is exactly ONE
// analysis pipeline. `fileName`/`fileSize` are display + session metadata only.
async function runPipeline({ gen, fileName, fileSize }) {
  if (gen !== fileGeneration) return;

  setProcessingState(ProcessingState.DETECTING_FPS, { duration: videoElement.duration });

  fps = await detectFPS(videoElement);
  if (gen !== fileGeneration) return;

  setProcessingState(ProcessingState.LOADING_MODEL, { detectedFps: fps });

  totalFrames = Math.floor(videoElement.duration * fps);
  els.scrub_slider.max = totalFrames - 1;
  els.total_time.textContent = formatTime(videoElement.duration);

  const vw = videoElement.videoWidth;
  const vh = videoElement.videoHeight;
  overlayCanvas.width = vw;
  overlayCanvas.height = vh;
  skeletonCanvas.width = vw;
  skeletonCanvas.height = vh;

  await loadMediaPipe();
  if (gen !== fileGeneration) return;

  setProcessingState(ProcessingState.ANALYZING);

  // processVideo reads frames into a canvas; a cross-origin tainted source
  // throws SecurityError here. Let it bubble so loadFromUrl can proxy-retry.
  await processVideo();
  if (gen !== fileGeneration) return;

  // ---- No-person / wrong-angle guard (Phase 0) ----------------------------
  // processVideo pushes { landmarks: null } for every frame where MediaPipe
  // found no pose. With zero or sparse detections the downstream math runs on
  // nulls and produces a blank all-dashes F-grade report card, which lies to
  // the user. Count usable frames; if the clip has no athlete (or far too few
  // detected frames to grade), route to the existing ERROR screen instead of
  // completing into a misleading card. Threshold: need landmarks in at least
  // max(3, 10% of frames) — real QB clips track the athlete the whole rep, so
  // this never trips on a valid clip but always catches a wall/empty field.
  const landmarkFrames = poseData.filter(
    (f) => f.landmarks && f.landmarks.length,
  ).length;
  const minLandmarkFrames = Math.max(3, Math.floor(totalFrames * 0.1));
  if (landmarkFrames === 0 || landmarkFrames < minLandmarkFrames) {
    if (gen !== fileGeneration) return;
    console.warn(
      `[analyze] no/sparse athlete detected: ${landmarkFrames}/${totalFrames} frames had landmarks (min ${minLandmarkFrames})`,
    );
    setProcessingState(ProcessingState.ERROR);
    showError(
      "No athlete detected in this clip. Use side-angle footage with the thrower fully in frame and well lit, then try again.",
    );
    return;
  }

  setProcessingState(ProcessingState.COMPLETE);

  computeAllAngles();
  computeAllVelocities();
  detectKeyPhases();

  sessionMetadata = await showNamingModal(fileName);
  if (gen !== fileGeneration) return;

  hasLiveVideo = true;

  showAnalysis();
  setupVideoZoom(els.video_panel, els.btn_zoom_reset);
  updateDataDensityPanel();
  updatePeakBadges();
  drawAngleChart();
  drawKinematicChart();
  generateReportCard();
  seekFrame(0);
  syncCanvasOverlay();

  // Save session to IndexedDB
  try {
    const thumbnail = await captureThumbnail(videoElement);
    currentSessionId = await saveSession({
      fileName,
      fileSize,
      duration: videoElement.duration,
      width: videoElement.videoWidth,
      height: videoElement.videoHeight,
      fps,
      totalFrames,
      athleteName: sessionMetadata?.athleteName || urlParams.athlete || '',
      sessionName: sessionMetadata?.sessionName || urlParams.title || fileName.replace(/\.[^.]+$/, ''),
      tags: sessionMetadata?.tags || [],
      date: sessionMetadata?.date || new Date().toISOString().slice(0, 10),
      notes: sessionMetadata?.notes || '',
      thumbnail,
      poseData,
      angleData,
      velocityData,
      peaks: computePeakSummary(),
    });
    checkForSessions();
  } catch (err) {
    console.warn('Failed to save session:', err);
  }
}

function detectFPS(video) {
  return new Promise((resolve) => {
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      let lastTime = null;
      let diffs = [];
      let count = 0;

      const onFrame = (now, metadata) => {
        if (lastTime !== null) {
          const diff = metadata.mediaTime - lastTime;
          if (diff > 0) diffs.push(diff);
        }
        lastTime = metadata.mediaTime;
        count++;

        if (count < 15) {
          video.requestVideoFrameCallback(onFrame);
        } else {
          video.pause();
          video.currentTime = 0;
          if (diffs.length > 0) {
            const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
            const detected = Math.round(1 / avgDiff);
            const common = [24, 25, 30, 48, 50, 60, 120, 240];
            const closest = common.reduce((prev, curr) =>
              Math.abs(curr - detected) < Math.abs(prev - detected) ? curr : prev
            );
            resolve(closest);
          } else {
            resolve(30);
          }
        }
      };

      video.muted = true;
      video.playbackRate = 2;
      video.requestVideoFrameCallback(onFrame);
      video.play().catch(() => resolve(30));
    } else {
      resolve(30);
    }
  });
}

// ==========================================
// MediaPipe Loading & Processing
// ==========================================

async function loadMediaPipe() {
  // State machine already shows "Loading pose detection model..."

  let PoseLandmarker, FilesetResolver;
  try {
    const module = await import(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs'
    );
    PoseLandmarker = module.PoseLandmarker;
    FilesetResolver = module.FilesetResolver;
  } catch (cdnErr) {
    throw new Error('Could not load MediaPipe from CDN. Check your internet connection. ' + cdnErr.message);
  }

  let vision;
  try {
    vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
    );
  } catch (wasmErr) {
    throw new Error('Could not load MediaPipe WASM files. Check your internet connection. ' + wasmErr.message);
  }

  const modelOptions = {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };

  try {
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, modelOptions);
  } catch (gpuErr) {
    console.warn('GPU delegate failed, falling back to CPU:', gpuErr);
    modelOptions.baseOptions.delegate = 'CPU';
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, modelOptions);
  }
}

async function processVideo() {
  poseData = [];
  const video = videoElement;
  const frameDuration = 1 / fps;

  video.currentTime = 0;
  video.pause();

  for (let i = 0; i < totalFrames; i++) {
    const targetTime = i * frameDuration;
    await seekVideoToTime(video, targetTime);

    try {
      const timestamp = Math.round(targetTime * 1000);
      const result = poseLandmarker.detectForVideo(video, timestamp);
      poseData.push({
        landmarks: result.landmarks?.[0] || null,
        worldLandmarks: result.worldLandmarks?.[0] || null,
        timestamp: targetTime,
      });
    } catch (err) {
      poseData.push({ landmarks: null, worldLandmarks: null, timestamp: targetTime });
    }

    const pct = Math.round(((i + 1) / totalFrames) * 100);
    els.progress_fill.style.width = pct + '%';
    els.progress_fill.setAttribute('aria-valuenow', pct);
    els.progress_label.textContent = `${pct}% (frame ${i + 1}/${totalFrames})`;

    // Show progress bar and label during analysis
    els.progress_fill.parentElement.style.display = '';
    els.progress_label.style.display = '';

    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
  }

  video.currentTime = 0;
}

function seekVideoToTime(video, time) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - time) < 0.001) { resolve(); return; }
    video.currentTime = time;
    video.addEventListener('seeked', () => resolve(), { once: true });
  });
}

// ==========================================
// Signal Smoothing (One-Euro + Savitzky-Golay)
// ==========================================

function smoothLandmarks(frames) {
  // One-Euro filter applied per-landmark, per-axis across all frames.
  // Adapts: smooth when still, responsive during fast motion.
  const minCutoff = 1.0;
  const beta = 0.007;
  const dCutoff = 1.0;

  function smoothingFactor(te, cutoff) {
    const r = 2 * Math.PI * cutoff * te;
    return r / (r + 1);
  }

  const numLandmarks = frames[0]?.landmarks?.length || 0;
  if (numLandmarks === 0) return frames;

  const axes = ['x', 'y', 'z'];
  const prev = new Array(numLandmarks).fill(null).map(() => ({
    x: null, y: null, z: null,
    dx: null, dy: null, dz: null,
  }));

  const result = frames.map((frame, fi) => {
    if (!frame.landmarks) return frame;
    const smoothed = frame.landmarks.map((lm, li) => {
      if (!lm) return lm;
      const out = { ...lm };
      const te = 1 / (fps || 30);
      const p = prev[li];

      for (const ax of axes) {
        const raw = lm[ax] || 0;
        if (p[ax] === null) {
          p[ax] = raw;
          p['d' + ax] = 0;
          out[ax] = raw;
          continue;
        }
        const dVal = (raw - p[ax]) / te;
        const aD = smoothingFactor(te, dCutoff);
        const dSmoothed = aD * dVal + (1 - aD) * p['d' + ax];
        p['d' + ax] = dSmoothed;
        const cutoff = minCutoff + beta * Math.abs(dSmoothed);
        const aVal = smoothingFactor(te, cutoff);
        const filtered = aVal * raw + (1 - aVal) * p[ax];
        p[ax] = filtered;
        out[ax] = filtered;
      }
      return out;
    });
    return { ...frame, landmarks: smoothed };
  });
  return result;
}

function savitzkyGolaySmooth(data, key, windowSize) {
  // Quadratic SG filter (window 5 or 7) on a single angle series.
  // Coefficients for quadratic fit, symmetric window.
  const half = Math.floor(windowSize / 2);
  const values = data.map(d => d?.[key] ?? null);
  const out = [...values];

  for (let i = half; i < values.length - half; i++) {
    let allValid = true;
    const window = [];
    for (let j = -half; j <= half; j++) {
      if (values[i + j] === null) { allValid = false; break; }
      window.push(values[i + j]);
    }
    if (!allValid) continue;
    // Simple weighted average (SG quadratic w=5: [-3,12,17,12,-3]/35)
    if (windowSize === 5) {
      out[i] = Math.round((-3 * window[0] + 12 * window[1] + 17 * window[2] + 12 * window[3] - 3 * window[4]) / 35);
    } else {
      // Fallback: simple moving average
      out[i] = Math.round(window.reduce((s, v) => s + v, 0) / window.length);
    }
  }
  return out;
}

function smoothAngleData() {
  if (angleData.length < 5) return;
  const keys = ['elbow', 'shoulder', 'hip', 'knee', 'release'];
  const smoothed = {};
  for (const key of keys) {
    smoothed[key] = savitzkyGolaySmooth(angleData, key, 5);
  }
  for (let i = 0; i < angleData.length; i++) {
    if (!angleData[i]) continue;
    for (const key of keys) {
      if (smoothed[key][i] !== null) {
        angleData[i][key] = smoothed[key][i];
      }
    }
  }
}

// ==========================================
// Angle Calculations
// ==========================================

function calcAngle(a, b, c) {
  const ba = { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
  const bc = { x: c.x - b.x, y: c.y - b.y, z: (c.z || 0) - (b.z || 0) };
  const dot = ba.x * bc.x + ba.y * bc.y + ba.z * bc.z;
  const magBA = Math.sqrt(ba.x ** 2 + ba.y ** 2 + ba.z ** 2);
  const magBC = Math.sqrt(bc.x ** 2 + bc.y ** 2 + bc.z ** 2);
  if (magBA === 0 || magBC === 0) return 0;
  const cosAngle = Math.max(-1, Math.min(1, dot / (magBA * magBC)));
  return Math.round(Math.acos(cosAngle) * (180 / Math.PI));
}

function detectThrowingSide(landmarks) {
  if (!landmarks) return 'right';
  const lw = landmarks[LANDMARKS.LEFT_WRIST];
  const rw = landmarks[LANDMARKS.RIGHT_WRIST];
  return lw.y < rw.y ? 'left' : 'right';
}

function calculateAngles(landmarks) {
  if (!landmarks) return { elbow: null, shoulder: null, hip: null, knee: null, release: null };

  const side = detectThrowingSide(landmarks);
  const isLeft = side === 'left';

  const shoulder = landmarks[isLeft ? LANDMARKS.LEFT_SHOULDER : LANDMARKS.RIGHT_SHOULDER];
  const elbow = landmarks[isLeft ? LANDMARKS.LEFT_ELBOW : LANDMARKS.RIGHT_ELBOW];
  const wrist = landmarks[isLeft ? LANDMARKS.LEFT_WRIST : LANDMARKS.RIGHT_WRIST];
  const hip = landmarks[isLeft ? LANDMARKS.LEFT_HIP : LANDMARKS.RIGHT_HIP];
  const frontKnee = landmarks[isLeft ? LANDMARKS.RIGHT_KNEE : LANDMARKS.LEFT_KNEE];
  const frontHip = landmarks[isLeft ? LANDMARKS.RIGHT_HIP : LANDMARKS.LEFT_HIP];
  const frontAnkle = landmarks[isLeft ? LANDMARKS.RIGHT_ANKLE : LANDMARKS.LEFT_ANKLE];

  return {
    elbow: calcAngle(shoulder, elbow, wrist),
    shoulder: calcAngle(hip, shoulder, elbow),
    hip: calcHipRotation(landmarks, isLeft),
    knee: calcAngle(frontHip, frontKnee, frontAnkle),
    release: calcReleaseHeight(wrist, shoulder),
  };
}

function calcHipRotation(landmarks, isLeft) {
  const lHip = landmarks[LANDMARKS.LEFT_HIP];
  const rHip = landmarks[LANDMARKS.RIGHT_HIP];
  const lShoulder = landmarks[LANDMARKS.LEFT_SHOULDER];
  const rShoulder = landmarks[LANDMARKS.RIGHT_SHOULDER];

  const hipDx = rHip.x - lHip.x;
  const hipDz = (rHip.z || 0) - (lHip.z || 0);
  const shDx = rShoulder.x - lShoulder.x;
  const shDz = (rShoulder.z || 0) - (lShoulder.z || 0);

  const dot = hipDx * shDx + hipDz * shDz;
  const magH = Math.sqrt(hipDx ** 2 + hipDz ** 2);
  const magS = Math.sqrt(shDx ** 2 + shDz ** 2);
  if (magH === 0 || magS === 0) return 0;

  const cosA = Math.max(-1, Math.min(1, dot / (magH * magS)));
  return Math.round(Math.acos(cosA) * (180 / Math.PI));
}

function calcReleaseHeight(wrist, shoulder) {
  const dy = shoulder.y - wrist.y;
  const dx = Math.abs(wrist.x - shoulder.x);
  const angle = Math.round(Math.atan2(dy, dx) * (180 / Math.PI));
  return Math.max(-90, Math.min(90, angle));
}

function computeAllAngles() {
  const smoothedFrames = smoothLandmarks(poseData);
  angleData = smoothedFrames.map(frame => calculateAngles(frame.landmarks));
  smoothAngleData();
}

function computeAllVelocities() {
  // 5-frame central difference: v[i] = (a[i+2] - a[i-2]) / (4*dt)
  // Much smoother than frame-to-frame delta, captures real motion not noise.
  velocityData = [];
  const dt = 1 / fps;
  const keys = ['elbow', 'shoulder', 'hip', 'knee'];
  const span = 2;

  for (let i = 0; i < angleData.length; i++) {
    const entry = {};
    for (const key of keys) {
      if (i < span || i >= angleData.length - span) { entry[key] = null; continue; }
      const vA = angleData[i - span]?.[key];
      const vB = angleData[i + span]?.[key];
      if (vA === null || vA === undefined || vB === null || vB === undefined) {
        entry[key] = null;
      } else {
        entry[key] = Math.round(Math.abs(vB - vA) / (2 * span * dt));
      }
    }
    velocityData.push(entry);
  }
}

// ==========================================
// Color-Coded Goal Ranges
// ==========================================

function getRangeColor(key, value) {
  if (value === null || value === undefined) return '';
  const range = IDEAL_RANGES[key];
  if (!range) return '';

  if (value >= range.green[0] && value <= range.green[1]) return 'green';
  if (value >= range.yellow[0] && value <= range.yellow[1]) return 'yellow';
  return 'red';
}

// ==========================================
// Drawing
// ==========================================

function drawFrame(frameIdx) {
  if (frameIdx < 0 || frameIdx >= poseData.length) return;

  const data = poseData[frameIdx];
  const landmarks = data?.landmarks;

  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!is3DActive) {
    skeletonCtx.clearRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);
    skeletonCtx.fillStyle = '#000000';
    skeletonCtx.fillRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);
  }

  if (!landmarks) {
    updateTileDisplay(null);
    updateVelocityDisplay(null);
    return;
  }

  const w = overlayCanvas.width;
  const h = overlayCanvas.height;

  if (viewMode === 'overlay' || viewMode === 'sidebyside') {
    drawSkeleton(overlayCtx, landmarks, w, h, true);
  }
  if (viewMode === 'sidebyside' || viewMode === 'skeleton') {
    if (is3DActive) {
      update3DPose(landmarks, data?.worldLandmarks || null);
    } else {
      drawSkeleton(skeletonCtx, landmarks, w, h, false);
    }
  }

  const angles = angleData[frameIdx] || calculateAngles(landmarks);
  updateTileDisplay(angles);

  const vel = velocityData[frameIdx] || null;
  updateVelocityDisplay(vel);

  // Update detail panel if open
  if (expandedTile) updateTileDetailValues(expandedTile, angles, vel);

  if (viewMode === 'skeleton' && !is3DActive) {
    drawAngleAnnotations(skeletonCtx, landmarks, angles, w, h);
  } else if (viewMode !== 'skeleton') {
    drawAngleAnnotations(overlayCtx, landmarks, angles, w, h);
  }

  drawAngleChart(frameIdx);
  if (activeTab === 'kinematic') drawKinematicChart(frameIdx);
}

function drawSkeleton(ctx, landmarks, w, h, isOverlay) {
  if (!landmarks) return;

  ctx.lineWidth = isOverlay ? 3 : 4;
  ctx.lineCap = 'round';

  for (const [i, j] of CONNECTIONS) {
    const a = landmarks[i];
    const b = landmarks[j];
    if (!a || !b) continue;

    ctx.strokeStyle = getConnectionColor(i, j);
    ctx.beginPath();
    ctx.moveTo(a.x * w, a.y * h);
    ctx.lineTo(b.x * w, b.y * h);
    ctx.stroke();
  }

  for (let i = 0; i < landmarks.length; i++) {
    const lm = landmarks[i];
    if (!lm || (i > 0 && i < 11)) continue;

    const x = lm.x * w;
    const y = lm.y * h;
    const radius = isOverlay ? 4 : 6;

    ctx.beginPath();
    ctx.arc(x, y, radius + 1, 0, Math.PI * 2);
    ctx.fillStyle = '#000000';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = getJointColor(i);
    ctx.fill();
  }
}

function getConnectionColor(i, j) {
  const pair = [i, j].sort((a, b) => a - b);
  const key = pair[0] * 100 + pair[1];
  if (key === 1113 || key === 1315) return '#D4C36A';
  if (key === 1214 || key === 1416) return '#D4C36A';
  if (key === 2325 || key === 2527) return '#4488ff';
  if (key === 2426 || key === 2628) return '#4488ff';
  if (pair[0] === 0) return '#999999';
  return '#ffffff';
}

function getJointColor(i) {
  if ([13, 14, 15, 16].includes(i)) return '#D4C36A';
  if ([25, 26, 27, 28].includes(i)) return '#4488ff';
  if ([11, 12, 23, 24].includes(i)) return '#ffffff';
  return '#999999';
}

function drawAngleAnnotations(ctx, landmarks, angles, w, h) {
  if (!landmarks || !angles) return;

  const side = detectThrowingSide(landmarks);
  const isLeft = side === 'left';

  ctx.font = '600 13px Inter, sans-serif';
  ctx.textAlign = 'center';

  if (angles.elbow !== null) {
    const elbow = landmarks[isLeft ? LANDMARKS.LEFT_ELBOW : LANDMARKS.RIGHT_ELBOW];
    const color = getRangeColor('elbow', angles.elbow);
    drawAngleLabel(ctx, elbow.x * w, elbow.y * h - 20, `${angles.elbow}\u00B0`, colorForRange(color));
  }

  if (angles.shoulder !== null) {
    const shoulder = landmarks[isLeft ? LANDMARKS.LEFT_SHOULDER : LANDMARKS.RIGHT_SHOULDER];
    const color = getRangeColor('shoulder', angles.shoulder);
    drawAngleLabel(ctx, shoulder.x * w, shoulder.y * h - 20, `${angles.shoulder}\u00B0`, colorForRange(color));
  }

  if (angles.knee !== null) {
    const knee = landmarks[isLeft ? LANDMARKS.RIGHT_KNEE : LANDMARKS.LEFT_KNEE];
    const color = getRangeColor('knee', angles.knee);
    drawAngleLabel(ctx, knee.x * w, knee.y * h - 20, `${angles.knee}\u00B0`, colorForRange(color));
  }
}

function colorForRange(rangeColor) {
  if (rangeColor === 'green') return '#44cc44';
  if (rangeColor === 'yellow') return '#ffcc00';
  if (rangeColor === 'red') return '#ff4444';
  return '#ffffff';
}

function drawAngleLabel(ctx, x, y, text, color) {
  const metrics = ctx.measureText(text);
  const pad = 5;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  const rw = metrics.width + pad * 2;
  const rh = 20;
  const rx = x - rw / 2;
  const ry = y - 13;

  // Rounded rect background
  ctx.beginPath();
  ctx.roundRect(rx, ry, rw, rh, 4);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// ==========================================
// Tile Display (OnForm style)
// ==========================================

function updateTileDisplay(angles) {
  const keys = ['elbow', 'shoulder', 'hip', 'knee', 'release'];
  for (const key of keys) {
    const valueEl = document.getElementById(`tile-value-${key}`);
    const indicatorEl = document.getElementById(`tile-indicator-${key}`);
    if (!valueEl) continue;

    const val = angles?.[key];
    valueEl.textContent = val !== null && val !== undefined ? val : '--';

    // Color coding
    const color = getRangeColor(key, val);
    valueEl.className = 'tile-value' + (color ? ' ' + color : '');
    indicatorEl.className = 'tile-indicator' + (color ? ' ' + color : '');
  }
}

function updateVelocityDisplay(vel) {
  els.vel_elbow.textContent = vel?.elbow ?? '--';
  els.vel_shoulder.textContent = vel?.shoulder ?? '--';
  els.vel_hip.textContent = vel?.hip ?? '--';
  els.vel_knee.textContent = vel?.knee ?? '--';
}

// ==========================================
// Tile Detail Panel
// ==========================================

function toggleTileDetail(key) {
  if (expandedTile === key) {
    closeTileDetail();
    return;
  }

  expandedTile = key;
  const range = IDEAL_RANGES[key];

  // Update title
  els.tile_detail_title.textContent = range?.label || key;

  // Update range
  els.detail_range.textContent = range ? `${range.green[0]}-${range.green[1]}${range.unit}` : '--';

  // Find peaks
  const peaks = findPeaks(key);
  els.detail_peak_max.textContent = peaks.max !== null ? `${peaks.max}\u00B0 (frame ${peaks.maxFrame + 1})` : '--';
  els.detail_peak_max.dataset.frame = peaks.maxFrame;
  els.detail_peak_min.textContent = peaks.min !== null ? `${peaks.min}\u00B0 (frame ${peaks.minFrame + 1})` : '--';
  els.detail_peak_min.dataset.frame = peaks.minFrame;

  // Current values
  const angles = angleData[currentFrame];
  const vel = velocityData[currentFrame];
  updateTileDetailValues(key, angles, vel);

  // Visual state
  document.querySelectorAll('.data-tile').forEach(t => t.classList.remove('expanded'));
  const tileEl = document.getElementById(`tile-${key}`);
  if (tileEl) tileEl.classList.add('expanded');

  els.tile_detail_panel.classList.add('open');
}

function updateTileDetailValues(key, angles, vel) {
  const val = angles?.[key];
  const color = getRangeColor(key, val);
  els.detail_current.textContent = val !== null && val !== undefined ? `${val}\u00B0` : '--';
  els.detail_current.style.color = colorForRange(color);

  const velKey = key === 'release' ? null : key;
  els.detail_velocity.textContent = velKey && vel?.[velKey] !== null ? `${vel[velKey]}\u00B0/s` : '--';
}

function closeTileDetail() {
  expandedTile = null;
  els.tile_detail_panel.classList.remove('open');
  document.querySelectorAll('.data-tile').forEach(t => t.classList.remove('expanded'));
}

function findPeaks(key) {
  let min = Infinity, max = -Infinity, minFrame = 0, maxFrame = 0;
  for (let i = 0; i < angleData.length; i++) {
    const val = angleData[i]?.[key];
    if (val === null || val === undefined) continue;
    if (val > max) { max = val; maxFrame = i; }
    if (val < min) { min = val; minFrame = i; }
  }
  if (max === -Infinity) return { min: null, max: null, minFrame: 0, maxFrame: 0 };
  return { min, max, minFrame, maxFrame };
}

// ==========================================
// Peak Badges (Clickable)
// ==========================================

function updatePeakBadges() {
  const container = els.peak_badges;
  if (!container || angleData.length === 0) return;

  const keys = [
    { key: 'elbow', label: 'Elbow Max' },
    { key: 'shoulder', label: 'Shoulder Max' },
    { key: 'hip', label: 'Hip Sep. Max' },
    { key: 'knee', label: 'Knee Max' },
  ];

  let html = '';
  for (const k of keys) {
    const peaks = findPeaks(k.key);
    if (peaks.max === null) continue;
    html += `<span class="peak-badge" data-frame="${peaks.maxFrame}" tabindex="0" role="button" aria-label="Jump to ${k.label} at frame ${peaks.maxFrame + 1}">
      <span class="badge-label">${k.label}</span>
      <span class="badge-value">${peaks.max}\u00B0</span>
    </span>`;
  }

  // Peak velocities
  const velKeys = [
    { key: 'elbow', label: 'Elbow Vel.' },
    { key: 'hip', label: 'Hip Vel.' },
  ];
  for (const vk of velKeys) {
    let max = 0, maxFrame = 0;
    for (let i = 0; i < velocityData.length; i++) {
      const val = velocityData[i]?.[vk.key];
      if (val !== null && val !== undefined && val > max) { max = val; maxFrame = i; }
    }
    if (max > 0) {
      html += `<span class="peak-badge" data-frame="${maxFrame}" tabindex="0" role="button" aria-label="Jump to ${vk.label} peak at frame ${maxFrame + 1}">
        <span class="badge-label">${vk.label}</span>
        <span class="badge-value">${max}\u00B0/s</span>
      </span>`;
    }
  }

  container.innerHTML = html;

  // Keyboard support for badges
  container.querySelectorAll('.peak-badge').forEach(badge => {
    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (badge.dataset.frame) seekFrame(parseInt(badge.dataset.frame, 10));
      }
    });
  });
}

// ==========================================
// Canvas Overlay Alignment
// ==========================================

function syncCanvasOverlay() {
  if (!videoElement || !overlayCanvas) return;

  const videoPanel = els.video_panel;
  if (!videoPanel || videoPanel.style.display === 'none') return;

  const vw = videoElement.videoWidth;
  const vh = videoElement.videoHeight;
  if (!vw || !vh) return;

  const rect = videoElement.getBoundingClientRect();
  const panelRect = videoPanel.getBoundingClientRect();
  const videoAspect = vw / vh;
  const containerAspect = rect.width / rect.height;

  let renderedWidth, renderedHeight, offsetX, offsetY;

  if (videoAspect > containerAspect) {
    renderedWidth = rect.width;
    renderedHeight = rect.width / videoAspect;
    offsetX = 0;
    offsetY = (rect.height - renderedHeight) / 2;
  } else {
    renderedHeight = rect.height;
    renderedWidth = rect.height * videoAspect;
    offsetX = (rect.width - renderedWidth) / 2;
    offsetY = 0;
  }

  overlayCanvas.style.position = 'absolute';
  overlayCanvas.style.width = renderedWidth + 'px';
  overlayCanvas.style.height = renderedHeight + 'px';
  overlayCanvas.style.left = (rect.left - panelRect.left + offsetX) + 'px';
  overlayCanvas.style.top = (rect.top - panelRect.top + offsetY) + 'px';
}

// ==========================================
// Panel Divider (Draggable Split)
// ==========================================

function setupDividerDrag() {
  const divider = els.panel_divider;
  let isDragging = false;

  const onMove = (e) => {
    if (!isDragging) return;
    const stage = els.video_stage;
    const rect = stage.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const ratio = (clientX - rect.left) / rect.width;
    splitRatio = Math.max(0.2, Math.min(0.8, ratio));
    applyDividerSplit();
  };

  const onEnd = () => {
    isDragging = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
  });

  divider.addEventListener('touchstart', (e) => {
    isDragging = true;
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd);
  }, { passive: true });

  // Keyboard support
  divider.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { splitRatio = Math.max(0.2, splitRatio - 0.05); applyDividerSplit(); }
    if (e.key === 'ArrowRight') { splitRatio = Math.min(0.8, splitRatio + 0.05); applyDividerSplit(); }
  });
}

function applyDividerSplit() {
  if (viewMode !== 'sidebyside') return;
  els.video_panel.style.flex = `0 0 ${splitRatio * 100}%`;
  els.skeleton_panel.style.flex = `0 0 ${(1 - splitRatio) * 100 - 1}%`;
  requestAnimationFrame(syncCanvasOverlay);
}

// ==========================================
// Angle-Over-Time Chart
// ==========================================

function drawAngleChart(playheadFrame) {
  const chartCanvas = document.getElementById('angle-chart');
  if (!chartCanvas || angleData.length === 0) return;

  const ctx = chartCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const displayWidth = chartCanvas.parentElement.clientWidth - 32;
  const displayHeight = 220;
  chartCanvas.style.width = displayWidth + 'px';
  chartCanvas.style.height = displayHeight + 'px';
  chartCanvas.width = displayWidth * dpr;
  chartCanvas.height = displayHeight * dpr;
  ctx.scale(dpr, dpr);

  const pad = { top: 20, right: 20, bottom: 35, left: 45 };
  const plotW = displayWidth - pad.left - pad.right;
  const plotH = displayHeight - pad.top - pad.bottom;

  ctx.clearRect(0, 0, displayWidth, displayHeight);
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, displayWidth, displayHeight);

  // Grid
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  for (let deg = 0; deg <= 180; deg += 45) {
    const y = pad.top + plotH - (deg / 180) * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillStyle = '#555555';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(deg + '\u00B0', pad.left - 6, y + 3);
  }

  // X axis
  ctx.textAlign = 'center';
  const totalSec = totalFrames / fps;
  const xSteps = Math.min(10, Math.floor(totalSec));
  for (let s = 0; s <= totalSec; s += Math.max(0.5, Math.floor(totalSec / xSteps))) {
    const x = pad.left + (s / totalSec) * plotW;
    ctx.fillStyle = '#555555';
    ctx.fillText(s.toFixed(1) + 's', x, pad.top + plotH + 18);
  }

  // Series
  const series = [
    { key: 'elbow', color: '#D4C36A' },
    { key: 'shoulder', color: '#ffffff' },
    { key: 'hip', color: '#ff4444' },
    { key: 'knee', color: '#4488ff' },
  ];

  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;

    for (let i = 0; i < angleData.length; i++) {
      const val = angleData[i]?.[s.key];
      if (val === null || val === undefined) { started = false; continue; }

      const x = pad.left + (i / (angleData.length - 1)) * plotW;
      const y = pad.top + plotH - (Math.min(val, 180) / 180) * plotH;

      if (!started) { ctx.moveTo(x, y); started = true; }
      else { ctx.lineTo(x, y); }
    }
    ctx.stroke();
  }

  // Playhead
  if (playheadFrame !== undefined && playheadFrame >= 0 && angleData.length > 1) {
    const px = pad.left + (playheadFrame / (angleData.length - 1)) * plotW;
    ctx.strokeStyle = '#D4C36A';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, pad.top);
    ctx.lineTo(px, pad.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ==========================================
// Kinematic Sequence Chart (Mustard style)
// ==========================================

function drawKinematicChart(playheadFrame) {
  const chartCanvas = els.kinematic_chart;
  if (!chartCanvas || velocityData.length === 0) return;

  const ctx = chartCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const displayWidth = chartCanvas.parentElement.clientWidth - 32;
  const displayHeight = 280;
  chartCanvas.style.width = displayWidth + 'px';
  chartCanvas.style.height = displayHeight + 'px';
  chartCanvas.width = displayWidth * dpr;
  chartCanvas.height = displayHeight * dpr;
  ctx.scale(dpr, dpr);

  const pad = { top: 20, right: 20, bottom: 35, left: 50 };
  const plotW = displayWidth - pad.left - pad.right;
  const plotH = displayHeight - pad.top - pad.bottom;

  ctx.clearRect(0, 0, displayWidth, displayHeight);
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, displayWidth, displayHeight);

  // Find max velocity for Y scale
  let maxVel = 100;
  for (const v of velocityData) {
    for (const key of ['hip', 'shoulder', 'elbow', 'knee']) {
      if (v?.[key] !== null && v?.[key] > maxVel) maxVel = v[key];
    }
  }
  maxVel = Math.ceil(maxVel / 100) * 100;

  // Y grid
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  const ySteps = 5;
  for (let i = 0; i <= ySteps; i++) {
    const val = Math.round((maxVel / ySteps) * i);
    const y = pad.top + plotH - (i / ySteps) * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillStyle = '#555555';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(val + '\u00B0/s', pad.left - 6, y + 3);
  }

  // X axis labels
  ctx.textAlign = 'center';
  const totalSec = totalFrames / fps;
  const xSteps = Math.min(10, Math.floor(totalSec));
  for (let s = 0; s <= totalSec; s += Math.max(0.5, Math.floor(totalSec / xSteps))) {
    const x = pad.left + (s / totalSec) * plotW;
    ctx.fillStyle = '#555555';
    ctx.fillText(s.toFixed(1) + 's', x, pad.top + plotH + 18);
  }

  // Series: hips (red), shoulders (green), throwing arm/elbow (blue), wrist approximation via knee (gold)
  const kinSeries = [
    { key: 'hip', color: '#ff4444', label: 'Hips' },
    { key: 'shoulder', color: '#44cc44', label: 'Shoulders' },
    { key: 'elbow', color: '#4488ff', label: 'Throwing Arm' },
    { key: 'knee', color: '#D4C36A', label: 'Wrist (approx)' },
  ];

  for (const s of kinSeries) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;

    for (let i = 0; i < velocityData.length; i++) {
      const val = velocityData[i]?.[s.key];
      if (val === null || val === undefined) { started = false; continue; }

      const x = pad.left + (i / (velocityData.length - 1)) * plotW;
      const y = pad.top + plotH - (Math.min(val, maxVel) / maxVel) * plotH;

      if (!started) { ctx.moveTo(x, y); started = true; }
      else { ctx.lineTo(x, y); }
    }
    ctx.stroke();
  }

  // Find peak velocity frames for event markers
  const events = [];
  for (const s of kinSeries) {
    let peakVal = 0, peakFrame = 0;
    for (let i = 0; i < velocityData.length; i++) {
      const val = velocityData[i]?.[s.key];
      if (val !== null && val !== undefined && val > peakVal) { peakVal = val; peakFrame = i; }
    }
    if (peakVal > 0) {
      events.push({ label: s.label + ' peak', frame: peakFrame, color: s.color });
    }
  }

  // Draw event markers (vertical dotted lines)
  for (const ev of events) {
    const x = pad.left + (ev.frame / (velocityData.length - 1)) * plotW;
    ctx.strokeStyle = ev.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Playhead
  if (playheadFrame !== undefined && playheadFrame >= 0 && velocityData.length > 1) {
    const px = pad.left + (playheadFrame / (velocityData.length - 1)) * plotW;
    ctx.strokeStyle = '#D4C36A';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, pad.top);
    ctx.lineTo(px, pad.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Update kinematic events list
  updateKinematicEvents(events);
}

function updateKinematicEvents(events) {
  const container = els.kinematic_events;
  if (!container) return;

  let html = '';
  // Sort by frame order
  events.sort((a, b) => a.frame - b.frame);
  for (const ev of events) {
    const time = (ev.frame / fps).toFixed(2);
    html += `<span class="kinematic-event" data-frame="${ev.frame}" tabindex="0" role="button" aria-label="Jump to ${ev.label}">
      <span class="event-label">${ev.label}</span>
      <span class="event-frame">@ ${time}s</span>
    </span>`;
  }
  container.innerHTML = html;

  container.querySelectorAll('.kinematic-event').forEach(el => {
    el.addEventListener('click', () => seekFrame(parseInt(el.dataset.frame, 10)));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        seekFrame(parseInt(el.dataset.frame, 10));
      }
    });
  });
}

// ==========================================
// Report Card
// ==========================================

function generateReportCard() {
  const container = els.report_grid;
  if (!container || angleData.length === 0) return;

  const scores = [];

  for (const cat of REPORT_CATEGORIES) {
    const score = calculateCategoryScore(cat);
    scores.push({ ...cat, ...score });
  }

  // Overall
  const validScores = scores.filter(s => s.score !== null);
  const avgScore = validScores.length > 0
    ? Math.round(validScores.reduce((sum, s) => sum + s.score, 0) / validScores.length)
    : 0;

  els.report_grade_overall.textContent = letterGrade(avgScore);
  els.report_grade_overall.style.color = gradeColor(avgScore);

  let html = '';
  for (const s of scores) {
    const grade = letterGrade(s.score ?? 0);
    const gradeClass = s.score >= 7 ? 'grade-green' : s.score >= 4 ? 'grade-yellow' : 'grade-red';
    const barColor = s.score >= 7 ? 'var(--green)' : s.score >= 4 ? 'var(--yellow)' : 'var(--red)';
    const pct = ((s.score ?? 0) / 10) * 100;

    html += `<div class="report-card">
      <div class="report-card-grade ${gradeClass}">${grade}</div>
      <div class="report-card-body">
        <div class="report-card-name">${s.name}</div>
        <div class="report-card-score">${s.score !== null ? s.score : '--'}/10 | ${s.value ?? 'N/A'}</div>
        <div class="report-card-bar"><div class="report-card-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
        <div class="report-card-detail">Ideal: ${s.idealDesc} | ${s.desc}</div>
      </div>
    </div>`;
  }

  container.innerHTML = html;
}

function calculateCategoryScore(cat) {
  switch (cat.id) {
    case 'hipShoulder': {
      const peaks = findPeaks('hip');
      if (peaks.max === null) return { score: null, value: 'N/A' };
      const score = scoreInRange(peaks.max, cat.idealRange[0], cat.idealRange[1], 10, 80);
      return { score, value: `${peaks.max}\u00B0` };
    }
    case 'elbowRelease': {
      const releaseElbow = phaseData?.metrics?.release?.elbow;
      if (releaseElbow === null || releaseElbow === undefined) return { score: null, value: 'N/A' };
      const score = scoreInRange(releaseElbow, cat.idealRange[0], cat.idealRange[1], 0, 120);
      return { score, value: `${releaseElbow}\u00B0` };
    }
    case 'frontKnee': {
      const kneeAtStrike = phaseData?.metrics?.footStrike?.leadKnee;
      if (kneeAtStrike === null || kneeAtStrike === undefined) {
        const peaks = findPeaks('knee');
        if (peaks.max === null) return { score: null, value: 'N/A' };
        const score = scoreInRange(peaks.max, cat.idealRange[0], cat.idealRange[1], 100, 180);
        return { score, value: `${peaks.max}\u00B0` };
      }
      const score = scoreInRange(kneeAtStrike, cat.idealRange[0], cat.idealRange[1], 100, 180);
      return { score, value: `${kneeAtStrike}\u00B0` };
    }
    case 'releaseTime': {
      if (!phaseData || phaseData.releaseTimeMs === null) return { score: null, value: 'N/A' };
      const ms = phaseData.releaseTimeMs;
      let score;
      if (ms <= 380) score = 10;
      else if (ms <= 400) score = 9;
      else if (ms <= 425) score = 7;
      else if (ms <= 450) score = 5;
      else if (ms <= 500) score = 3;
      else score = 1;
      return { score, value: `${ms}ms` };
    }
    case 'strideLength': {
      const phasePct = phaseData?.metrics?.footStrike?.strideLengthPct;
      if (phasePct !== null && phasePct !== undefined) {
        const score = scoreInRange(phasePct, 60, 80, 30, 110);
        return { score, value: `${phasePct}% height` };
      }
      return { score: null, value: 'N/A' };
    }
    case 'trunkRotation': {
      const peakTorsoVel = phaseData?.metrics?.sequencing?.peakShoulderVel ?? 0;
      const score = peakTorsoVel >= 800 ? 10 : peakTorsoVel >= 650 ? 8 : peakTorsoVel >= 400 ? 6 : peakTorsoVel >= 200 ? 4 : peakTorsoVel > 0 ? 2 : null;
      return { score, value: peakTorsoVel > 0 ? `${peakTorsoVel}\u00B0/s` : 'N/A' };
    }
    case 'armSlot': {
      // Variance of release height across frames where wrist is above shoulder
      const releases = [];
      for (let i = 0; i < angleData.length; i++) {
        if (angleData[i]?.release !== null && angleData[i].release > 10) {
          releases.push(angleData[i].release);
        }
      }
      if (releases.length < 3) return { score: null, value: 'N/A' };
      const mean = releases.reduce((a, b) => a + b, 0) / releases.length;
      const variance = Math.sqrt(releases.reduce((sum, v) => sum + (v - mean) ** 2, 0) / releases.length);
      const rounded = Math.round(variance * 10) / 10;
      const score = variance < 3 ? 10 : variance < 5 ? 8 : variance < 8 ? 6 : variance < 12 ? 4 : 2;
      return { score, value: `\u00B1${rounded}\u00B0` };
    }
    case 'followThrough': {
      // Check for smooth deceleration of elbow velocity after peak
      let peakVelFrame = 0, peakVel = 0;
      for (let i = 0; i < velocityData.length; i++) {
        if (velocityData[i]?.elbow > peakVel) { peakVel = velocityData[i].elbow; peakVelFrame = i; }
      }
      if (peakVel === 0) return { score: null, value: 'N/A' };

      // Check frames after peak
      let smooth = true;
      let consecutiveIncrease = 0;
      for (let i = peakVelFrame + 1; i < Math.min(velocityData.length, peakVelFrame + 10); i++) {
        if (velocityData[i]?.elbow > velocityData[i - 1]?.elbow) {
          consecutiveIncrease++;
          if (consecutiveIncrease >= 3) { smooth = false; break; }
        } else {
          consecutiveIncrease = 0;
        }
      }
      const score = smooth ? 8 : 5;
      return { score, value: smooth ? 'Smooth' : 'Choppy' };
    }
    default:
      return { score: null, value: 'N/A' };
  }
}

function scoreInRange(val, idealMin, idealMax, absMin, absMax) {
  if (val >= idealMin && val <= idealMax) return 10;
  // Distance from ideal range
  const dist = val < idealMin ? idealMin - val : val - idealMax;
  const range = val < idealMin ? idealMin - absMin : absMax - idealMax;
  if (range <= 0) return 5;
  const pct = 1 - Math.min(dist / range, 1);
  return Math.max(1, Math.round(pct * 9));
}

function letterGrade(score) {
  if (score >= 9) return 'A';
  if (score >= 7) return 'B';
  if (score >= 5) return 'C';
  if (score >= 3) return 'D';
  return 'F';
}

function gradeColor(score) {
  if (score >= 7) return '#44cc44';
  if (score >= 4) return '#ffcc00';
  return '#ff4444';
}

// ==========================================
// Stromotion Composite
// ==========================================

function generateStromotion() {
  if (poseData.length === 0) return;

  const canvas = els.stromotion_canvas;
  const ctx = canvas.getContext('2d');

  const vw = videoElement.videoWidth;
  const vh = videoElement.videoHeight;
  canvas.width = vw;
  canvas.height = vh;

  // Black background
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, vw, vh);

  // Pick 6-8 key frames evenly across the motion
  const numFrames = Math.min(8, totalFrames);
  const step = Math.floor(totalFrames / numFrames);
  const frames = [];
  for (let i = 0; i < numFrames; i++) {
    frames.push(Math.min(i * step, totalFrames - 1));
  }

  // Draw each skeleton with decreasing opacity
  for (let fi = 0; fi < frames.length; fi++) {
    const frameIdx = frames[fi];
    const landmarks = poseData[frameIdx]?.landmarks;
    if (!landmarks) continue;

    const alpha = 0.3 + (fi / frames.length) * 0.7;
    ctx.globalAlpha = alpha;

    // Color shifts through gold spectrum
    const hue = 40 + (fi / frames.length) * 20;
    const sat = 60 + (fi / frames.length) * 30;

    // Draw connections
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const [i, j] of CONNECTIONS) {
      const a = landmarks[i];
      const b = landmarks[j];
      if (!a || !b) continue;
      ctx.strokeStyle = `hsl(${hue}, ${sat}%, ${50 + fi * 5}%)`;
      ctx.beginPath();
      ctx.moveTo(a.x * vw, a.y * vh);
      ctx.lineTo(b.x * vw, b.y * vh);
      ctx.stroke();
    }

    // Draw joints
    for (let k = 0; k < landmarks.length; k++) {
      const lm = landmarks[k];
      if (!lm || (k > 0 && k < 11)) continue;
      ctx.beginPath();
      ctx.arc(lm.x * vw, lm.y * vh, 4, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${hue}, ${sat}%, ${60 + fi * 5}%)`;
      ctx.fill();
    }
  }

  ctx.globalAlpha = 1;

  // Title overlay
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, vh - 40, vw, 40);
  ctx.fillStyle = '#D4C36A';
  ctx.font = '600 14px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('QB Motion Capture | QB Stable', 12, vh - 16);

  els.stromotion_modal.classList.add('open');
}

function downloadStromotion() {
  const canvas = els.stromotion_canvas;
  const link = document.createElement('a');
  link.download = 'qb-stromotion.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
}

// ==========================================
// Data Density Panel
// ==========================================

function updateDataDensityPanel() {
  if (!els.density_fps) return;

  els.density_fps.textContent = fps + ' fps';
  els.density_frames.textContent = totalFrames.toLocaleString();

  const pointsPerFrame = 33 * 3;
  const totalPoints = totalFrames * pointsPerFrame;
  els.density_points.textContent = totalPoints.toLocaleString();
  els.density_per_sec.textContent = (fps * pointsPerFrame).toLocaleString();

  if (fps > 30) {
    els.density_comparison.textContent = `${fps}fps = ${(fps / 30).toFixed(1)}x more data than 30fps baseline`;
  } else if (fps === 30) {
    els.density_comparison.textContent = '30fps = baseline capture rate';
  } else {
    els.density_comparison.textContent = `${fps}fps. Consider recording at higher frame rate for more detail.`;
  }
}

// ==========================================
// Data Export
// ==========================================

function exportCSV() {
  if (poseData.length === 0) return;

  let headers = ['frame', 'timestamp'];
  for (const name of LANDMARK_NAMES) {
    headers.push(`${name}_x`, `${name}_y`, `${name}_z`);
  }
  headers.push('elbow_angle', 'shoulder_angle', 'hip_rotation', 'knee_angle', 'release_height');
  headers.push('elbow_vel_deg_s', 'shoulder_vel_deg_s', 'hip_vel_deg_s', 'knee_vel_deg_s');

  let csv = headers.join(',') + '\n';

  for (let i = 0; i < poseData.length; i++) {
    const row = [i, poseData[i].timestamp.toFixed(4)];
    const lm = poseData[i].landmarks;
    for (let j = 0; j < 33; j++) {
      if (lm && lm[j]) {
        row.push(lm[j].x.toFixed(6), lm[j].y.toFixed(6), (lm[j].z || 0).toFixed(6));
      } else {
        row.push('', '', '');
      }
    }
    const a = angleData[i] || {};
    row.push(a.elbow ?? '', a.shoulder ?? '', a.hip ?? '', a.knee ?? '', a.release ?? '');
    const v = velocityData[i] || {};
    row.push(v.elbow ?? '', v.shoulder ?? '', v.hip ?? '', v.knee ?? '');
    csv += row.join(',') + '\n';
  }

  downloadFile(csv, 'qb-motion-capture.csv', 'text/csv');
}

function exportJSON() {
  if (poseData.length === 0) return;

  const exportData = {
    metadata: {
      fps, totalFrames,
      duration: totalFrames / fps,
      totalDataPoints: totalFrames * 33 * 3,
      exportedAt: new Date().toISOString(),
      tool: 'QB Motion Capture by QB Stable',
    },
    frames: poseData.map((frame, i) => {
      const landmarks = {};
      if (frame.landmarks) {
        for (let j = 0; j < Math.min(frame.landmarks.length, 33); j++) {
          landmarks[LANDMARK_NAMES[j]] = {
            x: frame.landmarks[j].x,
            y: frame.landmarks[j].y,
            z: frame.landmarks[j].z || 0,
          };
        }
      }
      return { frame: i, timestamp: frame.timestamp, landmarks, angles: angleData[i] || null, angularVelocity: velocityData[i] || null };
    }),
    peaks: computePeakSummary(),
  };

  downloadFile(JSON.stringify(exportData, null, 2), 'qb-motion-capture.json', 'application/json');
}

function computePeakSummary() {
  const keys = ['elbow', 'shoulder', 'hip', 'knee', 'release'];
  const peaks = {};

  for (const key of keys) {
    const p = findPeaks(key);
    if (p.max !== null) peaks[key] = p;
  }

  peaks.velocity = {};
  for (const key of ['elbow', 'shoulder', 'hip', 'knee']) {
    let max = 0, maxFrame = 0;
    for (let i = 0; i < velocityData.length; i++) {
      const val = velocityData[i]?.[key];
      if (val !== null && val !== undefined && val > max) { max = val; maxFrame = i; }
    }
    if (max > 0) peaks.velocity[key] = { peak: max, frame: maxFrame };
  }

  return peaks;
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ==========================================
// Playback Controls
// ==========================================

function seekFrame(frame) {
  frame = Math.max(0, Math.min(totalFrames - 1, frame));
  currentFrame = frame;

  const time = frame / fps;
  videoElement.currentTime = time;

  els.scrub_slider.value = frame;
  els.current_time.textContent = formatTime(time);
  els.frame_counter.textContent = `Frame: ${frame + 1} / ${totalFrames}`;

  drawFrame(frame);
}

function handleScrub() {
  seekFrame(parseInt(els.scrub_slider.value, 10));
}

function togglePlay() {
  if (isPlaying) pausePlayback();
  else startPlayback();
}

function startPlayback() {
  if (currentFrame >= totalFrames - 1) currentFrame = 0;

  isPlaying = true;
  els.play_icon.style.display = 'none';
  els.pause_icon.style.display = 'block';

  videoElement.playbackRate = playbackSpeed;
  videoElement.play().catch(() => {});

  let lastTime = performance.now();

  function tick(now) {
    if (!isPlaying) return;
    const frameDuration = 1000 / (fps * playbackSpeed);
    const elapsed = now - lastTime;
    if (elapsed >= frameDuration) {
      lastTime = now - (elapsed % frameDuration);
      currentFrame++;
      if (currentFrame >= totalFrames) { pausePlayback(); return; }
      els.scrub_slider.value = currentFrame;
      els.current_time.textContent = formatTime(currentFrame / fps);
      els.frame_counter.textContent = `Frame: ${currentFrame + 1} / ${totalFrames}`;
      drawFrame(currentFrame);
    }
    animFrameId = requestAnimationFrame(tick);
  }

  animFrameId = requestAnimationFrame(tick);
}

function pausePlayback() {
  isPlaying = false;
  els.play_icon.style.display = 'block';
  els.pause_icon.style.display = 'none';
  videoElement.pause();
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
}

// ==========================================
// View Modes & Tabs
// ==========================================

function setViewMode(mode) {
  viewMode = mode;

  cleanupZoom();
  if (mode === 'overlay' || mode === 'sidebyside') {
    setupVideoZoom(els.video_panel, els.btn_zoom_reset);
  }

  document.querySelectorAll('.view-btn').forEach(btn => {
    const active = btn.dataset.view === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active);
  });

  els.video_stage.className = 'video-stage ' + mode + '-mode';

  if (mode === 'sidebyside') {
    applyDividerSplit();
  } else {
    els.video_panel.style.flex = '';
    els.skeleton_panel.style.flex = '';
  }

  // 3D mannequin disabled - 2D stick figure is cleaner for mechanics analysis

  if (poseData.length > 0) {
    drawFrame(currentFrame);
    requestAnimationFrame(syncCanvasOverlay);
  }
}

function switchTab(tab) {
  activeTab = tab;

  document.querySelectorAll('.tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active);
  });

  ['analysis', 'kinematic', 'report'].forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.classList.toggle('hidden', t !== tab);
  });

  // Redraw charts when switching to their tab
  if (tab === 'kinematic') drawKinematicChart(currentFrame);
  if (tab === 'analysis') drawAngleChart(currentFrame);
}

// ==========================================
// Keyboard
// ==========================================

function handleKeyboard(e) {
  if (!els.analysis_screen.classList.contains('active')) return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      seekFrame(currentFrame - 1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      seekFrame(currentFrame + 1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      seekFrame(currentFrame - 10);
      break;
    case 'ArrowDown':
      e.preventDefault();
      seekFrame(currentFrame + 10);
      break;
    case 'Escape':
      if (els.naming_modal.classList.contains('open')) {
        // Handled by AbortController in showNamingModal
        return;
      }
      if (els.stromotion_modal.classList.contains('open')) {
        els.stromotion_modal.classList.remove('open');
      }
      if (expandedTile) closeTileDetail();
      break;
  }
}

// ==========================================
// UI Helpers
// ==========================================

function showAnalysis() {
  els.upload_screen.classList.remove('active');
  els.error_screen.classList.remove('active');
  els.analysis_screen.classList.add('active');
}

function showError(message) {
  els.upload_screen.classList.remove('active');
  els.analysis_screen.classList.remove('active');
  els.error_screen.classList.add('active');
  els.error_detail.textContent = message;
}

function resetToUpload() {
  pausePlayback();
  cleanupZoom();
  if (is3DActive) { dispose3D(); is3DActive = false; }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  els.upload_screen.classList.add('active');

  if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }

  poseData = [];
  angleData = [];
  velocityData = [];
  phaseData = null;
  currentFrame = 0;
  totalFrames = 0;
  videoElement.src = '';
  els.video_input.value = '';
  expandedTile = null;
  sessionMetadata = null;
  currentSessionId = null;
  hasLiveVideo = false;
  processingState = ProcessingState.IDLE;
  closeTileDetail();

  els.btn_overlay.disabled = false;
  els.btn_sidebyside.disabled = false;
  els.btn_overlay.title = '';
  els.btn_sidebyside.title = '';

  // Restore skeleton canvas if 3D replaced it
  if (!els.skeleton_panel.querySelector('#skeleton-canvas')) {
    const canvas = document.createElement('canvas');
    canvas.id = 'skeleton-canvas';
    els.skeleton_panel.appendChild(canvas);
    skeletonCanvas = canvas;
    skeletonCtx = canvas.getContext('2d');
  }

  checkForSessions();
}

// ==========================================
// Processing State Machine
// ==========================================

const STATE_CONFIG = {
  [ProcessingState.UPLOADING]: { title: 'Loading video...', showProgress: false },
  [ProcessingState.DETECTING_FPS]: { title: 'Detecting frame rate...', showProgress: false },
  [ProcessingState.LOADING_MODEL]: { title: 'Loading pose detection model...', showProgress: false },
  [ProcessingState.ANALYZING]: { title: 'Analyzing poses...', showProgress: true },
  [ProcessingState.COMPLETE]: { title: 'Complete', showProgress: false },
  [ProcessingState.ERROR]: { title: 'Error', showProgress: false },
};

function setProcessingState(state, meta = {}) {
  processingState = state;
  Object.assign(processingMeta, meta);
  renderProcessingUI();
}

function renderProcessingUI() {
  if (processingState === ProcessingState.IDLE || processingState === ProcessingState.COMPLETE) {
    els.processing_overlay.classList.remove('active');
    return;
  }

  if (processingState === ProcessingState.ERROR) {
    els.processing_overlay.classList.remove('active');
    return;
  }

  els.processing_overlay.classList.add('active');

  const config = STATE_CONFIG[processingState];
  if (config) {
    els.processing_text.textContent = config.title;
  }

  // Update meta display
  if (processingMeta.fileName) {
    els.meta_filename.textContent = processingMeta.fileName;
    els.meta_filename.style.display = '';
  } else {
    els.meta_filename.style.display = 'none';
  }

  if (processingMeta.fileSize > 0) {
    const sizeMB = (processingMeta.fileSize / (1024 * 1024)).toFixed(1);
    els.meta_filesize.textContent = sizeMB + ' MB';
    els.meta_filesize.style.display = '';
  } else {
    els.meta_filesize.style.display = 'none';
  }

  if (processingMeta.duration > 0) {
    els.meta_duration.textContent = processingMeta.duration.toFixed(1) + 's';
    els.meta_duration.style.display = '';
  } else {
    els.meta_duration.style.display = 'none';
  }

  if (processingMeta.detectedFps !== null) {
    els.meta_fps.textContent = processingMeta.detectedFps + ' fps';
    els.meta_fps.style.display = '';
  } else {
    els.meta_fps.style.display = 'none';
  }

  // Update progress bar visibility
  const progressBar = els.progress_fill.parentElement;
  if (config && config.showProgress) {
    progressBar.style.display = '';
    els.progress_label.style.display = '';
  } else {
    progressBar.style.display = 'none';
    els.progress_label.style.display = 'none';
  }

  // Update step indicators
  const steps = els.processing_steps.querySelectorAll('.step');
  const stateOrder = [ProcessingState.UPLOADING, ProcessingState.DETECTING_FPS, ProcessingState.LOADING_MODEL, ProcessingState.ANALYZING];
  const currentIdx = stateOrder.indexOf(processingState);

  steps.forEach((step, i) => {
    step.classList.remove('active', 'done', 'error');
    if (processingState === ProcessingState.ERROR) {
      if (i === currentIdx || (currentIdx === -1 && i === 0)) {
        step.classList.add('error');
      }
    } else if (i < currentIdx) {
      step.classList.add('done');
    } else if (i === currentIdx) {
      step.classList.add('active');
    }
  });
}

// Legacy wrappers for backward compatibility within processVideo
function showProcessing(text) {
  els.processing_overlay.classList.add('active');
  els.processing_text.textContent = text;
  els.progress_fill.style.width = '0%';
  els.progress_label.textContent = '0%';
}

function updateProcessing(text) {
  els.processing_text.textContent = text;
}

function hideProcessing() {
  els.processing_overlay.classList.remove('active');
}

// ==========================================
// Session Naming Modal (AbortController pattern per Chief Blocker 3)
// ==========================================

function showNamingModal(fileNameDefault) {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const { signal } = ac;

    // Pre-fill defaults
    els.input_session_name.value = fileNameDefault.replace(/\.[^.]+$/, '');
    els.input_session_date.value = new Date().toISOString().split('T')[0];

    // Pre-fill athlete name from localStorage cache
    try {
      const lastAthlete = localStorage.getItem('qbmc-last-athlete');
      if (lastAthlete) els.input_athlete_name.value = lastAthlete;
      else els.input_athlete_name.value = '';
    } catch (_) {
      els.input_athlete_name.value = '';
    }

    els.input_session_notes.value = '';

    // Reset tags
    const selectedTags = new Set();
    const tagButtons = els.tag_selector.querySelectorAll('.tag-option');
    tagButtons.forEach(btn => btn.classList.remove('selected'));

    els.naming_modal.classList.add('open');
    els.input_athlete_name.focus();

    const done = (metadata) => {
      ac.abort();
      els.naming_modal.classList.remove('open');
      resolve(metadata);
    };

    // Tag toggles
    tagButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('selected');
        if (btn.classList.contains('selected')) selectedTags.add(btn.dataset.tag);
        else selectedTags.delete(btn.dataset.tag);
      }, { signal });
    });

    // Save handler
    els.naming_form.addEventListener('submit', (e) => {
      e.preventDefault();
      const metadata = {
        athleteName: els.input_athlete_name.value.trim(),
        sessionName: els.input_session_name.value.trim() || fileNameDefault.replace(/\.[^.]+$/, ''),
        tags: [...selectedTags],
        date: els.input_session_date.value,
        notes: els.input_session_notes.value.trim(),
      };

      // Cache athlete name
      try {
        if (metadata.athleteName) {
          localStorage.setItem('qbmc-last-athlete', metadata.athleteName);
        }
      } catch (_) { /* localStorage unavailable */ }

      done(metadata);
    }, { signal });

    // Skip handler
    els.btn_skip_naming.addEventListener('click', () => {
      done({
        athleteName: '',
        sessionName: fileNameDefault.replace(/\.[^.]+$/, ''),
        tags: [],
        date: new Date().toISOString().split('T')[0],
        notes: '',
      });
    }, { signal });

    // Escape to skip
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        done({
          athleteName: '',
          sessionName: fileNameDefault.replace(/\.[^.]+$/, ''),
          tags: [],
          date: new Date().toISOString().split('T')[0],
          notes: '',
        });
      }
    }, { signal });
  });
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00.00';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(2).padStart(5, '0')}`;
}

// ==========================================
// PDF Report (Phase 7)
// ==========================================

function detectKeyPhases() {
  const phases = {
    ballPat: null,
    footStrike: null,
    mer: null,
    release: null,
    followThrough: null,
    releaseTimeMs: null,
    metrics: {},
  };

  if (poseData.length < 10) return phases;

  const side = detectThrowingSide(poseData[Math.floor(poseData.length / 2)]?.landmarks);
  const isLeft = side === 'left';
  const wristIdx = isLeft ? LANDMARKS.LEFT_WRIST : LANDMARKS.RIGHT_WRIST;
  const elbowIdx = isLeft ? LANDMARKS.LEFT_ELBOW : LANDMARKS.RIGHT_ELBOW;
  const shoulderIdx = isLeft ? LANDMARKS.LEFT_SHOULDER : LANDMARKS.RIGHT_SHOULDER;
  const frontAnkleIdx = isLeft ? LANDMARKS.RIGHT_ANKLE : LANDMARKS.LEFT_ANKLE;
  const frontKneeIdx = isLeft ? LANDMARKS.RIGHT_KNEE : LANDMARKS.LEFT_KNEE;
  const frontHipIdx = isLeft ? LANDMARKS.RIGHT_HIP : LANDMARKS.LEFT_HIP;

  // Precompute wrist-to-wrist distances and throwing wrist velocities
  const wristDists = [];
  const wristVelX = [];
  for (let i = 0; i < poseData.length; i++) {
    const lm = poseData[i]?.landmarks;
    if (!lm) { wristDists.push(null); wristVelX.push(null); continue; }
    const lw = lm[LANDMARKS.LEFT_WRIST];
    const rw = lm[LANDMARKS.RIGHT_WRIST];
    const dx = lw.x - rw.x;
    const dy = lw.y - rw.y;
    wristDists.push(Math.sqrt(dx * dx + dy * dy));

    if (i > 0 && poseData[i - 1]?.landmarks) {
      const prevW = poseData[i - 1].landmarks[wristIdx];
      const currW = lm[wristIdx];
      wristVelX.push((currW.x - prevW.x) * fps);
    } else {
      wristVelX.push(0);
    }
  }

  // === BALL PAT: wrists closest together (minimum wrist distance in first half) ===
  let minDist = Infinity;
  const searchEnd = Math.min(Math.floor(poseData.length * 0.6), poseData.length);
  for (let i = 0; i < searchEnd; i++) {
    if (wristDists[i] !== null && wristDists[i] < minDist) {
      minDist = wristDists[i];
      phases.ballPat = i;
    }
  }

  // === FOOT STRIKE: stride ankle velocity drops to near-zero after movement ===
  // Compute front ankle vertical velocity, find where it settles after moving
  const ankleVelY = [];
  for (let i = 1; i < poseData.length; i++) {
    const prev = poseData[i - 1]?.landmarks?.[frontAnkleIdx];
    const curr = poseData[i]?.landmarks?.[frontAnkleIdx];
    if (prev && curr) {
      ankleVelY.push(Math.abs((curr.y - prev.y) * fps));
    } else {
      ankleVelY.push(0);
    }
  }

  // Look for ankle velocity peak followed by drop to near-zero (foot plants)
  const startSearch = phases.ballPat || 0;
  const ankleSearchEnd = Math.min(Math.floor(ankleVelY.length * 0.75), ankleVelY.length);
  let peakAnkleVel = 0;
  let peakAnkleFrame = startSearch;
  for (let i = startSearch; i < ankleSearchEnd; i++) {
    if (ankleVelY[i] > peakAnkleVel) {
      peakAnkleVel = ankleVelY[i];
      peakAnkleFrame = i;
    }
  }
  // After peak, find where velocity drops below 15% of peak
  if (peakAnkleVel > 0) {
    const threshold = peakAnkleVel * 0.15;
    for (let i = peakAnkleFrame; i < ankleVelY.length; i++) {
      if (ankleVelY[i] < threshold) {
        phases.footStrike = i + 1;
        break;
      }
    }
  }

  // === MER PROXY: throwing wrist reaches peak rearward position relative to shoulder ===
  // For right-handed: wrist.x is most rightward (highest x) relative to shoulder
  // For left-handed: wrist.x is most leftward (lowest x) relative to shoulder
  // Search only in first 80% of clip to avoid follow-through artifacts
  const searchStart = phases.ballPat || 0;
  const merSearchEnd = Math.min(Math.floor(poseData.length * 0.8), poseData.length);
  let maxRearward = -Infinity;
  for (let i = searchStart; i < merSearchEnd; i++) {
    const lm = poseData[i]?.landmarks;
    if (!lm) continue;
    const wrist = lm[wristIdx];
    const shoulder = lm[shoulderIdx];
    const rearward = isLeft ? (shoulder.x - wrist.x) : (wrist.x - shoulder.x);
    if (rearward > maxRearward) {
      maxRearward = rearward;
      phases.mer = i;
    }
  }

  // === BALL RELEASE: peak forward wrist velocity after MER ===
  const relSearchStart = phases.mer || searchStart;
  let peakWristVel = 0;
  for (let i = relSearchStart; i < wristVelX.length; i++) {
    const vel = isLeft ? -wristVelX[i] : wristVelX[i];
    if (vel > peakWristVel) {
      peakWristVel = vel;
      phases.release = i;
    }
  }

  // === FOLLOW-THROUGH: wrist velocity drops below 30% of peak after release ===
  if (phases.release !== null && peakWristVel > 0) {
    const threshold = peakWristVel * 0.3;
    for (let i = phases.release + 1; i < wristVelX.length; i++) {
      const vel = isLeft ? -wristVelX[i] : wristVelX[i];
      if (vel < threshold) {
        phases.followThrough = i;
        break;
      }
    }
  }

  // === RELEASE TIME: ball pat to ball release in milliseconds ===
  if (phases.ballPat !== null && phases.release !== null) {
    const frameCount = phases.release - phases.ballPat;
    phases.releaseTimeMs = Math.round((frameCount / fps) * 1000);
  }

  // === PHASE-SPECIFIC METRICS ===

  // At foot strike
  if (phases.footStrike !== null && angleData[phases.footStrike]) {
    const a = angleData[phases.footStrike];
    phases.metrics.footStrike = {
      leadKnee: a.knee,
      hipShoulderSep: a.hip,
      elbow: a.elbow,
    };

    // Stride length: ankle-to-ankle distance / estimated height
    const lm = poseData[phases.footStrike]?.landmarks;
    if (lm) {
      const la = lm[LANDMARKS.LEFT_ANKLE];
      const ra = lm[LANDMARKS.RIGHT_ANKLE];
      const nose = lm[LANDMARKS.NOSE];
      const midAnkleY = (la.y + ra.y) / 2;
      const height = midAnkleY - nose.y;
      const strideDx = la.x - ra.x;
      const strideDy = la.y - ra.y;
      const strideDist = Math.sqrt(strideDx * strideDx + strideDy * strideDy);
      if (height > 0.05) {
        phases.metrics.footStrike.strideLengthPct = Math.round((strideDist / height) * 100);
      }
    }
  }

  // At MER
  if (phases.mer !== null && angleData[phases.mer]) {
    const a = angleData[phases.mer];
    phases.metrics.mer = {
      elbow: a.elbow,
      shoulder: a.shoulder,
      hipShoulderSep: a.hip,
    };
  }

  // At release
  if (phases.release !== null && angleData[phases.release]) {
    const a = angleData[phases.release];
    const lm = poseData[phases.release]?.landmarks;

    phases.metrics.release = {
      elbow: a.elbow,
      hipShoulderSep: a.hip,
      release: a.release,
    };

    // Trunk forward flexion: angle of spine from vertical
    if (lm) {
      const sh = lm[isLeft ? LANDMARKS.LEFT_SHOULDER : LANDMARKS.RIGHT_SHOULDER];
      const hp = lm[isLeft ? LANDMARKS.LEFT_HIP : LANDMARKS.RIGHT_HIP];
      const spineAngle = Math.abs(Math.atan2(sh.x - hp.x, hp.y - sh.y)) * (180 / Math.PI);
      phases.metrics.release.trunkFlexion = Math.round(spineAngle);
    }

    // Trunk lateral tilt: shoulder line angle from horizontal
    if (lm) {
      const ls = lm[LANDMARKS.LEFT_SHOULDER];
      const rs = lm[LANDMARKS.RIGHT_SHOULDER];
      const tilt = Math.atan2(rs.y - ls.y, rs.x - ls.x) * (180 / Math.PI);
      phases.metrics.release.trunkLateralTilt = Math.round(Math.abs(tilt));
    }
  }

  // Deceleration: lead knee delta (foot strike to release)
  if (phases.footStrike !== null && phases.release !== null) {
    const kneeAtStrike = angleData[phases.footStrike]?.knee;
    const kneeAtRelease = angleData[phases.release]?.knee;
    if (kneeAtStrike !== null && kneeAtRelease !== null) {
      phases.metrics.deceleration = {
        leadKneeDelta: Math.abs(kneeAtRelease - kneeAtStrike),
        kneeAtStrike,
        kneeAtRelease,
      };
    }
  }

  // Peak rotation velocities for sequencing
  let peakHipVel = 0, peakHipFrame = 0;
  let peakShoulderVel = 0, peakShoulderFrame = 0;
  let peakElbowVel = 0, peakElbowFrame = 0;
  for (let i = 0; i < velocityData.length; i++) {
    const v = velocityData[i];
    if (!v) continue;
    if (v.hip !== null && v.hip > peakHipVel) { peakHipVel = v.hip; peakHipFrame = i; }
    if (v.shoulder !== null && v.shoulder > peakShoulderVel) { peakShoulderVel = v.shoulder; peakShoulderFrame = i; }
    if (v.elbow !== null && v.elbow > peakElbowVel) { peakElbowVel = v.elbow; peakElbowFrame = i; }
  }
  phases.metrics.sequencing = {
    peakHipVel, peakHipFrame,
    peakShoulderVel, peakShoulderFrame,
    peakElbowVel, peakElbowFrame,
    correctOrder: peakHipFrame <= peakShoulderFrame && peakShoulderFrame <= peakElbowFrame,
  };

  phaseData = phases;
  return phases;
}

async function captureFrameStill(frameIdx, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (hasLiveVideo && videoElement.src) {
    await new Promise(resolve => {
      videoElement.currentTime = frameIdx / fps;
      videoElement.onseeked = () => { resolve(); videoElement.onseeked = null; };
    });
    ctx.drawImage(videoElement, 0, 0, width, height);
  } else {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, width, height);
  }

  const landmarks = poseData[frameIdx]?.landmarks;
  if (landmarks) {
    drawSkeleton(ctx, landmarks, width, height, true);
    const angles = angleData[frameIdx];
    if (angles) drawAngleAnnotations(ctx, landmarks, angles, width, height);
  }

  return canvas.toDataURL('image/jpeg', 0.85);
}

async function generatePDFReport() {
  if (!window.jspdf) {
    alert('PDF library not loaded. Check your internet connection.');
    return;
  }

  els.btn_export_pdf.disabled = true;
  els.btn_export_pdf.textContent = 'Generating...';

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('p', 'mm', 'letter');

    const pageW = 215.9;
    const pageH = 279.4;
    const margin = 15;
    const contentW = pageW - margin * 2;
    const gold = [212, 195, 106];
    const white = [255, 255, 255];
    const dark = [20, 20, 20];
    const gray = [120, 120, 120];

    // Load logo
    let logoDataUrl = null;
    try {
      const resp = await fetch('logo.png');
      const blob = await resp.blob();
      logoDataUrl = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    } catch (e) { /* logo optional */ }

    const athlete = sessionMetadata?.athleteName || 'Unknown Athlete';
    const sessionName = sessionMetadata?.sessionName || 'Session';
    const date = sessionMetadata?.date || new Date().toISOString().slice(0, 10);
    const phases = detectKeyPhases();
    const peaks = computePeakSummary();

    // ---- PAGE 1: Key Frames + Big Metrics ----
    doc.setFillColor(...dark);
    doc.rect(0, 0, pageW, pageH, 'F');

    // Logo top-right
    if (logoDataUrl) {
      doc.addImage(logoDataUrl, 'PNG', pageW - margin - 18, 8, 18, 22);
    }

    doc.setFontSize(22);
    doc.setTextColor(...gold);
    doc.text('QB MOTION CAPTURE REPORT', margin, 20);

    doc.setFontSize(10);
    doc.setTextColor(...gray);
    doc.text(`QB Stable  |  ${date}  |  ${athlete}  |  ${sessionName}`, margin, 28);

    doc.setDrawColor(...gold);
    doc.setLineWidth(0.3);
    doc.line(margin, 31, pageW - margin, 31);

    // Key frame stills (2x2 grid)
    const frameW = contentW / 2 - 3;
    const frameH = frameW * 0.5625;
    const phaseFrames = [
      { label: 'Foot Strike', frame: phases.footStrike },
      { label: 'Max External Rotation', frame: phases.mer },
      { label: 'Ball Release', frame: phases.release },
      { label: 'Follow Through', frame: phases.followThrough },
    ];

    let fy = 35;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const idx = row * 2 + col;
        const ph = phaseFrames[idx];
        const fx = margin + col * (frameW + 6);

        if (ph.frame !== null && ph.frame >= 0 && ph.frame < poseData.length) {
          const img = await captureFrameStill(ph.frame, 640, 360);
          doc.addImage(img, 'JPEG', fx, fy, frameW, frameH);
        } else {
          doc.setFillColor(30, 30, 30);
          doc.rect(fx, fy, frameW, frameH, 'F');
          doc.setFontSize(9);
          doc.setTextColor(...gray);
          doc.text('Frame not detected', fx + frameW / 2, fy + frameH / 2, { align: 'center' });
        }

        doc.setFontSize(8);
        doc.setTextColor(...gold);
        doc.text(ph.label, fx + 2, fy + frameH + 4);
      }
      fy += frameH + 10;
    }

    // Big metrics row
    fy += 5;
    const metrics = [
      { label: 'Peak Elbow Vel.', value: peaks.velocity?.elbow ? `${Math.round(peaks.velocity.elbow.peak)} deg/s` : 'N/A' },
      { label: 'Peak Hip Rot.', value: peaks.hip ? `${peaks.hip.max} deg` : 'N/A' },
      { label: 'Peak Shoulder', value: peaks.shoulder ? `${peaks.shoulder.max} deg` : 'N/A' },
      { label: 'Total Frames', value: `${totalFrames} @ ${Math.round(fps)}fps` },
    ];

    const metricW = contentW / 4;
    for (let i = 0; i < metrics.length; i++) {
      const mx = margin + i * metricW;
      doc.setFontSize(18);
      doc.setTextColor(...white);
      doc.text(metrics[i].value, mx + metricW / 2, fy, { align: 'center' });
      doc.setFontSize(8);
      doc.setTextColor(...gray);
      doc.text(metrics[i].label, mx + metricW / 2, fy + 6, { align: 'center' });
    }

    // ---- PAGE 2: Kinematic Chart + Scores ----
    doc.addPage();
    doc.setFillColor(...dark);
    doc.rect(0, 0, pageW, pageH, 'F');

    doc.setFontSize(16);
    doc.setTextColor(...gold);
    doc.text('KINEMATIC SEQUENCE', margin, 18);

    const kinChart = document.getElementById('kinematic-chart');
    if (kinChart) {
      drawKinematicChart();
      const kinImg = kinChart.toDataURL('image/png');
      doc.addImage(kinImg, 'PNG', margin, 22, contentW, contentW * 0.4);
    }

    // Report card scores
    let sy = kinChart ? 22 + contentW * 0.4 + 10 : 30;
    doc.setFontSize(14);
    doc.setTextColor(...gold);
    doc.text('MECHANICS SCORES', margin, sy);
    sy += 8;

    for (const cat of REPORT_CATEGORIES) {
      const score = calculateCategoryScore(cat);
      const grade = letterGrade(score.score ?? 0);
      const color = score.score >= 7 ? [68, 204, 68] : score.score >= 4 ? [255, 204, 0] : [255, 68, 68];

      doc.setFontSize(10);
      doc.setTextColor(...color);
      doc.text(grade, margin, sy);
      doc.setTextColor(...white);
      doc.text(`${cat.name}: ${score.score !== null ? score.score + '/10' : 'N/A'} (${score.value || 'N/A'})`, margin + 12, sy);
      sy += 6;
    }

    // Overall grade
    const validScores = REPORT_CATEGORIES.map(c => calculateCategoryScore(c)).filter(s => s.score !== null);
    const avgScore = validScores.length > 0
      ? Math.round(validScores.reduce((sum, s) => sum + s.score, 0) / validScores.length)
      : 0;
    sy += 4;
    doc.setFontSize(14);
    doc.setTextColor(...gold);
    doc.text(`Overall: ${letterGrade(avgScore)} (${avgScore}/10)`, margin, sy);

    // ---- PAGE 3: Angle Charts ----
    doc.addPage();
    doc.setFillColor(...dark);
    doc.rect(0, 0, pageW, pageH, 'F');

    doc.setFontSize(16);
    doc.setTextColor(...gold);
    doc.text('JOINT ANGLES OVER TIME', margin, 18);

    const angleChart = document.getElementById('angle-chart');
    if (angleChart) {
      drawAngleChart();
      const angleImg = angleChart.toDataURL('image/png');
      doc.addImage(angleImg, 'PNG', margin, 22, contentW, contentW * 0.35);
    }

    // Angles at key phases table
    let ty = angleChart ? 22 + contentW * 0.35 + 10 : 30;
    doc.setFontSize(12);
    doc.setTextColor(...gold);
    doc.text('ANGLES AT KEY PHASES', margin, ty);
    ty += 8;

    doc.setFontSize(9);
    doc.setTextColor(...gray);
    const headers = ['Phase', 'Frame', 'Elbow', 'Shoulder', 'Hip', 'Knee'];
    const colW = contentW / headers.length;
    for (let i = 0; i < headers.length; i++) {
      doc.text(headers[i], margin + i * colW, ty);
    }

    ty += 2;
    doc.setDrawColor(60, 60, 60);
    doc.line(margin, ty, pageW - margin, ty);
    ty += 5;

    doc.setTextColor(...white);
    for (const ph of phaseFrames) {
      if (ph.frame === null) continue;
      const a = angleData[ph.frame] || {};
      const row = [
        ph.label,
        String(ph.frame),
        a.elbow != null ? `${a.elbow}\u00B0` : '--',
        a.shoulder != null ? `${a.shoulder}\u00B0` : '--',
        a.hip != null ? `${a.hip}\u00B0` : '--',
        a.knee != null ? `${a.knee}\u00B0` : '--',
      ];
      for (let i = 0; i < row.length; i++) {
        doc.text(row[i], margin + i * colW, ty);
      }
      ty += 5;
    }

    // ---- PAGE 4: Velocity Charts ----
    doc.addPage();
    doc.setFillColor(...dark);
    doc.rect(0, 0, pageW, pageH, 'F');

    doc.setFontSize(16);
    doc.setTextColor(...gold);
    doc.text('ANGULAR VELOCITY', margin, 18);

    // Render velocity data table
    let vy = 26;
    doc.setFontSize(9);
    doc.setTextColor(...gray);
    const velHeaders = ['Joint', 'Peak (deg/s)', 'Frame', 'Time'];
    const velColW = contentW / velHeaders.length;
    for (let i = 0; i < velHeaders.length; i++) {
      doc.text(velHeaders[i], margin + i * velColW, vy);
    }
    vy += 2;
    doc.setDrawColor(60, 60, 60);
    doc.line(margin, vy, pageW - margin, vy);
    vy += 5;

    doc.setTextColor(...white);
    for (const key of ['elbow', 'shoulder', 'hip', 'knee']) {
      const p = peaks.velocity?.[key];
      if (!p) continue;
      const row = [
        key.charAt(0).toUpperCase() + key.slice(1),
        `${Math.round(p.peak)}`,
        String(p.frame),
        formatTime(p.frame / fps),
      ];
      for (let i = 0; i < row.length; i++) {
        doc.text(row[i], margin + i * velColW, vy);
      }
      vy += 5;
    }

    // ---- PAGE 5: Summary ----
    doc.addPage();
    doc.setFillColor(...dark);
    doc.rect(0, 0, pageW, pageH, 'F');

    doc.setFontSize(16);
    doc.setTextColor(...gold);
    doc.text('SESSION SUMMARY', margin, 18);

    if (logoDataUrl) {
      doc.addImage(logoDataUrl, 'PNG', pageW / 2 - 15, 30, 30, 37);
    }

    let ssy = logoDataUrl ? 75 : 30;
    doc.setFontSize(10);
    doc.setTextColor(...white);

    const summaryLines = [
      `Athlete: ${athlete}`,
      `Session: ${sessionName}`,
      `Date: ${date}`,
      `Duration: ${(totalFrames / fps).toFixed(2)}s`,
      `Frame Rate: ${Math.round(fps)} fps`,
      `Total Frames Analyzed: ${totalFrames}`,
      `Throwing Side: ${poseData[0]?.landmarks ? detectThrowingSide(poseData[0].landmarks) : 'Unknown'}`,
      '',
      `Notes: ${sessionMetadata?.notes || 'None'}`,
    ];

    for (const line of summaryLines) {
      doc.text(line, margin, ssy);
      ssy += 6;
    }

    // Footer
    ssy = pageH - 20;
    doc.setFontSize(8);
    doc.setTextColor(...gray);
    doc.text('QB Motion Capture (c) 2026 QB Stable. All analysis performed locally in your browser.', margin, ssy);
    doc.text('This report was generated automatically. Results are estimates based on 2D pose estimation.', margin, ssy + 4);

    // Save
    const filename = `qb-motion-capture-${athlete.replace(/\s+/g, '-').toLowerCase()}-${date}.pdf`;
    doc.save(filename);
  } catch (err) {
    console.error('PDF generation failed:', err);
    alert('Failed to generate PDF: ' + err.message);
  } finally {
    els.btn_export_pdf.disabled = false;
    els.btn_export_pdf.textContent = 'PDF';
  }
}

// ==========================================
// Sessions (Phase 4-5)
// ==========================================

let allSessions = [];

async function checkForSessions() {
  try {
    const sessions = await getAllSessions();
    allSessions = sessions;
    const hasSessions = sessions.length > 0;
    els.btn_view_sessions.style.display = hasSessions ? '' : 'none';
    els.btn_sessions_nav.style.display = hasSessions ? '' : 'none';
  } catch (e) {
    console.warn('IndexedDB not available:', e);
  }
}

async function showSessionsScreen() {
  try {
    allSessions = await getAllSessions();
  } catch (e) {
    allSessions = [];
  }

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  els.sessions_screen.classList.add('active');
  els.sessions_search.value = '';
  renderSessionCards(allSessions);
}

function renderSessionCards(sessions) {
  if (sessions.length === 0) {
    els.sessions_grid.innerHTML = '';
    els.sessions_empty.style.display = '';
    return;
  }

  els.sessions_empty.style.display = 'none';
  const thumbUrls = [];

  els.sessions_grid.innerHTML = sessions.map(s => {
    let thumbSrc = '';
    if (s.thumbnail) {
      const url = URL.createObjectURL(s.thumbnail);
      thumbUrls.push(url);
      thumbSrc = url;
    }

    const date = s.date || s.createdAt?.slice(0, 10) || '';
    const tags = (s.tags || []).map(t => `<span class="session-tag">${t}</span>`).join('');
    const frames = s.totalFrames || '?';
    const dur = s.duration ? s.duration.toFixed(1) + 's' : '';

    return `<div class="session-card" data-session-id="${s.id}">
      ${thumbSrc ? `<img class="session-card-thumb" src="${thumbSrc}" alt="Session thumbnail">` : '<div class="session-card-thumb"></div>'}
      <div class="session-card-body">
        <div class="session-card-athlete">${s.athleteName || 'Unknown Athlete'}</div>
        <div class="session-card-name">${s.sessionName || s.fileName || 'Untitled'}</div>
        <div class="session-card-meta">
          <span>${date}</span>
          <span>${dur}</span>
          <span>${frames} frames</span>
        </div>
        ${tags ? `<div class="session-card-tags">${tags}</div>` : ''}
      </div>
      <div class="session-card-actions">
        <button class="btn btn-sm btn-gold btn-load-session" data-id="${s.id}">Load</button>
        <button class="btn btn-sm btn-ghost btn-delete-session" data-id="${s.id}">Delete</button>
      </div>
    </div>`;
  }).join('');

  els.sessions_grid.querySelectorAll('.btn-load-session').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      loadSession(btn.dataset.id);
    });
  });

  els.sessions_grid.querySelectorAll('.btn-delete-session').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteSession(btn.dataset.id);
      await showSessionsScreen();
      await checkForSessions();
    });
  });
}

function filterSessions() {
  const query = els.sessions_search.value.toLowerCase().trim();
  if (!query) {
    renderSessionCards(allSessions);
    return;
  }

  const filtered = allSessions.filter(s => {
    const name = (s.athleteName || '').toLowerCase();
    const session = (s.sessionName || '').toLowerCase();
    const tags = (s.tags || []).join(' ').toLowerCase();
    return name.includes(query) || session.includes(query) || tags.includes(query);
  });

  renderSessionCards(filtered);
}

async function loadSession(id) {
  try {
    const session = await getSession(id);
    if (!session) return;

    poseData = session.poseData || [];
    angleData = session.angleData || [];
    velocityData = session.velocityData || [];
    fps = session.fps || 30;
    totalFrames = session.totalFrames || poseData.length;
    currentSessionId = session.id;
    hasLiveVideo = false;
    sessionMetadata = {
      athleteName: session.athleteName,
      sessionName: session.sessionName,
      tags: session.tags,
      date: session.date,
      notes: session.notes,
    };

    els.scrub_slider.max = totalFrames - 1;
    els.total_time.textContent = formatTime(session.duration || 0);

    const vw = session.width || 640;
    const vh = session.height || 360;
    overlayCanvas.width = vw;
    overlayCanvas.height = vh;
    skeletonCanvas.width = vw;
    skeletonCanvas.height = vh;

    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    els.analysis_screen.classList.add('active');

    setViewMode('skeleton');

    els.btn_overlay.disabled = true;
    els.btn_sidebyside.disabled = true;
    els.btn_overlay.title = 'Re-upload original video to use overlay view';
    els.btn_sidebyside.title = 'Re-upload original video to use split view';

    updateDataDensityPanel();
    updatePeakBadges();
    drawAngleChart();
    drawKinematicChart();
    generateReportCard();
    seekFrame(0);
  } catch (err) {
    console.error('Failed to load session:', err);
  }
}

// ==========================================
// Boot
// ==========================================

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
