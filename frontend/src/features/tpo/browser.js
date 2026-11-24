// Browser-only helpers (touch `window`/`document` only when called).
/** Save a Blob as a file. */
export function downloadBlob(blob, filename) {
  if (typeof window === "undefined" || !blob) return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Open a URL that is only known after an async call, without tripping popup
 * blockers: a blank tab is opened synchronously (inside the click handler) and
 * pointed at the URL once it resolves. Throws (and closes the tab) on failure.
 */
export async function openAsyncUrl(getUrl) {
  const tab = typeof window !== "undefined" ? window.open("", "_blank") : null;
  try {
    const url = await getUrl();
    if (!url) throw new Error("No link was returned");
    if (tab && !tab.closed) {
      tab.opener = null;
      tab.location.href = url;
    } else if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
    return url;
  } catch (error) {
    if (tab && !tab.closed) tab.close();
    throw error;
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
