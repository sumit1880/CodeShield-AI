// Minimal wrapper around Google Identity Services (GSI) — the vanilla
// script, not @react-oauth/google, to keep the dependency count down.
// Docs: https://developers.google.com/identity/gsi/web

interface GsiCredentialResponse {
  credential: string;
  select_by?: string;
}

interface GoogleAccountsId {
  initialize: (config: {
    client_id: string;
    callback: (response: GsiCredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
  }) => void;
  renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
  prompt: () => void;
  disableAutoSelect: () => void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
let scriptPromise: Promise<void> | null = null;

export function loadGsiScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Google Identity script')));
      return;
    }
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Identity script'));
    document.head.appendChild(script);
  });

  return scriptPromise;
}

export interface DecodedIdToken {
  email?: string;
  name?: string;
  picture?: string;
  exp: number; // seconds since epoch
}

/** Decodes the JWT payload without verifying it — verification happens server-side on every request. */
export function decodeIdToken(idToken: string): DecodedIdToken | null {
  try {
    const [, payload] = idToken.split('.');
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof json.exp !== 'number') return null;
    return { email: json.email, name: json.name, picture: json.picture, exp: json.exp };
  } catch {
    return null;
  }
}

export function initGoogleSignIn(clientId: string, onCredential: (idToken: string) => void) {
  window.google?.accounts.id.initialize({
    client_id: clientId,
    callback: (response) => onCredential(response.credential),
    auto_select: false,
    cancel_on_tap_outside: true
  });
}

export function renderGoogleButton(el: HTMLElement) {
  window.google?.accounts.id.renderButton(el, {
    theme: 'filled_black',
    size: 'large',
    shape: 'rectangular',
    text: 'continue_with',
    logo_alignment: 'left'
  });
}

export function disableAutoSelect() {
  window.google?.accounts.id.disableAutoSelect();
}
