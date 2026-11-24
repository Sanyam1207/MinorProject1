// Safe wrappers around Web Storage (FRONTEND.md §7.1).
//
// Every call is wrapped in try/catch: storage can be missing (node tests,
// some embedded browsers), blocked (privacy mode, sandboxed iframes) or full
// (QuotaExceededError). Writers return `true` on success and `false` on
// failure so callers can degrade (e.g. prune the chat archive and retry).
const resolveStore = (name) => {
  try {
    const store = globalThis[name];
    return store && typeof store.getItem === "function" ? store : null;
  } catch {
    return null;
  }
};

const read = (name, key) => {
  try {
    return resolveStore(name)?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const write = (name, key, value) => {
  try {
    const store = resolveStore(name);
    if (!store) return false;
    store.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
};

const remove = (name, key) => {
  try {
    resolveStore(name)?.removeItem(key);
  } catch {
    // ignore storage errors
  }
};

export const getItem = (key) => read("localStorage", key);
export const setItem = (key, value) => write("localStorage", key, value);
export const removeItem = (key) => remove("localStorage", key);

export const getJSON = (key, fallback = null) => {
  const raw = getItem(key);
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
};

export const setJSON = (key, value) => {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return false;
  }
  return setItem(key, serialized);
};

/** All localStorage keys that start with `prefix` (used to prune old per-user data). */
export const keysWithPrefix = (prefix) => {
  try {
    const store = resolveStore("localStorage");
    if (!store) return [];
    const keys = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
};

export const sessionGet = (key) => read("sessionStorage", key);
export const sessionSet = (key, value) => write("sessionStorage", key, value);
export const sessionRemove = (key) => remove("sessionStorage", key);
