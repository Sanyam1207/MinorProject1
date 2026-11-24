// Test environment for `node --test` (FRONTEND.md §18). Import FIRST in every test file.
// - in-memory localStorage / sessionStorage
// - a minimal `window` (EventTarget + location + isSecureContext); NO `document`,
//   so the shared socket never connects.

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  get length() {
    return this.map.size;
  }
  key(index) {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key) {
    return this.map.has(String(key)) ? this.map.get(String(key)) : null;
  }
  setItem(key, value) {
    this.map.set(String(key), String(value));
  }
  removeItem(key) {
    this.map.delete(String(key));
  }
  clear() {
    this.map.clear();
  }
}

const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

define("localStorage", new MemoryStorage());
define("sessionStorage", new MemoryStorage());

const win = new EventTarget();
win.location = new URL("http://localhost:5173/");
win.isSecureContext = true;
win.history = { state: null, replaceState() {} };
define("window", win);

export const resetStorage = () => {
  globalThis.localStorage.clear();
  globalThis.sessionStorage.clear();
};
