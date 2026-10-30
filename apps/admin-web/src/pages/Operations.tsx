import { useState } from 'react';
import { Button, Card, DataTable, Empty, ErrorState, Field, FormError, Input, Modal, PageHeader, Select, Spinner, StatusBadge } from '@/components/ui';
import { api } from '@/lib/api';
import { dt, inr, num } from '@/lib/format';
import { useAction, useGet, useList } from '@/lib/hooks';
import { useCan } from '@/stores/auth';
import { useUi } from '@/stores/ui';

/** Store-level fulfilment board: accepted orders, picking and packing queues. */
export function Fulfillment() {
  const can = useCan();
  const siteId = useUi((s) => s.siteId);
  const accepted = useList<any>('/orders', { darkStoreId: siteId ?? undefined, status: 'ACCEPTED', sortDir: 'asc', sortBy: 'placedAt' }, !!siteId);
  const ready = useList<any>('/orders', { darkStoreId: siteId ?? undefined, status: 'READY_FOR_DISPATCH', sortDir: 'asc', sortBy: 'placedAt' }, !!siteId);
  const picking = useGet<any[]>(['/picking-tasks', siteId], siteId ? `/picking-tasks?warehouseId=${siteId}` : null);
  const packing = useGet<any[]>(['/packing-tasks', siteId], siteId ? `/packing-tasks?warehouseId=${siteId}&status=PENDING` : null);
  const [selected, setSelected] = useState<string[]>([]);
  const createTask = useAction((orderId: string) => api('/picking-tasks', { method: 'POST', json: { orderId } }), ['/orders', '/picking-tasks']);
  const wave = useAction(() => api('/picking-waves', { method: 'POST', json: { orderIds: selected, mode: 'BATCH' } }), ['/orders', '/picking-tasks'], () => setSelected([]));
  const assign = useAction((orderId: string) => api('/deliveries/assign', { method: 'POST', json: { orderId } }), ['/orders', '/deliveries']);

  if (!siteId) return <><PageHeader title="Fulfillment" /><Empty message="Select a dark store in the top bar to see its queues." /></>;
  return (
    <>
      <PageHeader title="Fulfillment" subtitle="Accepted → picking → packing → dispatch" actions={selected.length > 1 && can('fulfillment.dispatch') && <Button loading={wave.isPending} onClick={() => wave.mutate(undefined)}>Create batch pick ({selected.length})</Button>} />
      <FormError error={createTask.error || wave.error || assign.error} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={`Accepted, awaiting pick (${accepted.data?.meta.total ?? 0})`}>
          {accepted.isLoading ? <Spinner /> : !accepted.data?.data.length ? <Empty message="Queue is empty." /> : (
            <DataTable rows={accepted.data.data} rowKey={(o) => o.id} columns={[
              { key: 'sel', header: '', render: (o) => <input type="checkbox" aria-label="Select for batch" checked={selected.includes(o.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, o.id] : selected.filter((x) => x !== o.id))} /> },
              { key: 'n', header: 'Order', render: (o) => <span className="font-mono text-xs">{o.orderNumber}</span> },
              { key: 'a', header: 'Age', render: (o) => `${Math.round((Date.now() - new Date(o.placedAt).getTime()) / 60000)} min` },
              { key: 'i', header: 'Units', render: (o) => o.items.reduce((s: number, i: any) => s + i.quantity, 0) },
              { key: 'x', header: '', render: (o) => can('fulfillment.pick') && <Button size="sm" onClick={() => createTask.mutate(o.id)}>Create pick task</Button> },
            ]} />
          )}
        </Card>
        <Card title="Picking tasks">
          {picking.isLoading ? <Spinner /> : !picking.data?.length ? <Empty message="No open picking tasks." /> : (
            <DataTable rows={picking.data} rowKey={(t) => t.id} columns={[
              { key: 'n', header: 'Task', render: (t) => <span className="font-mono text-xs">{t.taskNumber}</span> },
              { key: 'o', header: 'Order', render: (t) => t.order?.orderNumber },
              { key: 'm', header: 'Mode', render: (t) => t.mode },
              { key: 'l', header: 'Lines', render: (t) => t.items.length },
              { key: 's', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
            ]} />
          )}
        </Card>
        <Card title="Packing queue">
          {!packing.data?.length ? <Empty message="Nothing to pack." /> : (
            <DataTable rows={packing.data} rowKey={(t) => t.id} columns={[
              { key: 'o', header: 'Order', render: (t) => <span className="font-mono text-xs">{t.orderId.slice(0, 8)}</span> },
              { key: 'c', header: 'Since', render: (t) => dt(t.createdAt) },
              { key: 's', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
            ]} />
          )}
          <p className="mt-2 text-xs text-subtle">Packers work from the mobile ops screen.</p>
        </Card>
        <Card title={`Ready for dispatch (${ready.data?.meta.total ?? 0})`}>
          {!ready.data?.data.length ? <Empty message="No parcels waiting." /> : (
            <DataTable rows={ready.data.data} rowKey={(o) => o.id} columns={[
              { key: 'n', header: 'Order', render: (o) => <span className="font-mono text-xs">{o.orderNumber}</span> },
              { key: 'p', header: 'Payment', render: (o) => `${o.paymentMethod}${o.paymentMethod === 'COD' ? ` · collect ${inr(o.total)}` : ''}` },
              { key: 'x', header: '', render: (o) => can('fulfillment.dispatch') && <Button size="sm" onClick={() => assign.mutate(o.id)}>Auto-assign rider</Button> },
            ]} />
          )}
        </Card>
      </div>
    </>
  );
}

export function Delivery() {
  const can = useCan();
  const siteId = useUi((s) => s.siteId);
  const riders = useGet<any[]>(['/delivery-partners', siteId], `/delivery-partners${siteId ? `?storeId=${siteId}` : ''}`);
  const deliveries = useGet<any[]>(['/deliveries', siteId], `/deliveries${siteId ? `?storeId=${siteId}` : ''}`);
  const setAvail = useAction(({ id, status }: { id: string; status: string }) => api(`/delivery-partners/${id}/availability`, { method: 'PATCH', json: { status } }), ['/delivery-partners']);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Delivery" subtitle="Riders, availability and live assignments. Locations appear only when a rider device reports a real GPS fix." actions={can('delivery.manage') && <Button disabled={!siteId} onClick={() => setCreating(true)}>Register rider</Button>} />
      <FormError error={setAvail.error} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Riders">
          {riders.isLoading ? <Spinner /> : riders.error ? <ErrorState error={riders.error} /> : !riders.data?.length ? <Empty message="No riders registered." /> : (
            <DataTable rows={riders.data} rowKey={(r) => r.id} columns={[
              { key: 'n', header: 'Name', render: (r) => r.fullName },
              { key: 'v', header: 'Vehicle', render: (r) => `${r.vehicleType}${r.vehicleNumber ? ` · ${r.vehicleNumber}` : ''}` },
              { key: 'c', header: 'Trips', render: (r) => r._count.assignments, className: 'text-right' },
              { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
              { key: 'x', header: '', render: (r) => r.status !== 'ON_DELIVERY' && (
                r.status === 'AVAILABLE'
                  ? <Button size="sm" variant="secondary" onClick={() => setAvail.mutate({ id: r.id, status: 'OFFLINE' })}>Set offline</Button>
                  : <Button size="sm" onClick={() => setAvail.mutate({ id: r.id, status: 'AVAILABLE' })}>Set available</Button>
              ) },
            ]} />
          )}
        </Card>
        <Card title="Assignments">
          {!deliveries.data?.length ? <Empty message="No deliveries yet." /> : (
            <DataTable rows={deliveries.data} rowKey={(d) => d.id} columns={[
              { key: 'r', header: 'Rider', render: (d) => d.rider.fullName },
              { key: 'a', header: 'Assigned', render: (d) => dt(d.assignedAt) },
              { key: 'p', header: 'Proof', render: (d) => d.proof?.method ?? '—' },
              { key: 's', header: 'Status', render: (d) => <StatusBadge status={d.status} /> },
            ]} />
          )}
        </Card>
      </div>
      {creating && siteId && <CreateRider storeId={siteId} onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateRider({ storeId, onClose }: { storeId: string; onClose: () => void }) {
  const [f, setF] = useState<any>({ vehicleType: 'EV_SCOOTER' });
  const go = useAction(() => api('/delivery-partners', { method: 'POST', json: { ...f, homeStoreId: storeId } }), ['/delivery-partners'], onClose);
  return (
    <Modal open onClose={onClose} title="Register rider" footer={<Button loading={go.isPending} onClick={() => go.mutate(undefined)}>Register</Button>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Full name"><Input onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
        <Field label="Phone"><Input onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Vehicle"><Select className="w-full" value={f.vehicleType} onChange={(e) => setF({ ...f, vehicleType: e.target.value })}>{['BICYCLE', 'EV_SCOOTER', 'MOTORCYCLE'].map((v) => <option key={v}>{v}</option>)}</Select></Field>
        <Field label="Vehicle number"><Input onChange={(e) => setF({ ...f, vehicleNumber: e.target.value || undefined })} /></Field>
        <div className="col-span-2"><Field label="Linked login user id (optional)" hint="Employee with the Delivery Partner role"><Input onChange={(e) => setF({ ...f, userId: e.target.value || undefined })} /></Field></div>
      </div>
      <div className="mt-3"><FormError error={go.error} /></div>
    </Modal>
  );
}

export function Customers() {
  const list = useList<any>('/customers');
  return (
    <>
      <PageHeader title="Customers" />
      <Card>
        <Input placeholder="Search name, phone, email" className="mb-3 max-w-xs" onChange={(e) => list.set({ search: e.target.value })} />
        {list.isLoading ? <Spinner /> : list.error ? <ErrorState error={list.error} /> : !list.data?.data.length ? <Empty message="No customers." /> : (
          <DataTable rows={list.data.data} rowKey={(c) => c.id} columns={[
            { key: 'n', header: 'Name', render: (c) => c.fullName },
            { key: 'p', header: 'Phone', render: (c) => c.phone },
            { key: 'e', header: 'Email', render: (c) => c.email ?? '—' },
            { key: 'o', header: 'Orders', render: (c) => c._count.orders, className: 'text-right' },
            { key: 'j', header: 'Joined', render: (c) => dt(c.createdAt) },
            { key: 's', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
          ]} />
        )}
      </Card>
    </>
  );
}

export function Payments() {
  const can = useCan();
  const [status, setStatus] = useState('');
  const q = useGet<any[]>(['/payments', status], `/payments${status ? `?status=${status}` : ''}`);
  const cfg = useGet<any>(['/payments/config'], '/payments/config');
  const recon = useGet<any[]>(['/payments/reconciliation'], '/payments/reconciliation');
  const [refund, setRefund] = useState<any>(null);
  return (
    <>
      <PageHeader title="Payments" subtitle={cfg.data && <>Online gateway: <b>{cfg.data.onlinePayments.status}</b>{cfg.data.onlinePayments.provider ? ` (${cfg.data.onlinePayments.provider})` : ''} · Cash on delivery: <b>{cfg.data.cashOnDelivery}</b></>} />
      <Card title="Last 24h reconciliation" className="mb-4">
        {!recon.data?.length ? <Empty message="No payments in the last 24 hours." /> : (
          <DataTable rows={recon.data} rowKey={(r) => r.method + r.status} columns={[
            { key: 'm', header: 'Method', render: (r) => r.method },
            { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'c', header: 'Count', render: (r) => num(r.count), className: 'text-right' },
            { key: 'a', header: 'Amount', render: (r) => inr(r.amount), className: 'text-right' },
          ]} />
        )}
      </Card>
      <Card title="Transactions" actions={<Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">All</option>{['PENDING', 'CAPTURED', 'FAILED', 'COD_PENDING', 'COD_COLLECTED', 'REFUND_PENDING', 'REFUNDED'].map((s) => <option key={s}>{s}</option>)}</Select>}>
        {q.isLoading ? <Spinner /> : !q.data?.length ? <Empty message="No payments." /> : (
          <DataTable rows={q.data} rowKey={(p) => p.id} columns={[
            { key: 'o', header: 'Order', render: (p) => <span className="font-mono text-xs">{p.order.orderNumber}</span> },
            { key: 'm', header: 'Method', render: (p) => p.method },
            { key: 'a', header: 'Amount', render: (p) => inr(p.amount), className: 'text-right' },
            { key: 'r', header: 'Gateway ref', render: (p) => <span className="font-mono text-xs">{p.providerPaymentId ?? '—'}</span> },
            { key: 's', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
            { key: 'x', header: '', render: (p) => can('refunds.manage') && p.refunds.filter((r: any) => r.status === 'PENDING').map((r: any) => <Button key={r.id} size="sm" onClick={() => setRefund(r)}>Complete refund {inr(r.amount)}</Button>) },
          ]} />
        )}
      </Card>
      {refund && <RefundModal refund={refund} onClose={() => setRefund(null)} />}
    </>
  );
}

function RefundModal({ refund, onClose }: { refund: any; onClose: () => void }) {
  const [reference, setReference] = useState('');
  const go = useAction(() => api(`/payments/refunds/${refund.id}/complete`, { method: 'POST', json: { reference } }), ['/payments', '/orders'], onClose);
  return (
    <Modal open onClose={onClose} title={`Complete refund of ${inr(refund.amount)}`} footer={<Button disabled={reference.length < 3} loading={go.isPending} onClick={() => go.mutate(undefined)}>Mark refunded</Button>}>
      <p className="mb-3 text-sm text-subtle">Record the bank/UPI transfer reference used to return the money. Gateway refunds are confirmed automatically by webhook.</p>
      <Field label="Transfer reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      <div className="mt-3"><FormError error={go.error} /></div>
    </Modal>
  );
}

