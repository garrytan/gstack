import { NavLink, Outlet } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: 'D' },
  { to: '/skills', label: 'Skills', icon: 'S' },
  { to: '/qa', label: 'QA Reports', icon: 'Q' },
  { to: '/evals', label: 'Evals', icon: 'E' },
  { to: '/browse', label: 'Browse', icon: 'B' },
];

export default function Layout() {
  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 border-r border-gstack-border bg-gstack-surface flex flex-col">
        <div className="p-4 border-b border-gstack-border">
          <h1 className="text-lg font-semibold text-white tracking-tight">
            <span className="text-gstack-accent">g</span>stack
          </h1>
          <p className="text-xs text-gstack-dim mt-0.5">dashboard</p>
        </div>
        <nav className="flex-1 py-2">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                  isActive
                    ? 'bg-gstack-accent-bg text-gstack-accent border-r-2 border-gstack-accent'
                    : 'text-gstack-muted hover:text-gstack-text hover:bg-white/5'
                }`
              }
            >
              <span className="w-5 h-5 rounded bg-gstack-border flex items-center justify-center text-xs font-mono font-bold">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-gstack-border text-xs text-gstack-dim font-mono">
          v0.3.3
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
