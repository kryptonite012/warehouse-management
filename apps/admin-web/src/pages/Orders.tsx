import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Card, DataTable, Empty, ErrorState, Field, FormError, Input, Modal, PageHeader, Pager, Select, Spinner, StatusBadge } from '@/components/ui';
import { api } from '@/lib/api';
import { dt, inr, title } from '@/lib/format';
import { useAction, useGet, useList } from '@/lib/hooks';
import { useCan } from '@/stores/auth';
import { useUi } from '@/stores/ui';

const STATUSES = ['CREATED', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'ACCEPTED', 'PICKING', 'PICKED', 'PARTIALLY_FULFILLED', 'PACKED', 'READY_FOR_DISPATCH', 'RIDER_ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'RETURN_REQUESTED', 'REFUND_PENDING', 'REFUNDED'];

export function OrderList() {
  const navigate = useNavigate();
  const siteId = useUi((s) => s.siteId) ?? undefined;
  const list = useList<any>('/orders', { darkStoreId: siteId });
  return (
    <>
      <PageHeader title="Orders" subtitle="Every status change is recorded with actor, time and reason" />
      <Card>
        <div className="mb-3 flex gap-2">
          <Input placeholder="Order number" className="max-w-xs" onChange={(e) => list.set({ search: e.target.value })} />
          <Select onChange={(e) => list.set({ status: e.target.value || undefined })} aria-label="Status">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{title(s)}</option>)}
          </Select>
        </div>
        {list.isLoading ? <Spinner /> : list.error ? <ErrorState error={list.error} /> : !list.data?.data.length ? <Empty message="No orders." /> : (
          <>
            <DataTable rows={list.data.data} rowKey={(o) => o.id} onRowClick={(o) => navigate(`/orders/${o.id}`)} columns={[
              { key: 'n', header: 'Order', render: (o) => <span className="font-mono text-xs">{o.orderNumber}</span> },
              { key: 't', header: 'Placed', render: (o) => dt(o.placedAt) },
              { key: 'c', header: 'Customer', render: (o) => o.customer?.fullName },
              { key: 'i', header: 'Items', render: (o) => o.items.reduce((s: number, i: any) => s + i.quantity, 0), className: 'text-right' },
              { key: 'p', header: 'Payment', render: (o) => o.paymentMethod },
              { key: 'tt', header: 'Total', render: (o) => inr(o.total), className: 'text-right' },
              { key: 's', header: 'Status', render: (o) => <StatusBadge status={o.status} /> },
            ]} />
            <Pager {...list.data.meta} onPage={list.setPage} />
          </>
        )}
      </Card>
    </>
  );
}

export function OrderDetail() {
  const { id } = useParams();
  const can = useCan();
  const q = useGet<any>(['/orders', id], `/orders/${id}`);
  const [cancel, setCancel] = useState(false);
  const [ret, setRet] = useState(false);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} />;
  const o = q.data;
  const a = o.addressSnapshot;
  return (
    <>
      <PageHeader title={o.orderNumber} subtitle={<>Placed {dt(o.placedAt)} · <StatusBadge status={o.status} /></>} actions={<>
        {can('orders.manage') && ['CREATED', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CONFIRMED', 'INVENTORY_RESERVED', 'ACCEPTED', 'PICKING', 'PICKED', 'PARTIALLY_FULFILLED'].includes(o.status) && <Button variant="danger" onClick={() => setCancel(true)}>Cancel order</Button>}
        {can('orders.manage') && o.status === 'RETURN_REQUESTED' && <Button onClick={() => setRet(true)}>Receive return</Button>}
      </>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Items" className="lg:col-span-2">
          <DataTable rows={o.items} rowKey={(i: any) => i.id} columns={[
            { key: 'p', header: 'Product', render: (i: any) => <div><p>{i.productName}</p><p className="font-mono text-[11px] text-subtle">{i.skuCode}</p></div> },
            { key: 'q', header: 'Qty', render: (i: any) => i.quantity, className: 'text-right' },
            { key: 'pk', header: 'Picked', render: (i: any) => i.pickedQty, className: 'text-right' },
            { key: 'u', header: 'Price', render: (i: any) => inr(i.unitPrice), className: 'text-right' },
            { key: 't', header: 'Total', render: (i: any) => inr(i.lineTotal), className: 'text-right' },
          ]} />
          <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm sm:ml-auto sm:w-64">
            <dt className="text-subtle">Subtotal</dt><dd className="text-right">{inr(o.subtotal)}</dd>
            <dt className="text-subtle">Discount</dt><dd className="text-right">−{inr(o.discountTotal)}</dd>
            <dt className="text-subtle">Delivery</dt><dd className="text-right">{inr(o.deliveryFee)}</dd>
            <dt className="text-subtle">Tax (incl.)</dt><dd className="text-right">{inr(o.taxTotal)}</dd>
            <dt className="font-medium">Total</dt><dd className="text-right font-medium">{inr(o.total)}</dd>
          </dl>
        </Card>
        <div className="space-y-4">
          <Card title="Delivery">
            <p className="text-sm">{a.line1}{a.line2 ? `, ${a.line2}` : ''}<br />{a.city} {a.postalCode}</p>
            {o.delivery ? (
              <div className="mt-3 text-sm">
                <p>Rider: {o.delivery.rider.fullName} ({o.delivery.rider.vehicleType})</p>
                <ul className="mt-2 space-y-1 text-xs text-subtle">{o.delivery.events.map((e: any) => <li key={e.id}>{dt(e.createdAt)} · {title(e.status)}{e.latitude ? ` @ ${e.latitude},${e.longitude}` : ''}{e.note ? ` — ${e.note}` : ''}</li>)}</ul>
              </div>
            ) : <p className="mt-2 text-xs text-subtle">No rider assigned yet.</p>}
          </Card>
          <Card title="Payment">
            {o.payments.map((p: any) => (
              <div key={p.id} className="text-sm">
                <p>{p.method} · {p.provider} · <StatusBadge status={p.status} /></p>
                <p className="text-xs text-subtle">{inr(p.amount)}{p.providerPaymentId ? ` · ref ${p.providerPaymentId}` : ''}</p>
                {p.refunds.map((r: any) => <p key={r.id} className="text-xs">Refund {inr(r.amount)} · {r.status}</p>)}
              </div>
            ))}
          </Card>
        </div>
      </div>
      <Card title="Status history" className="mt-4">
        <ol className="relative ml-2 border-l border-border">
          {o.statusHistory.map((h: any) => (
            <li key={h.id} className="mb-3 ml-4">
              <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border border-panel bg-brand" />
              <p className="text-sm"><StatusBadge status={h.toStatus} /> <span className="text-xs text-subtle">{dt(h.createdAt)} · {h.actorType.toLowerCase()} · {h.event}</span></p>
              {h.reason && <p className="text-xs text-subtle">{h.reason}</p>}
            </li>
          ))}
        </ol>
      </Card>
      {cancel && <CancelModal id={o.id} onClose={() => setCancel(false)} />}
      {ret && <ReturnModal order={o} onClose={() => setRet(false)} />}
    </>
  );
}

function CancelModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const go = useAction(() => api(`/orders/${id}/cancel`, { method: 'POST', json: { reason } }), ['/orders'], onClose);
  return (
    <Modal open onClose={onClose} title="Cancel order" footer={<Button variant="danger" disabled={reason.length < 3} loading={go.isPending} onClick={() => go.mutate(undefined)}>Cancel order</Button>}>
      <p className="mb-3 text-sm text-subtle">Reserved stock is released exactly once; picked items are returned to available stock; captured payments get a refund record.</p>
      <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="mt-3"><FormError error={go.error} /></div>
    </Modal>
  );
}

function ReturnModal({ order, onClose }: { order: any; onClose: () => void }) {
  const [lines, setLines] = useState(order.items.map((i: any) => ({ orderItemId: i.id, name: i.productName, max: i.pickedQty, quantity: i.pickedQty, condition: 'RESALABLE' })));
  const go = useAction(() => api(`/orders/${order.id}/returns/receive`, { method: 'POST', json: { lines: lines.map(({ name, max, ...l }: any) => ({ ...l, quantity: Number(l.quantity) })) } }), ['/orders', '/inventory'], onClose);
  return (
    <Modal open onClose={onClose} title="Inspect returned items" footer={<Button loading={go.isPending} onClick={() => go.mutate(undefined)}>Record return</Button>}>
      {lines.map((l: any, i: number) => (
        <div key={l.orderItemId} className="mb-2 grid grid-cols-3 items-end gap-2">
          <span className="text-sm">{l.name}</span>
          <Field label={`Qty (max ${l.max})`}><Input type="number" min={0} max={l.max} value={l.quantity} onChange={(e) => setLines(lines.map((x: any, j: number) => (j === i ? { ...x, quantity: e.target.value } : x)))} /></Field>
          <Field label="Condition"><Select className="w-full" value={l.condition} onChange={(e) => setLines(lines.map((x: any, j: number) => (j === i ? { ...x, condition: e.target.value } : x)))}><option value="RESALABLE">Resalable</option><option value="DAMAGED">Damaged</option></Select></Field>
        </div>
      ))}
      <FormError error={go.error} />
    </Modal>
  );
}
