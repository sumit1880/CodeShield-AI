import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Header } from './components/Header';
import { LoginScreen } from './components/LoginScreen';
import { Workspace } from './components/Workspace';
import { checkHealth } from './lib/api';

function Shell() {
  const { idToken } = useAuth();
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);

  // Connectivity indicator only — checked once on load, never polled, so it
  // never spends any of the backend's rate-limit or concurrency budget.
  useEffect(() => {
    let cancelled = false;
    checkHealth().then((ok) => {
      if (!cancelled) setApiOnline(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!idToken) return <LoginScreen />;

  return (
    <div className="min-h-screen">
      <Header apiOnline={apiOnline} />
      <Workspace />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
