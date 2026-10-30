import {
  Activity, BarChart3, Bell, Boxes, Brain, Building2, ClipboardList, CreditCard, FileClock, LayoutDashboard, LogOut, Moon, Package,
  PackageCheck, RefreshCw, Settings, ShoppingCart, Store, Sun, Truck, UserCog, Users, Warehouse,
} from 'lucide-react';
import { ReactNode, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { cn, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useSites } from '@/lib/hooks';
import { useAuth, useCan } from '@/stores/auth';
import { useUi } from '@/stores/ui';

const NAV: { to: string; label: string; icon: ReactNode; perm?: string }[] = [
  { to: '/', label: 'Overview', icon: <LayoutDashboard />, perm: 'reports.read' },
  { to: '/warehouses', label: 'Warehouses', icon: <Warehouse />, perm: 'warehouses.read' },
  { to: '/dark-stores', label: 'Dark Stores', icon: <Store />, perm: 'dark_stores.read' },
  { to: '/products', label: 'Products', icon: <Package />, perm: 'products.read' },
  { to: '/inventory', label: 'Inventory', icon: <Boxes />, perm: 'inventory.read' },
  { to: '/procurement', label: 'Procurement', icon: <ClipboardList />, perm: 'purchase_orders.read' },
  { to: '/suppliers', label: 'Suppliers', icon: <Building2 />, perm: 'suppliers.read' },
  { to: '/orders', label: 'Orders', icon: <ShoppingCart />, perm: 'orders.read' },
  { to: '/fulfillment', label: 'Fulfillment', icon: <PackageCheck />, perm: 'fulfillment.pick' },
  { to: '/delivery', label: 'Delivery', icon: <Truck />, perm: 'delivery.manage' },
  { to: '/customers', label: 'Customers', icon: <Users />, perm: 'customers.read' },
  { to: '/payments', label: 'Payments', icon: <CreditCard />, perm: 'payments.read' },
  { to: '/analytics', label: 'Analytics', icon: <BarChart3 />, perm: 'reports.read' },
  { to: '/intelligence', label: 'AI Intelligence', icon: <Brain />, perm: 'ai.read' },
  { to: '/employees', label: 'Employees', icon: <UserCog />, perm: 'users.read' },
  { to: '/notifications', label: 'Notifications', icon: <Bell /> },
  { to: '/sync', label: 'Store Sync', icon: <RefreshCw />, perm: 'sync.manage' },
  { to: '/audit', label: 'Audit Logs', icon: <FileClock />, perm: 'audit.read' },
  { to: '/settings', label: 'System Settings', icon: <Settings />, perm: 'settings.manage' },
];

export function AppShell() {
  const can = useCan();
  const { me, logout, refreshToken } = useAuth();
  const { theme, toggleTheme, siteId, setSite } = useUi();
  const sites = useSites();
  const navigate = useNavigate();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const signOut = async () => {
    try {
      if (refreshToken) await api('/auth/logout', { method: 'POST' });
    } finally {
      logout();
      navigate('/login');
    }
  };

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-panel md:flex">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-brand text-brand-fg"><Activity className="h-4 w-4" /></div>
          <span className="font-semibold tracking-tight">QuickStore</span>
        </div>
        <nav className="flex-1 overflow-y-auto p-2" aria-label="Main">
          {NAV.filter((n) => !n.perm || can(n.perm)).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                cn('flex items-center gap-3 rounded-md px-3 py-2 text-sm [&_svg]:h-4 [&_svg]:w-4', isActive ? 'bg-brand/10 font-medium text-brand' : 'text-subtle hover:bg-muted hover:text-fg')
              }
            >
              {n.icon}
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-border p-3 text-xs">
          <p className="truncate font-medium">{me?.fullName}</p>
          <p className="truncate text-subtle">{me?.roles.map((r) => r.name).join(', ') || (me?.isSuperAdmin ? 'Super Admin' : '')}</p>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-3 border-b border-border bg-panel px-4">
          <div className="flex items-center gap-2">
            <label className="text-xs text-subtle" htmlFor="site">Site</label>
            <Select id="site" value={siteId ?? ''} onChange={(e) => setSite(e.target.value || null)} className="max-w-[240px]">
              <option value="">All permitted sites</option>
              {sites.data?.data.map((s: any) => (
                <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
              ))}
            </Select>
          </div>
          <div className="flex items-center gap-1">
            <NavLink to="/ops/pick" className="rounded-md px-3 py-1.5 text-xs text-subtle hover:bg-muted">Mobile ops</NavLink>
            <button aria-label="Toggle theme" onClick={toggleTheme} className="rounded-md p-2 hover:bg-muted">
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button aria-label="Sign out" onClick={signOut} className="rounded-md p-2 hover:bg-muted"><LogOut className="h-4 w-4" /></button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
