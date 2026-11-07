// Layout of the move list: how moves and variations are displayed.
import { positionPopover, segmentedGroup } from './ui.js';

// Keys are stored in localStorage, so they stay as they were; only labels and order change.
export const MOVE_LAYOUTS = {
  columns: {
    label: 'Columns',
    title: 'Move pairs in columns everywhere',
  },
  mixed: {
    label: 'Inline variations',
    title: 'Columns for the main line, text for variations',
  },
  inline: {
    label: 'Inline all',
    title: 'Moves flow as text; variations in indented blocks',
  },
};

export const DEFAULT_MOVE_LAYOUT = 'mixed';

const STORAGE_KEY = '64-quarks.moveLayout';

export function loadMoveLayout() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* ignore storage errors */
  }
  return Object.hasOwn(MOVE_LAYOUTS, saved) ? saved : DEFAULT_MOVE_LAYOUT;
}

function saveMoveLayout(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* ignore storage errors */
  }
}

// Wires the Moves gear button, its settings area and the Layout control.
// onChange receives the newly chosen layout.
export function initMovesSettings(layout, onChange, doc = document) {
  const button = doc.getElementById('moves-settings-btn');
  const menu = doc.getElementById('moves-settings');
  const container = doc.getElementById('moves-layout');
  if (!button || !menu || !container) return;

  const group = segmentedGroup(
    container,
    Object.entries(MOVE_LAYOUTS).map(([value, { label, title }]) => ({ value, label, title })),
    (value) => {
      group.setValue(value);
      saveMoveLayout(value);
      onChange(value);
    },
  );
  group.setValue(layout);

  const setOpen = (open) => {
    if (open) positionPopover(menu, button);
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };

  button.addEventListener('click', () => setOpen(menu.hidden));
  window.addEventListener('resize', () => {
    if (!menu.hidden) positionPopover(menu, button);
  });

  doc.addEventListener('click', (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) {
      setOpen(false);
    }
  });
}
