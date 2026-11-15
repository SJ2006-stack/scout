import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { failed: boolean };

/** Keeps one broken card from blanking the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Scout UI error", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="crash" role="alert">
        <h1>Something went wrong</h1>
        <p>Scout hit an unexpected problem. Your chats are saved. Reload to carry on.</p>
        <button type="button" className="crash-reload" onClick={() => window.location.reload()}>Reload Scout</button>
      </div>
    );
  }
}
