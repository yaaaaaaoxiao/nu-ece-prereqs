// Per-viewer preferences (theme, toggles, courses marked as taken) kept in
// localStorage. Storage can be missing or throw (private windows, blocked
// site data), so every access is guarded and the app works without it.

const KEY = 'prereq-map:v1';

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

export const prefs = {
  get(name, fallback) {
    const value = readAll()[name];
    return value === undefined ? fallback : value;
  },
  set(name, value) {
    try {
      const all = readAll();
      all[name] = value;
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      // Not persisted; the in-memory state still works for this visit.
    }
  },
};
