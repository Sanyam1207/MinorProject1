// Warn-once logging for registry problems (bad tool definitions, duplicate
// names, optional lookups that fail). The registry is rebuilt on every
// request, so without this the same warning would be printed again and again.
const warned = new Set();

export const warnOnce = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[agent-tools] ${message}`);
};

/** Forget every warning already printed (tests only). */
export const resetWarnings = () => {
    warned.clear();
};
