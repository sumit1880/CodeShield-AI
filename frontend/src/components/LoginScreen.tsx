import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { initGoogleSignIn, loadGsiScript, renderGoogleButton } from '../lib/googleIdentity';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

export function LoginScreen() {
  const { signIn, sessionExpired, clearSessionExpired } = useAuth();
  const buttonRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!CLIENT_ID) {
      setLoadError('VITE_GOOGLE_CLIENT_ID is not set. Add it to your .env file to enable sign-in.');
      return;
    }
    let cancelled = false;
    loadGsiScript()
      .then(() => {
        if (cancelled) return;
        initGoogleSignIn(CLIENT_ID, signIn);
        if (buttonRef.current) renderGoogleButton(buttonRef.current);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not reach Google Identity Services. Check your connection and reload.');
      });
    return () => {
      cancelled = true;
    };
  }, [signIn]);

  return (
    <div className="relative flex min-h-screen items-center justify-center px-6">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden">
        <div className="h-24 w-full animate-scan bg-gradient-to-b from-accent/25 to-transparent" />
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <ShieldMark />
          <div>
            <p className="font-mono text-sm tracking-tight text-ink">CodeShield</p>
            <p className="font-mono text-xs text-ink-faint">/ console</p>
          </div>
        </div>

        <div className="border border-line bg-panel p-6">
          <p className="font-mono text-xs text-ink-dim">access.required()</p>
          <h1 className="mt-2 font-mono text-lg leading-snug text-ink">Sign in to run an analysis</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-dim">
            Every scan runs against your Google identity so the API can rate-limit fairly and keep the queue
            honest. Nothing is submitted to the analyzer until you're signed in.
          </p>

          {sessionExpired && (
            <p className="mt-4 border border-high/40 bg-high/10 px-3 py-2 text-sm text-high">
              Your session ended. Sign in again to continue.
            </p>
          )}

          <div className="mt-6 flex justify-center">
            <div ref={buttonRef} onLoad={clearSessionExpired} />
          </div>

          {loadError && <p className="mt-4 text-sm text-critical">{loadError}</p>}
        </div>

        <p className="mt-4 text-center font-mono text-xs text-ink-faint">
          Auth: Google ID token · verified per-request, never stored server-side
        </p>
      </div>
    </div>
  );
}

function ShieldMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z"
        stroke="#E8A33D"
        strokeWidth="1.4"
        fill="none"
      />
      <path d="M9 12l2 2 4-4" stroke="#E8A33D" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
