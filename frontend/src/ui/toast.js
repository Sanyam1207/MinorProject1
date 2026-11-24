// Stark toasts (FRONTEND.md §11.3). Never use alert()/confirm()/prompt().
//
// react-hot-toast is loaded lazily: its CSS-in-JS runtime touches `document`
// at import time, which would break `node --test` for every pure module that
// imports these helpers (e.g. the AI request handler). In the browser the
// module is already in the main bundle (main.jsx renders <Toaster/>), so the
// first toast is only a microtask late; under node the helpers are no-ops.
import { errorMessage } from "../lib/http.js";

export const STARK_TOAST_STYLE = Object.freeze({
  borderRadius: 0,
  border: "2px solid #000",
  boxShadow: "4px 4px 0 0 #000",
  fontWeight: 700,
  fontSize: 12,
  color: "#000",
  background: "#fff",
  maxWidth: 420,
});

let toastApi = null;
const queue = [];
if (typeof document !== "undefined") {
  import("react-hot-toast")
    .then((module) => {
      toastApi = module.default;
      for (const show of queue.splice(0)) show(toastApi);
    })
    .catch(() => {
      queue.length = 0;
    });
}

const withToast = (show) => {
  if (toastApi) return show(toastApi);
  if (typeof document !== "undefined") queue.push(show);
  return null;
};

const toText = (value, fallback) => {
  if (typeof value === "string") return value.trim() || fallback;
  if (value instanceof Error || (value && typeof value === "object" && "message" in value)) return errorMessage(value, fallback);
  return fallback;
};

export const toastSuccess = (message) =>
  withToast((toast) => toast.success(toText(message, "Done"), { style: STARK_TOAST_STYLE }));

export const toastError = (errorOrMessage, fallback = "Something went wrong") =>
  withToast((toast) => toast.error(toText(errorOrMessage, fallback), { style: STARK_TOAST_STYLE, duration: 6000 }));

export const toastInfo = (message) =>
  withToast((toast) => toast(toText(message, ""), { style: STARK_TOAST_STYLE, icon: "ℹ️" }));
