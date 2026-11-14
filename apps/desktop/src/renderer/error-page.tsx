/**
 * The renderer's error surface.
 *
 * Distinct from `main/bootstrap-error.ts`, and the distinction is worth stating because
 * two error pages is normally one too many:
 *
 *   The main-process page is for a shell that never got a page loaded at all -- no
 *   protocol, no bundle, no React. It has to be a self-contained HTML string.
 *
 *   This one runs *inside* a working renderer: React is available, the catalogue is
 *   available, the token layer is available. It is what a page shows when a subtree
 *   failed to render -- a route that threw, a data load that rejected.
 *
 * A page that could use the component library and rendered a string instead would lose
 * the theme, the locale and the accessibility work that already exists. A page that
 * reached for the main-process page would not render at all.
 *
 * It reuses `ErrorState` from `@haruyuki/ui` rather than building a second error surface:
 * that component is already the product's answer to "something went wrong", and a second
 * one would be a second visual language for the same message.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

import { ErrorState, useT } from "@haruyuki/ui";

/** Props of {@link RendererErrorPage}. */
export interface RendererErrorPageProps {
  /** What to show. `null` renders nothing rather than an empty error. */
  error: Error | null;
  /** Called when the user asks to try again. */
  onRetry?: () => void;
}

/**
 * The full-window error surface.
 *
 * The heading comes from the catalogue (`common.state.error`) rather than being a literal:
 * `ErrorState` documents its `title` as "already translated by the caller", and this page
 * renders inside a live provider, so the translation is available here. The technical
 * detail is the thrown message, passed as `detail` rather than as the heading -- a stack
 * trace is not a sentence to lead with.
 *
 * @param props the failure and the retry handler
 * @returns the page
 */
export function RendererErrorPage({ error, onRetry }: RendererErrorPageProps): ReactNode {
  const t = useT();

  // No error, no page. Rendering an error surface "just in case" would make every
  // successful load flash it, and a surface that appears when nothing is wrong teaches
  // the user to ignore it.
  if (error === null) return null;

  return (
    <ErrorState
      title={t("common.state.error")}
      detail={error.message}
      {...(onRetry === undefined ? {} : { onRetry })}
    />
  );
}

/** Props of {@link ErrorBoundary}. */
export interface ErrorBoundaryProps {
  /** The subtree to protect. */
  children: ReactNode;
  /** Rendered instead of the subtree once it has thrown. */
  fallback: (error: Error, reset: () => void) => ReactNode;
}

/** State of {@link ErrorBoundary}. */
interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches a render-time throw in the subtree below it.
 *
 * React has no hook for this, so it is the one class component in the shell. The
 * alternative -- letting a throw reach the root -- unmounts the whole tree and leaves a
 * blank window, which on a desktop shell looks like a crash with no message.
 *
 * Only render errors are caught. A rejected promise or an event handler's throw is not a
 * render error and does not reach here; those belong to whatever owns the async work.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  /** @returns the initial state */
  constructor(props: ErrorBoundaryProps) {
    super(props);

    this.state = { error: null };
  }

  /**
   * Enter the failed state.
   *
   * @param error the thrown value
   * @returns the next state
   */
  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  /**
   * Record the failure.
   *
   * No `console.error`: the shell logs to a file through the main process, and a renderer
   * console message is invisible unless the inspector is already open -- which, in a
   * packaged build, it is not. The user sees the surface; the log gets the event through
   * whatever channel the page's own error reporting uses.
   *
   * @param _error the thrown value
   * @param _info React's component stack
   */
  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Intentionally empty. See the doc comment: reporting belongs to the page's own
    // error channel, not to a console the user cannot see.
  }

  /**
   * Clear the failure so the subtree can try again.
   *
   * @returns nothing
   */
  reset = (): void => {
    this.setState({ error: null });
  };

  /** @returns the subtree, or the fallback once it has thrown */
  render(): ReactNode {
    if (this.state.error !== null) {
      return this.props.fallback(this.state.error, this.reset);
    }

    return this.props.children;
  }
}
