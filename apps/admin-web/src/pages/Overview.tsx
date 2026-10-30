import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, ErrorState, PageHeader, Spinner, Stat } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { inr, num, pct } from '@/lib/format';
import { useUi } from '@/stores/ui';

const axis = { stroke: 'hsl(var(--subtle))', fontSize: 11 };

export default function Overview() {
  const siteId = useUi((s) => s.siteId) ?? undefined;
  const overview = useQuery({ queryKey: ['overview', siteId], queryFn: () => api(`/reports/overview${qs({ warehouseId: siteId })}`), refetchInterval: 30_000 });
  const hourly = useQuery({
    queryKey: ['sales-hourly', siteId],
    queryFn: () => api(`/reports/sales${qs({ granularity: 'hour', from: new Date(Date.now() - 86_400_000).toISOString(), warehouseId: siteId })}`),
  });
  const daily = useQuery({ queryKey: ['sales-daily', siteId], queryFn: () => api(`/reports/sales${qs({ granularity: 'day', warehouseId: siteId })}`) });

  if (overview.isLoading) return <Spinner />;
  if (overview.error) return <ErrorState error={overview.error} onRetry={() => overview.refetch()} />;
  const o: any = overview.data;

  return (
    <>
      <PageHeader title="Operations overview" subtitle={`Live from the operational database · refreshed ${new Date(o.generatedAt).toLocaleTimeString()}`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="Active warehouses" value={num(o.sites.activeWarehouses)} />
        <Stat label="Active dark stores" value={num(o.sites.activeDarkStores)} />
        <Stat label="Active SKUs" value={num(o.catalog.totalSkus)} />
        <Stat label="Inventory value (cost)" value={inr(o.inventory.inventoryValuation)} />
        <Stat label="Low-stock SKU·sites" value={num(o.inventory.lowStockSkus)} tone={o.inventory.lowStockSkus ? 'warn' : undefined} />
        <Stat label="Expiring ≤ 3 days" value={`${num(o.inventory.expiringWithin3Days.units)} u`} hint={`${o.inventory.expiringWithin3Days.batches} batches`} tone={o.inventory.expiringWithin3Days.units ? 'warn' : undefined} />
      </div>

      <h2 className="mb-2 mt-6 text-sm font-semibold text-subtle">Orders today</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-7">
        <Stat label="Total" value={num(o.ordersToday.total)} />
        <Stat label="Pending" value={num(o.ordersToday.pending)} />
        <Stat label="Picking" value={num(o.ordersToday.picking)} />
        <Stat label="Packing" value={num(o.ordersToday.packing)} />
        <Stat label="Dispatched" value={num(o.ordersToday.dispatched)} />
        <Stat label="Delivered" value={num(o.ordersToday.delivered)} tone="ok" />
        <Stat label="Cancelled" value={num(o.ordersToday.cancelled)} tone={o.ordersToday.cancelled ? 'bad' : undefined} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Avg order → delivery" value={o.performance.avgFulfillmentMinutes ? `${num(o.performance.avgFulfillmentMinutes, 1)} min` : '—'} />
        <Stat label="Avg pick time" value={o.performance.avgPickSeconds ? `${num(o.performance.avgPickSeconds)} s` : '—'} />
        <Stat label="Stockout rate" value={pct(o.inventory.stockoutRate)} />
        <Stat label="Bin utilization" value={pct(o.performance.warehouseUtilization)} />
        <Stat label="Delivery success" value={pct(o.performance.deliverySuccessRate)} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Orders per hour (last 24h)">
          {hourly.isLoading ? <Spinner /> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={(hourly.data as any)?.series.map((s: any) => ({ ...s, label: new Date(s.bucket).getHours() + ':00' }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" {...axis} />
                <YAxis allowDecimals={false} {...axis} />
                <Tooltip contentStyle={{ background: 'hsl(var(--panel))', border: '1px solid hsl(var(--border))' }} />
                <Bar dataKey="orders" fill="hsl(var(--brand))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
        <Card title="Daily revenue (7 days)">
          {daily.isLoading ? <Spinner /> : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={(daily.data as any)?.series.map((s: any) => ({ ...s, label: new Date(s.bucket).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" {...axis} />
                <YAxis {...axis} />
                <Tooltip formatter={(v: number) => inr(v)} contentStyle={{ background: 'hsl(var(--panel))', border: '1px solid hsl(var(--border))' }} />
                <Line dataKey="revenue" stroke="hsl(var(--brand))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>
    </>
  );
}
