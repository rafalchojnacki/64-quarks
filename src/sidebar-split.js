// Vertical split between the Evaluation (analysis) section and the Moves section
// of the right side panel. The share of the panel height given to Evaluation is stored
// as a fraction and clamped so both sections keep a usable minimum height.

const STORAGE_KEY = '64-quarks.analysisShare';
const DEFAULT_SHARE = 0.4;
const MIN_ANALYSIS_PX = 120;
const MIN_MOVES_PX = 120;
const KEY_STEP = 0.02;
const DRAG_HINT = 'Drag to resize (arrow keys work too)';

// Turns the divider on or off along with the Evaluation section. When off it
// stays visible as a plain line, but cannot be dragged or focused, and has no hint.
export function setSplitEnabled(enabled, doc = document) {
  const divider = doc.getElementById('sidebar-split');
  if (!divider) return;
  divider.classList.toggle('disabled', !enabled);
  if (enabled) {
    divider.setAttribute('tabindex', '0');
    divider.setAttribute('title', DRAG_HINT);
    divider.removeAttribute('aria-disabled');
  } else {
    divider.removeAttribute('tabindex');
    divider.removeAttribute('title');
    divider.setAttribute('aria-disabled', 'true');
  }
}

export function initSidebarSplit(doc = document) {
  const panel = doc.querySelector('.side-inner-panel');
  const analysis = doc.getElementById('eval-section');
  const divider = doc.getElementById('sidebar-split');
  if (!panel || !analysis || !divider) return;

  let share = loadShare();

  // Height available for the two sections (the divider's height is excluded).
  const available = () => Math.max(0, panel.clientHeight - divider.offsetHeight);

  // Clamps a fraction so both sections keep their minimum height.
  const clamp = (value) => {
    const total = available();
    if (!total) return value;
    const min = MIN_ANALYSIS_PX / total;
    const max = 1 - MIN_MOVES_PX / total;
    if (max < min) return min;
    return Math.min(max, Math.max(min, value));
  };

  const apply = () => {
    share = clamp(share);
    analysis.style.flex = `0 0 ${(share * available()).toFixed(1)}px`;
    divider.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  };

  const setShare = (value, persist = true) => {
    share = clamp(value);
    apply();
    if (persist) saveShare(share);
  };

  divider.setAttribute('aria-valuemin', '0');
  divider.setAttribute('aria-valuemax', '100');
  divider.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  apply();

  divider.addEventListener('pointerdown', (event) => {
    if (divider.classList.contains('disabled') || event.button !== 0) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    divider.classList.add('dragging');
    const startY = event.clientY;
    const startShare = share;
    const total = available();

    const onMove = (moveEvent) => {
      setShare(startShare + (moveEvent.clientY - startY) / total, false);
    };
    const onUp = () => {
      divider.classList.remove('dragging');
      divider.removeEventListener('pointermove', onMove);
      divider.removeEventListener('pointerup', onUp);
      divider.removeEventListener('pointercancel', onUp);
      saveShare(share);
    };
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('pointerup', onUp);
    divider.addEventListener('pointercancel', onUp);
  });

  divider.addEventListener('keydown', (event) => {
    if (divider.classList.contains('disabled')) return;
    if (event.key === 'ArrowUp') setShare(share - KEY_STEP);
    else if (event.key === 'ArrowDown') setShare(share + KEY_STEP);
    else return;
    event.preventDefault();
  });

  window.addEventListener('resize', apply);
}

function loadShare() {
  const value = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(value) && value > 0 && value < 1 ? value : DEFAULT_SHARE;
}

function saveShare(value) {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(value * 1000) / 1000));
  } catch {
    /* ignore storage errors */
  }
}
