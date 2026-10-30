import { useQuery } from '@tanstack/react-query';
import { ReactNode, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Spinner } from '@/components/ui';
import { AppShell } from '@/layouts/AppShell';
import { api } from '@/lib/api';
import { AuditLogs, Employees, Notifications, Settings, SyncStatus } from '@/pages/Admin';
import { Analytics, Intelligence } from '@/pages/Insights';
import Inventory from '@/pages/Inventory';
import Login from '@/pages/Login';
import { PackerApp, PickerApp, RiderApp } from '@/pages/Mobile';
import { Customers, Delivery, Fulfillment, Payments } from '@/pages/Operations';
import { OrderDetail, OrderList } from '@/pages/Orders';
import Overview from '@/pages/Overview';
import { PurchaseOrderDetail, PurchaseOrders, Suppliers } from '@/pages/Procurement';
import { ProductDetail, ProductList } from '@/pages/Products';
import { WarehouseDetail, WarehouseList } from '@/pages/Warehouses';
import { Me, useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';

function RequireAuth({ children }: { children: ReactNode }) {
  const { accessToken, me, setMe } = useAuth();
  const q = useQuery({ queryKey: ['me', accessToken], queryFn: () => api<Me>('/auth/me'), enabled: !!accessToken });
  useEffect(() => {
    if (q.data) setMe(q.data);
  }, [q.data, setMe]);
  if (!accessToken) return <Navigate to="/login" replace />;
  if (!me && q.isLoading) return <Spinner label="Loading your workspace" />;
  return <>{children}</>;
}

function Home() {
  const me = useAuth((s) => s.me);
  if (me && !me.isSuperAdmin && !me.permissions.includes('reports.read')) {
    if (me.permissions.includes('fulfillment.pick')) return <Navigate to="/ops/pick" replace />;
    if (me.permissions.includes('fulfillment.pack')) return <Navigate to="/ops/pack" replace />;
    if (me.permissions.includes('delivery.perform')) return <Navigate to="/rider" replace />;
    return <Navigate to="/notifications" replace />;
  }
  return <Overview />;
}

export default function App() {
  const theme = useUi((s) => s.theme);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/ops/pick" element={<RequireAuth><PickerApp /></RequireAuth>} />
      <Route path="/ops/pack" element={<RequireAuth><PackerApp /></RequireAuth>} />
      <Route path="/rider" element={<RequireAuth><RiderApp /></RequireAuth>} />
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<Home />} />
        <Route path="warehouses" element={<WarehouseList />} />
        <Route path="warehouses/:id" element={<WarehouseDetail />} />
        <Route path="dark-stores" element={<WarehouseList darkStores />} />
        <Route path="products" element={<ProductList />} />
        <Route path="products/:id" element={<ProductDetail />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="procurement" element={<PurchaseOrders />} />
        <Route path="procurement/:id" element={<PurchaseOrderDetail />} />
        <Route path="suppliers" element={<Suppliers />} />
        <Route path="orders" element={<OrderList />} />
        <Route path="orders/:id" element={<OrderDetail />} />
        <Route path="fulfillment" element={<Fulfillment />} />
        <Route path="delivery" element={<Delivery />} />
        <Route path="customers" element={<Customers />} />
        <Route path="payments" element={<Payments />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="intelligence" element={<Intelligence />} />
        <Route path="employees" element={<Employees />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="sync" element={<SyncStatus />} />
        <Route path="audit" element={<AuditLogs />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
