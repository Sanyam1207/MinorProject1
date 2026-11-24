import { Component } from "react";
import ErrorState from "./ErrorState.jsx";

const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError/i;

/**
 * Keeps one crashing panel from blanking the app. `resetKey` change (e.g. the
 * active panel id) clears the error. `fallback` may be a node or
 * `(error, reset) => node`.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error: error ?? new Error("Unknown error") };
  }

  static getDerivedStateFromProps(props, state) {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error, info) {
    if (error?.name !== "PanelUnavailableError") console.error("[ErrorBoundary]", error, info?.componentStack);
  }

  reset() {
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === "function") return fallback(error, this.reset);
    if (fallback !== undefined) return fallback;
    if (CHUNK_ERROR.test(String(error?.message ?? ""))) {
      return (
        <ErrorState
          title="A NEW VERSION IS AVAILABLE"
          error="This part of the app was updated. Reload to continue."
          retryLabel="RELOAD APP"
          onRetry={() => window.location.reload()}
        />
      );
    }
    return <ErrorState error={error} title="THIS PANEL CRASHED" retryLabel="RELOAD PANEL" onRetry={this.reset} />;
  }
}
