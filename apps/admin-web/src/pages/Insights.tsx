import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Button, Card, DataTable, Empty, ErrorState, FormError, PageHeader, Spinner } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { d, dt, inr, num, pct, title } from '@/lib/format';
import { useAction, useGet } from '@/lib/hooks';
import { useCan } from '@/stores/auth';
import { useUi } from '@/stores/ui';

const PALETTE = ['#16a34a', '#2563eb', '#f59e0b', '#db2777', '#7c3aed', '#0891b2', '#dc2626', '#65a30d'];
const axis = { stroke: 'hsl(var(--subtle))', fontSize: 11 };
const tip = { contentStyle: { background: 'hsl(var(--panel))', border: '1px solid hsl(var(--border))' } };

export function Analytics() {
  const siteId = useUi((s) => s.siteId) ?? undefined;
  const [days, setDays] = useState(7);
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  const sales = useQuery({ queryKey: ['sales', days, siteId], queryFn: () => api(`/reports/sales${qs({ from, warehouseId: siteId })}`) });
  const inv = useQuery({ queryKey: ['inv-report', siteId], queryFn: () => api(`/reports/inventory${qs({ warehouseId: siteId })}`) });
  const ful = useQuery({ queryKey: ['ful-report', days, siteId], queryFn: () => api(`/reports/fulfillment${qs({ from, warehouseId: siteId })}`) });
  const wh = useQuery({ queryKey: ['wh-report', days], queryFn: () => api(`/reports/warehouse${qs({ from })}`) });
  const proc = useQuery({ queryKey: ['proc-report'], queryFn: () => api('/reports/procurement') });
  if (sales.error) return <ErrorState error={sales.error} />;
  const s: any = sales.data;
  const i: any = inv.data;
  const f: any = ful.data;
  return (
    <>
      <PageHeader title="Analytics" subtitle="All charts are computed from transactional data at request time"
        actions={[7, 30, 90].map((n) => <Button key={n} size="sm" variant={days === n ? 'primary' : 'secondary'} onClick={() => setDays(n)}>{n} days</Button>)} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Sales by category">
          {!s ? <Spinner /> : !s.byCategory.length ? <Empty message="No sales in this period." /> : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={s.byCategory} dataKey="revenue" nameKey="category" outerRadius={90} label={(e: any) => e.category}>
                  {s.byCategory.map((_: any, idx: number) => <Cell key={idx} fill={PALETTE[idx % PALETTE.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => inr(v)} {...tip} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>
        <Card title="Store performance (revenue)">
          {!s ? <Spinner /> : !s.byStore.length ? <Empty message="No sales in this period." /> : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={s.byStore}><CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" /><XAxis dataKey="code" {...axis} /><YAxis {...axis} /><Tooltip formatter={(v: number) => inr(v)} {...tip} /><Bar dataKey="revenue" fill="hsl(var(--brand))" /></BarChart>
            </ResponsiveContainer>
          )}
        </Card>
        <Card title="Inventory distribution by site">
          {!i ? <Spinner /> : !i.distribution.length ? <Empty message="No stock." /> : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={i.distribution}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" /><XAxis dataKey="code" {...axis} /><YAxis {...axis} /><Tooltip {...tip} /><Legend />
                <Bar stackId="a" dataKey="onHand" name="On hand" fill={PALETTE[0]} /><Bar stackId="a" dataKey="quarantined" name="Quarantined" fill={PALETTE[2]} />
                <Bar stackId="a" dataKey="damaged" name="Damaged" fill={PALETTE[6]} /><Bar stackId="a" dataKey="inTransit" name="In transit" fill={PALETTE[1]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
        <Card title="Expiry analysis (units)">
          {!i ? <Spinner /> : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={i.expiry}><CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" /><XAxis dataKey="bucket" {...axis} /><YAxis {...axis} /><Tooltip {...tip} /><Bar dataKey="units" fill={PALETTE[2]} /></BarChart>
            </ResponsiveContainer>
          )}
        </Card>
        <Card title={<>Fulfilment bottlenecks {f?.bottleneck && <Badge tone="warn">slowest: {title(f.bottleneck)}</Badge>}</>}>
          {!f ? <Spinner /> : !f.stages.length ? <Empty message="Not enough order history." /> : (
            <DataTable rows={f.stages} rowKey={(r: any) => r.stage} columns={[
              { key: 's', header: 'Stage', render: (r: any) => title(r.stage) },
              { key: 'o', header: 'Orders', render: (r: any) => r.orders, className: 'text-right' },
              { key: 'a', header: 'Avg time in stage', render: (r: any) => `${num(r.avgSeconds / 60, 1)} min`, className: 'text-right' },
              { key: 'p', header: 'P90', render: (r: any) => `${num(r.p90Seconds / 60, 1)} min`, className: 'text-right' },
            ]} />
          )}
        </Card>
        <Card title="Top products">
          {!s ? <Spinner /> : !s.topProducts.length ? <Empty message="No sales." /> : (
            <DataTable rows={s.topProducts} rowKey={(r: any) => r.skuCode} columns={[
              { key: 'n', header: 'Product', render: (r: any) => r.name },
              { key: 'u', header: 'Units', render: (r: any) => num(r.units), className: 'text-right' },
              { key: 'r', header: 'Revenue', render: (r: any) => inr(r.revenue), className: 'text-right' },
            ]} />
          )}
        </Card>
        <Card title="Warehouse performance">
          {!wh.data ? <Spinner /> : (
            <DataTable rows={wh.data as any[]} rowKey={(r: any) => r.id} columns={[
              { key: 'c', header: 'Site', render: (r: any) => r.code },
              { key: 'o', header: 'Orders', render: (r: any) => r.orders, className: 'text-right' },
              { key: 'f', header: 'Avg fulfil', render: (r: any) => (r.avgFulfillmentMinutes ? `${num(r.avgFulfillmentMinutes, 1)} min` : '—'), className: 'text-right' },
              { key: 'p', header: 'Avg pick', render: (r: any) => (r.avgPickSeconds ? `${num(r.avgPickSeconds)} s` : '—'), className: 'text-right' },
              { key: 'u', header: 'Utilization', render: (r: any) => pct(r.utilization), className: 'text-right' },
            ]} />
          )}
        </Card>
        <Card title="Supplier performance">
          {!proc.data ? <Spinner /> : !(proc.data as any).suppliers.length ? <Empty message="No purchase orders." /> : (
            <DataTable rows={(proc.data as any).suppliers} rowKey={(r: any) => r.code} columns={[
              { key: 'n', header: 'Supplier', render: (r: any) => r.name },
              { key: 'o', header: 'POs', render: (r: any) => r.orders, className: 'text-right' },
              { key: 'f', header: 'Fill rate', render: (r: any) => pct(r.fillRate), className: 'text-right' },
              { key: 'r', header: 'Rejected', render: (r: any) => num(r.rejected), className: 'text-right' },
            ]} />
          )}
        </Card>
      </div>
    </>
  );
}

export function Intelligence() {
  const can = useCan();
  const siteId = useUi((s) => s.siteId);
  const status = useGet<any>(['/intelligence/status'], '/intelligence/status');
  const forecasts = useGet<any[]>(['/intelligence/forecasts', siteId], siteId ? `/intelligence/forecasts?warehouseId=${siteId}` : null);
  const recs = useGet<any[]>(['/intelligence/replenishment', siteId], siteId ? `/intelligence/replenishment?warehouseId=${siteId}` : null);
  const anomalies = useGet<any>(['/intelligence/anomalies', siteId], siteId ? `/intelligence/anomalies/${siteId}` : null);
  const run = useAction(() => api('/intelligence/forecasts/run', { method: 'POST', json: { warehouseId: siteId, horizonDays: 7 } }), ['/intelligence/forecasts']);
  const replenish = useAction(() => api('/intelligence/replenishment/run', { method: 'POST', json: { warehouseId: siteId } }), ['/intelligence/replenishment']);
  const accept = useAction(() => api('/intelligence/replenishment/accept', { method: 'POST', json: { ids: recs.data!.map((r) => r.id) } }), ['/intelligence/replenishment', '/inventory/transfers']);
  const st = status.data;
  return (
    <>
      <PageHeader title="AI intelligence" subtitle={st && <>Engine: <b>{st.status}</b>{st.models ? ` · forecast ${st.models.forecast} · anomaly ${st.models.anomaly}` : ' · rule-based fallbacks active (results are labelled)'}</>}
        actions={siteId && <>
          <Button variant="secondary" loading={run.isPending} onClick={() => run.mutate(undefined)}>Run 7-day forecast</Button>
          {can('inventory.transfer') && <Button loading={replenish.isPending} onClick={() => replenish.mutate(undefined)}>Compute replenishment</Button>}
        </>} />
      {!siteId && <Empty message="Select a site in the top bar." />}
      <FormError error={run.error || replenish.error || accept.error} />
      {siteId && (
        <div className="grid gap-4">
          <Card title="Demand forecasts">
            {forecasts.isLoading ? <Spinner /> : !forecasts.data?.length ? <Empty message="No forecasts yet. Run one above." /> : (
              <DataTable rows={forecasts.data} rowKey={(f) => f.skuId} columns={[
                { key: 'p', header: 'Product', render: (f) => <div><p>{f.productName}</p><p className="font-mono text-[11px] text-subtle">{f.skuCode}</p></div> },
                { key: 'o', header: 'Predicted outcome', render: (f) => `${num(f.predictedOutcome.unitsNextDays, 1)} units / ${f.predictedOutcome.horizonDays}d (${num(f.predictedOutcome.range[0], 1)}–${num(f.predictedOutcome.range[1], 1)})` },
                { key: 'c', header: 'Confidence', render: (f) => (f.confidence === null ? <span className="text-subtle">n/a (rule)</span> : pct(f.confidence)) },
                { key: 'm', header: 'Method', render: (f) => <Badge tone={f.isModelPrediction ? 'brand' : 'neutral'}>{f.isModelPrediction ? 'Model' : 'Rule'} · {f.method}</Badge> },
                { key: 'v', header: 'Model version', render: (f) => <span className="font-mono text-xs">{f.modelVersion}</span> },
                { key: 'd', header: 'Data period', render: (f) => `${d(f.dataPeriod.from)} – ${d(f.dataPeriod.to)}` },
                { key: 'u', header: 'Updated', render: (f) => dt(f.lastUpdate) },
              ]} />
            )}
          </Card>
          <Card title="Replenishment recommendations" actions={recs.data?.length && can('inventory.transfer') ? <Button size="sm" loading={accept.isPending} onClick={() => accept.mutate(undefined)}>Create transfer for all</Button> : null}>
            {!recs.data?.length ? <Empty message="No open recommendations." /> : (
              <DataTable rows={recs.data} rowKey={(r) => r.id} columns={[
                { key: 's', header: 'SKU', render: (r) => <span className="font-mono text-xs">{r.skuId.slice(0, 8)}</span> },
                { key: 'a', header: 'Available now', render: (r) => r.currentAvailable, className: 'text-right' },
                { key: 'q', header: 'Recommended', render: (r) => <b>{r.recommendedQty}</b>, className: 'text-right' },
                { key: 'b', header: 'Basis', render: (r) => <Badge tone={r.basis === 'FORECAST' ? 'brand' : 'neutral'}>{title(r.basis)}</Badge> },
                { key: 'e', header: 'Why', render: (r) => <span className="text-xs text-subtle">{Object.entries(r.explanation).map(([k, v]) => `${k}: ${v}`).join(' · ')}</span> },
              ]} />
            )}
          </Card>
          <Card title={<>Unusual inventory movements {anomalies.data && <Badge>{anomalies.data.method}</Badge>}</>}>
            {!anomalies.data?.anomalies?.length ? <Empty message="Nothing unusual in the last 30 days." /> : (
              <DataTable rows={anomalies.data.anomalies} rowKey={(a: any) => a.sku_id + a.day + a.movement_type} columns={[
                { key: 'd', header: 'Day', render: (a: any) => d(a.day) },
                { key: 't', header: 'Type', render: (a: any) => a.movement_type },
                { key: 's', header: 'SKU', render: (a: any) => <span className="font-mono text-xs">{String(a.sku_id).slice(0, 8)}</span> },
                { key: 'u', header: 'Units', render: (a: any) => a.units, className: 'text-right' },
                { key: 'sc', header: 'Score', render: (a: any) => num(a.score, 2), className: 'text-right' },
              ]} />
            )}
          </Card>
        </div>
      )}
    </>
  );
}
