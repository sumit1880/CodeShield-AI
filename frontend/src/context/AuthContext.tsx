import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { registerUnauthorizedHandler } from '../lib/api';
import { decodeIdToken, disableAutoSelect } from '../lib/googleIdentity';

const STORAGE_KEY = 'codeshield.idToken';

interface AuthUser {
  email?: string;
  name?: string;
  picture?: string;
}

interface AuthContextValue {
  idToken: string | null;
  user: AuthUser | null;
  /** Set when a session ends involuntarily (expiry or a 401 from the API) rather than a manual sign-out. */
  sessionExpired: boolean;
  signIn: (idToken: string) => void;
  signOut: () => void;
  clearSessionExpired: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [idToken, setIdToken] = useState<string | null>(() => sessionStorage.getItem(STORAGE_KEY));
  const [user, setUser] = useState<AuthUser | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const endSession = useCallback((expired: boolean) => {
    sessionStorage.removeItem(STORAGE_KEY);
    setIdToken(null);
    setUser(null);
    disableAutoSelect();
    if (expired) setSessionExpired(true);
  }, []);

  const signIn = useCallback((token: string) => {
    const decoded = decodeIdToken(token);
    if (!decoded) return;
    sessionStorage.setItem(STORAGE_KEY, token);
    setIdToken(token);
    setUser({ email: decoded.email, name: decoded.name, picture: decoded.picture });
    setSessionExpired(false);
  }, []);

  const signOut = useCallback(() => endSession(false), [endSession]);

  // Any 401 from the API (expired/invalid token) bounces back to login without a hard crash.
  useEffect(() => {
    registerUnauthorizedHandler(() => endSession(true));
  }, [endSession]);

  // Proactively expire the session client-side ~1hr in, rather than waiting for a failed request.
  useEffect(() => {
    if (!idToken) return;
    const decoded = decodeIdToken(idToken);
    if (!decoded) return;
    const msUntilExpiry = decoded.exp * 1000 - Date.now();
    if (msUntilExpiry <= 0) {
      endSession(true);
      return;
    }
    const timer = window.setTimeout(() => endSession(true), msUntilExpiry);
    return () => window.clearTimeout(timer);
  }, [idToken, endSession]);

  // Restore user display info from a token already sitting in sessionStorage (e.g. after a page reload).
  useEffect(() => {
    if (idToken && !user) {
      const decoded = decodeIdToken(idToken);
      if (decoded && decoded.exp * 1000 > Date.now()) {
        setUser({ email: decoded.email, name: decoded.name, picture: decoded.picture });
      } else {
        endSession(true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      idToken,
      user,
      sessionExpired,
      signIn,
      signOut,
      clearSessionExpired: () => setSessionExpired(false)
    }),
    [idToken, user, sessionExpired, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
