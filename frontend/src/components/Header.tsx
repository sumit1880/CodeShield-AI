import { useAuth } from '../context/AuthContext';

export function Header({ apiOnline }: { apiOnline: boolean | null }) {
  const { user, signOut } = useAuth();

  return (
    <header className="border-b border-line bg-panel/60 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z" stroke="#E8A33D" strokeWidth="1.4" fill="none" />
            <path d="M9 12l2 2 4-4" stroke="#E8A33D" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="leading-none">
            <p className="font-mono text-sm text-ink">CodeShield</p>
            <p className="font-mono text-[11px] text-ink-faint">/ console</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <span
            className="hidden items-center gap-1.5 font-mono text-xs text-ink-faint sm:flex"
            title={apiOnline === null ? 'Checking API connectivity' : apiOnline ? 'API reachable' : 'API unreachable'}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                apiOnline === null ? 'bg-ink-faint' : apiOnline ? 'bg-confirmed' : 'bg-critical'
              }`}
            />
            {apiOnline === null ? 'checking' : apiOnline ? 'api online' : 'api unreachable'}
          </span>

          {user?.email && <span className="hidden font-mono text-xs text-ink-dim md:inline">{user.email}</span>}

          <button
            onClick={signOut}
            className="border border-line px-3 py-1.5 font-mono text-xs text-ink-dim transition hover:border-line-bright hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
