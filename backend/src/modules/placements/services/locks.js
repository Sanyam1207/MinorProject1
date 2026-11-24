// In-process per-key promise mutex (docs/contracts/PLACEMENTS.md §0.1). Single-process deployments;
// the unique indexes and status-guarded updates still protect multi-process setups.
const tails = new Map();

/** Run `fn` after every earlier holder of `key` has finished; resolves/rejects with its result. */
export const withLock = async (key, fn) => {
    const previous = tails.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    tails.set(key, tail);
    try {
        await previous;
        return await fn();
    } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
    }
};
