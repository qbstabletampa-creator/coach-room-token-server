/**
 * zoom.js - Pinch-to-zoom for the video panel
 * Transforms an inner wrapper instead of the panel itself
 * to avoid iOS Safari compositing flicker with video elements.
 */

let scale = 1;
let translateX = 0;
let translateY = 0;
let isDragging = false;
let isPinching = false;

let initialDist = 0;
let initialScale = 1;
let initialCenter = { x: 0, y: 0 };
let initialTranslate = { x: 0, y: 0 };

let lastTapTime = 0;
let lastSingleTouch = { x: 0, y: 0 };

let prevBodyOverflow = '';

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const SNAP_THRESHOLD = 1.05;
const DOUBLE_TAP_MS = 300;

let panelEl = null;
let wrapperEl = null;
let resetBtnEl = null;
let cleanupFn = null;

export function setupVideoZoom(panel, resetBtn) {
  if (!panel) return;
  if (cleanupFn) cleanupFn();

  panelEl = panel;
  resetBtnEl = resetBtn || null;

  scale = 1;
  translateX = 0;
  translateY = 0;
  isDragging = false;
  isPinching = false;

  // Create inner wrapper for transform target (avoids video compositing flicker)
  wrapperEl = panel.querySelector('.zoom-wrapper');
  if (!wrapperEl) {
    wrapperEl = document.createElement('div');
    wrapperEl.className = 'zoom-wrapper';
    wrapperEl.style.cssText = 'width:100%;height:100%;position:relative;display:flex;align-items:center;justify-content:center;';
    // Move video and canvas into wrapper, leave reset button outside
    const children = Array.from(panel.children).filter(c => !c.classList.contains('zoom-reset-pill'));
    children.forEach(c => wrapperEl.appendChild(c));
    panel.insertBefore(wrapperEl, panel.firstChild);
  }

  wrapperEl.style.transformOrigin = 'center center';
  wrapperEl.style.webkitBackfaceVisibility = 'hidden';
  wrapperEl.style.backfaceVisibility = 'hidden';

  panel.style.touchAction = 'none';

  panel.addEventListener('touchstart', onTouchStart, { passive: false });
  panel.addEventListener('touchmove', onTouchMove, { passive: false });
  panel.addEventListener('touchend', onTouchEnd, { passive: false });
  panel.addEventListener('touchcancel', onTouchEnd, { passive: false });
  panel.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('touchmove', docTouchMoveGuard, { passive: false });

  if (resetBtnEl) {
    resetBtnEl.addEventListener('click', onResetClick);
  }

  cleanupFn = () => {
    panel.removeEventListener('touchstart', onTouchStart);
    panel.removeEventListener('touchmove', onTouchMove);
    panel.removeEventListener('touchend', onTouchEnd);
    panel.removeEventListener('touchcancel', onTouchEnd);
    panel.removeEventListener('wheel', onWheel);
    document.removeEventListener('touchmove', docTouchMoveGuard);
    if (resetBtnEl) resetBtnEl.removeEventListener('click', onResetClick);
    unlockBodyScroll();
    resetZoomState();
    panelEl = null;
    wrapperEl = null;
    resetBtnEl = null;
    cleanupFn = null;
  };
}

export function cleanupZoom() {
  if (cleanupFn) cleanupFn();
}

function docTouchMoveGuard(e) {
  if (isPinching && e.touches.length >= 2) {
    e.preventDefault();
  }
}

function lockBodyScroll() {
  if (isPinching) return;
  isPinching = true;
  prevBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  document.documentElement.style.overscrollBehavior = 'none';
}

function unlockBodyScroll() {
  if (!isPinching) return;
  isPinching = false;
  document.body.style.overflow = prevBodyOverflow || '';
  document.documentElement.style.overscrollBehavior = '';
}

function onTouchStart(e) {
  if (resetBtnEl && resetBtnEl.contains(e.target)) return;

  if (e.touches.length === 2 || scale > 1) {
    e.preventDefault();
  }

  if (e.touches.length === 2) {
    const rect = panelEl.getBoundingClientRect();
    const allInside = Array.from(e.touches).every(t =>
      t.clientX >= rect.left && t.clientX <= rect.right &&
      t.clientY >= rect.top && t.clientY <= rect.bottom
    );
    if (!allInside) return;

    lockBodyScroll();
    initialDist = getTouchDistance(e.touches);
    initialScale = scale;
    initialCenter = getTouchCenter(e.touches, panelEl);
    initialTranslate = { x: translateX, y: translateY };
    isDragging = false;
  }

  if (e.touches.length === 1) {
    const now = Date.now();
    if (now - lastTapTime < DOUBLE_TAP_MS) {
      resetZoomState();
      updateResetButton();
      lastTapTime = 0;
      return;
    }
    lastTapTime = now;

    if (scale > 1) {
      isDragging = true;
      lastSingleTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  }
}

function onTouchMove(e) {
  if (e.touches.length === 2 || scale > 1) {
    e.preventDefault();
  }

  if (e.touches.length === 2) {
    const newDist = getTouchDistance(e.touches);
    const newScale = clamp(initialScale * (newDist / initialDist), ZOOM_MIN, ZOOM_MAX);
    const newCenter = getTouchCenter(e.touches, panelEl);
    const dx = newCenter.x - initialCenter.x;
    const dy = newCenter.y - initialCenter.y;

    scale = newScale;
    translateX = initialTranslate.x + dx;
    translateY = initialTranslate.y + dy;
    clampPan();
    applyTransform();
  } else if (isDragging && e.touches.length === 1 && scale > 1) {
    const dx = e.touches[0].clientX - lastSingleTouch.x;
    const dy = e.touches[0].clientY - lastSingleTouch.y;
    translateX += dx;
    translateY += dy;
    lastSingleTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    clampPan();
    applyTransform();
  }
}

function onTouchEnd(e) {
  if (scale > 1 || e.touches.length > 0) {
    e.preventDefault();
  }

  if (e.touches.length < 2) {
    unlockBodyScroll();
  }

  if (e.touches.length === 0) {
    isDragging = false;
  }

  if (scale <= SNAP_THRESHOLD) {
    resetZoomState();
  }

  updateResetButton();
}

function onWheel(e) {
  if (!e.ctrlKey) return;
  e.preventDefault();

  const rect = panelEl.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;

  const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
  const oldScale = scale;
  scale = clamp(scale * zoomFactor, ZOOM_MIN, ZOOM_MAX);

  const ratio = scale / oldScale;
  translateX = cx - ratio * (cx - translateX);
  translateY = cy - ratio * (cy - translateY);

  if (scale <= SNAP_THRESHOLD) {
    resetZoomState();
  } else {
    clampPan();
    applyTransform();
  }

  updateResetButton();
}

// Clamp pan so content can't be dragged completely off screen
function clampPan() {
  if (!panelEl || scale <= 1) return;
  const rect = panelEl.getBoundingClientRect();
  const maxX = rect.width * (scale - 1) / 2;
  const maxY = rect.height * (scale - 1) / 2;
  translateX = clamp(translateX, -maxX, maxX);
  translateY = clamp(translateY, -maxY, maxY);
}

let rafId = null;
function applyTransform() {
  if (!wrapperEl) return;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    if (!wrapperEl) return;
    if (scale <= 1) {
      wrapperEl.style.transform = '';
      return;
    }
    wrapperEl.style.transform = `scale(${scale}) translate3d(${translateX / scale}px, ${translateY / scale}px, 0)`;
  });
}

function resetZoomState() {
  scale = 1;
  translateX = 0;
  translateY = 0;
  isDragging = false;
  if (wrapperEl) wrapperEl.style.transform = '';
  document.body.style.overflow = prevBodyOverflow || '';
  document.documentElement.style.overscrollBehavior = '';
  isPinching = false;
}

function onResetClick() {
  resetZoomState();
  updateResetButton();
}

function updateResetButton() {
  if (!resetBtnEl) return;
  resetBtnEl.style.display = scale > 1 ? '' : 'none';
}

function getTouchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function getTouchCenter(touches, el) {
  const rect = el.getBoundingClientRect();
  return {
    x: ((touches[0].clientX + touches[1].clientX) / 2) - rect.left,
    y: ((touches[0].clientY + touches[1].clientY) / 2) - rect.top,
  };
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
