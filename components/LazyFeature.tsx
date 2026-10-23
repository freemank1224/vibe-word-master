import React, { Component, Suspense, lazy } from 'react';

type BoundaryProps = {
  children: React.ReactNode;
  label: string;
  overlay?: boolean;
  onRetry: () => void;
  onClose?: () => void;
};

const panelClass = 'rounded-2xl border border-mid-charcoal bg-dark-charcoal p-6 text-center text-text-light';
const containerClass = (overlay?: boolean) => overlay
  ? 'fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4'
  : 'flex min-h-48 items-center justify-center p-4';

class FeatureLoadBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error(`[feature] ${this.props.label} failed to load:`, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={containerClass(this.props.overlay)} role="alert">
        <div className={panelClass}>
          <p className="mb-2">{this.props.label}暂时无法打开。网络恢复后，请刷新页面重试。</p>
          <p className="mb-4 text-sm text-text-dark">刷新会清空尚未保存的输入，请先保存需要保留的内容。</p>
          <div className="flex justify-center gap-3">
            <button type="button" className="rounded-lg bg-electric-blue px-4 py-2 text-charcoal" onClick={this.props.onRetry}>刷新页面重试</button>
            {this.props.onClose && <button type="button" className="rounded-lg bg-mid-charcoal px-4 py-2" onClick={this.props.onClose}>返回</button>}
          </div>
        </div>
      </div>
    );
  }
}

/** Each feature owns its loading boundary so a slow chunk never hides the app shell. */
export function createLazyFeature<P extends object>(
  load: () => Promise<{ default: React.ComponentType<P> }>,
  label: string,
  overlay = false,
): React.FC<P> {
  const Feature = lazy(load);
  const DeferredFeature: React.FC<P> = (props) => {
    const controls = props as { onClose?: () => void; onCancel?: () => void; onBackToLogin?: () => void };
    const onClose = controls.onClose || controls.onCancel || controls.onBackToLogin;
    return (
      // Browsers can cache a failed import for the document's lifetime. Only a
      // user-requested reload reliably clears that registry; never auto-reload
      // because an unrelated feature may have unsaved input.
      <FeatureLoadBoundary label={label} overlay={overlay} onClose={onClose} onRetry={() => window.location.reload()}>
        <Suspense fallback={
          <div className={containerClass(overlay)} role="status" aria-live="polite">
            <div className={panelClass}>
              <p>正在准备{label}…</p>
              {onClose && <button type="button" className="mt-4 rounded-lg bg-mid-charcoal px-4 py-2" onClick={onClose}>返回</button>}
            </div>
          </div>
        }>
          <Feature {...props} />
        </Suspense>
      </FeatureLoadBoundary>
    );
  };
  DeferredFeature.displayName = `Deferred(${label})`;
  return DeferredFeature;
}
