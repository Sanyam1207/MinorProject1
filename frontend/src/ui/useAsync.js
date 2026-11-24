import { useCallback, useEffect, useRef, useState } from "react";

const sameDeps = (a, b) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

/**
 * useAsync(load, deps, { enabled = true }) → { data, error, loading, reload, setData }
 *
 * Runs `load()` whenever `deps` change (or `reload()` is called) and ignores
 * results of superseded runs. `loading` is DERIVED from "the latest request
 * has no result yet", so no setState happens synchronously inside an effect
 * (react-hooks/set-state-in-effect). `data` keeps the last successful value
 * while a newer request is loading.
 */
export function useAsync(load, deps = [], { enabled = true } = {}) {
  const depsList = Array.isArray(deps) ? deps : [deps];
  const [request, setRequest] = useState(() => ({ deps: depsList, version: 0 }));
  let current = request;
  if (!sameDeps(request.deps, depsList)) {
    // "Adjust state while rendering": React re-renders before committing.
    current = { deps: depsList, version: request.version + 1 };
    setRequest(current);
  }
  const [reloads, setReloads] = useState(0);
  const [result, setResult] = useState({ key: null, data: undefined, error: null });

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  const key = `${current.version}:${reloads}`;
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    Promise.resolve()
      .then(() => loadRef.current())
      .then(
        (data) => {
          if (active) setResult({ key, data, error: null });
        },
        (error) => {
          if (active) setResult((previous) => ({ key, data: previous.data, error: error ?? new Error("Request failed") }));
        },
      );
    return () => {
      active = false;
    };
  }, [key, enabled]);

  const reload = useCallback(() => setReloads((count) => count + 1), []);
  const setData = useCallback(
    (updater) =>
      setResult((previous) => ({
        ...previous,
        data: typeof updater === "function" ? updater(previous.data) : updater,
      })),
    [],
  );

  const loading = enabled && result.key !== key;
  return {
    data: result.data,
    error: loading ? null : result.error,
    loading,
    reload,
    setData,
  };
}
