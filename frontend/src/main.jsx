import "./lib/polyfills.js"; // MUST stay first: crypto.randomUUID on insecure (LAN http) origins
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { BrowserRouter } from "react-router-dom";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { Toaster } from "react-hot-toast";
import "./index.css";
import App from "./App.jsx";
import { store } from "./store/index.js";
import { aiRequestHandler } from "./services/aiRequestHandler.js";
import { bindUiActions } from "./workspace/uiActions.js";
import { bootstrapSession, logout } from "./features/auth/session.js";
import { APP_NAME, GOOGLE_CLIENT_ID } from "./lib/config.js";
import { socket } from "./lib/socket.js";
import { STARK_TOAST_STYLE } from "./ui/toast.js";

document.title = APP_NAME;

aiRequestHandler.initialize(store);
bindUiActions(store);
store.dispatch(bootstrapSession());

// http.js fires this when the single-flight token refresh fails.
window.addEventListener("auth:expired", () => store.dispatch(logout({ reason: "expired" })));

// The server revokes sessions (deactivation, password reset, "log out everywhere").
const REVOKED_COPY = {
  deactivated: "This account has been deactivated.",
  password_reset: "Your password was changed. Please sign in again.",
  admin_reset: "Your password was reset by the placement office. Please sign in again.",
  logout_all: "You were signed out on all devices.",
};
socket.on("auth:revoked", (payload) => {
  store.dispatch(logout({ reason: "expired", message: REVOKED_COPY[payload?.reason] }));
});

const app = (
  <>
    <App />
    <Toaster position="top-center" toastOptions={{ style: STARK_TOAST_STYLE }} containerStyle={{ top: 12 }} />
  </>
);

createRoot(document.getElementById("root"), {
  // Missing feature panels are expected until every frontend role has shipped; FeatureSlot shows them.
  onCaughtError(error, errorInfo) {
    if (error?.name === "PanelUnavailableError") return;
    console.error(error, errorInfo?.componentStack ?? "");
  },
}).render(
  <StrictMode>
    <Provider store={store}>
      <BrowserRouter>{GOOGLE_CLIENT_ID ? <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>{app}</GoogleOAuthProvider> : app}</BrowserRouter>
    </Provider>
  </StrictMode>,
);
