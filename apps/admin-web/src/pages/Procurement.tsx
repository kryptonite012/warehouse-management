import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Card, DataTable, Empty, ErrorState, Field, FormError, Input, Modal, PageHeader, Pager, Select, Spinner, StatusBadge } from '@/components/ui';
import { api, newIdempotencyKey } from '@/lib/api';
import { d, dt, inr, title } from '@/lib/format';
import { useAction, useGet, useList, useSites } from '@/lib/hooks';
import { useAuth, useCan } from '@/stores/auth';

export function PurchaseOrders() {
  const can = useCan();
  const navigate = useNavigate();
  const list = useList<any>('/purchase-orders');
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Purchase orders" subtitle="Requisition → approval → PO → receipt → QC → close" actions={can('purchase_orders.create') && <Button onClick={() => setCreating(true)}>New purchase order</Button>} />
      <Card>
        <div className="mb-3 flex gap-2">
          <Input placeholder="PO number" className="max-w-xs" onChange={(e) => list.set({ search: e.target.value })} />
          <Select onChange={(e) => list.set({ status: e.target.value || undefined })} aria-label="Status">
            <option value="">All statuses</option>
            {['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'].map((s) => <option key={s} value={s}>{title(s)}</option>)}
          </Select>
        </div>
        {list.isLoading ? <Spinner /> : list.error ? <ErrorState error={list.error} /> : !list.data?.data.length ? <Empty message="No purchase orders." /> : (
          <>
            <DataTable rows={list.data.data} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/procurement/${r.id}`)} columns={[
              { key: 'n', header: 'PO', render: (r) => <span className="font-mono text-xs">{r.poNumber}</span> },
              { key: 's', header: 'Supplier', render: (r) => r.supplier.name },
              { key: 'l', header: 'Lines', render: (r) => r._count.items, className: 'text-right' },
              { key: 't', header: 'Total', render: (r) => inr(r.total), className: 'text-right' },
              { key: 'e', header: 'Expected', render: (r) => d(r.expectedAt) },
              { key: 'st', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            ]} />
            <Pager {...list.data.meta} onPage={list.setPage} />
          </>
        )}
      </Card>
      {creating && <CreatePo onClose={() => setCreating(false)} onCreated={(id) => navigate(`/procurement/${id}`)} />}
    </>
  );
}

function CreatePo({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const suppliers = useGet<any>(['/suppliers', 'all'], '/suppliers?pageSize=200');
  const sites = useSites();
  const [f, setF] = useState<any>({ items: [{ skuCode: '', orderedQty: 1 }] });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const items = [];
      for (const it of f.items.filter((i: any) => i.skuCode)) {
        const p = await api(`/products?search=${encodeURIComponent(it.skuCode)}&pageSize=5`);
        const sku = p.data.flatMap((x: any) => x.skus).find((s: any) => s.code === it.skuCode.toUpperCase());
        if (!sku) throw new Error(`Unknown SKU ${it.skuCode}`);
        items.push({ skuId: sku.id, orderedQty: Number(it.orderedQty), unitCost: it.unitCost ? Number(it.unitCost) : undefined });
      }
      const po = await api('/purchase-orders', { method: 'POST', json: { supplierId: f.supplierId, warehouseId: f.warehouseId, notes: f.notes, items } });
      onCreated(po.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const setItem = (i: number, k: string, v: string) => setF({ ...f, items: f.items.map((x: any, j: number) => (j === i ? { ...x, [k]: v } : x)) });
  return (
    <Modal open onClose={onClose} wide title="New purchase order" footer={<Button loading={busy} onClick={submit}>Create draft</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Supplier"><Select className="w-full" defaultValue="" onChange={(e) => setF({ ...f, supplierId: e.target.value })}><option value="" disabled>Select…</option>{suppliers.data?.data.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Deliver to"><Select className="w-full" defaultValue="" onChange={(e) => setF({ ...f, warehouseId: e.target.value })}><option value="" disabled>Select…</option>{sites.data?.data.map((s: any) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</Select></Field>
      </div>
      <p className="mb-1 mt-4 text-xs font-medium text-subtle">Lines (unit cost defaults to the latest supplier price)</p>
      {f.items.map((it: any, i: number) => (
        <div key={i} className="mb-2 grid grid-cols-3 gap-2">
          <Input placeholder="SKU code" value={it.skuCode} onChange={(e) => setItem(i, 'skuCode', e.target.value)} />
          <Input type="number" min={1} placeholder="Qty" value={it.orderedQty} onChange={(e) => setItem(i, 'orderedQty', e.target.value)} />
          <Input type="number" step="0.01" placeholder="Unit cost (optional)" onChange={(e) => setItem(i, 'unitCost', e.target.value)} />
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => setF({ ...f, items: [...f.items, { skuCode: '', orderedQty: 1 }] })}>+ Add line</Button>
      <div className="mt-3"><FormError error={error} /></div>
    </Modal>
  );
}

export function PurchaseOrderDetail() {
  const { id } = useParams();
  const can = useCan();
  const me = useAuth((s) => s.me);
  const po = useGet<any>(['/purchase-orders', id], `/purchase-orders/${id}`);
  const [receiving, setReceiving] = useState(false);
  const [inspecting, setInspecting] = useState<any>(null);
  const step = useAction((s: string) => api(`/purchase-orders/${id}/${s}`, { method: 'POST' }), ['/purchase-orders']);
  const complete = useAction((grnId: string) => api(`/goods-receipts/${grnId}/complete`, { method: 'POST' }), ['/purchase-orders']);
  const token = useAuth((s) => s.accessToken);

  if (po.isLoading) return <Spinner />;
  if (po.error) return <ErrorState error={po.error} />;
  const p = po.data;
  const openDoc = async () => {
    const html = await (await fetch(`/api/v1/purchase-orders/${id}/document`, { headers: { authorization: `Bearer ${token}` } })).text();
    const w = window.open('', '_blank');
    w?.document.write(html);
    w?.document.close();
  };
  return (
    <>
      <PageHeader title={p.poNumber} subtitle={<>{p.supplier.name} · <StatusBadge status={p.status} /></>} actions={<>
        <Button variant="secondary" onClick={openDoc}>Print PO</Button>
        {p.status === 'DRAFT' && can('purchase_orders.create') && <Button onClick={() => step.mutate('submit')}>Submit for approval</Button>}
        {p.status === 'PENDING_APPROVAL' && can('purchase_orders.approve') && p.createdById !== me?.id && <Button onClick={() => step.mutate('approve')}>Approve</Button>}
        {p.status === 'APPROVED' && can('purchase_orders.create') && <Button onClick={() => step.mutate('send')}>Mark sent</Button>}
        {p.status === 'SENT' && can('purchase_orders.create') && <Button onClick={() => step.mutate('confirm')}>Supplier confirmed</Button>}
        {['APPROVED', 'SENT', 'CONFIRMED', 'PARTIALLY_RECEIVED'].includes(p.status) && can('receiving.perform') && <Button onClick={() => setReceiving(true)}>Receive goods</Button>}
        {['PARTIALLY_RECEIVED', 'RECEIVED'].includes(p.status) && can('purchase_orders.approve') && <Button variant="secondary" onClick={() => step.mutate('close')}>Close PO</Button>}
      </>} />
      <FormError error={step.error || complete.error} />
      <Card title="Lines">
        <DataTable rows={p.items} rowKey={(i: any) => i.id} columns={[
          { key: 's', header: 'SKU', render: (i: any) => <span className="font-mono text-xs">{i.skuId.slice(0, 8)}</span> },
          { key: 'o', header: 'Ordered', render: (i: any) => i.orderedQty, className: 'text-right' },
          { key: 'r', header: 'Received', render: (i: any) => i.receivedQty, className: 'text-right' },
          { key: 'p', header: 'Pending', render: (i: any) => <span className={i.pendingQty ? 'text-warn' : ''}>{i.pendingQty}</span>, className: 'text-right' },
          { key: 'a', header: 'Accepted', render: (i: any) => i.acceptedQty, className: 'text-right' },
          { key: 'x', header: 'Rejected', render: (i: any) => i.rejectedQty, className: 'text-right' },
          { key: 'c', header: 'Unit cost', render: (i: any) => inr(i.unitCost), className: 'text-right' },
        ]} />
        <p className="mt-3 text-right text-sm">Subtotal {inr(p.subtotal)} · Tax {inr(p.taxTotal)} · <b>Total {inr(p.total)}</b></p>
      </Card>
      <Card title="Goods receipts" className="mt-4">
        {!p.receipts.length ? <Empty message="Nothing received yet." /> : (
          <DataTable rows={p.receipts} rowKey={(g: any) => g.id} columns={[
            { key: 'n', header: 'GRN', render: (g: any) => <span className="font-mono text-xs">{g.grnNumber}</span> },
            { key: 'd', header: 'Received', render: (g: any) => dt(g.createdAt) },
            { key: 'u', header: 'Units', render: (g: any) => g.items.reduce((s: number, i: any) => s + i.receivedQty, 0), className: 'text-right' },
            { key: 's', header: 'Status', render: (g: any) => <StatusBadge status={g.status} /> },
            { key: 'x', header: '', render: (g: any) => g.status === 'INSPECTING' && (
              <div className="flex gap-1">
                {can('quality.inspect') && <Button size="sm" variant="secondary" onClick={() => setInspecting(g)}>Inspect</Button>}
                {can('receiving.perform') && <Button size="sm" onClick={() => complete.mutate(g.id)}>Complete</Button>}
              </div>
            ) },
          ]} />
        )}
      </Card>
      {receiving && <ReceiveModal po={p} onClose={() => setReceiving(false)} />}
      {inspecting && <InspectModal grn={inspecting} onClose={() => setInspecting(null)} />}
    </>
  );
}

function ReceiveModal({ po, onClose }: { po: any; onClose: () => void }) {
  const [lines, setLines] = useState<any[]>(po.items.filter((i: any) => i.pendingQty > 0).map((i: any) => ({ skuId: i.skuId, receivedQty: i.pendingQty, batchNumber: '', expiresAt: '', pending: i.pendingQty })));
  const [key] = useState(newIdempotencyKey);
  const [res, setRes] = useState<any>(null);
  const go = useAction(() => api('/goods-receipts', { method: 'POST', json: {
    purchaseOrderId: po.id, idempotencyKey: key,
    items: lines.filter((l) => Number(l.receivedQty) > 0).map((l) => ({ skuId: l.skuId, batchNumber: l.batchNumber, expiresAt: l.expiresAt || undefined, receivedQty: Number(l.receivedQty), unitCost: l.unitCost ? Number(l.unitCost) : undefined })),
  } }), ['/purchase-orders'], setRes);
  const set = (i: number, k: string, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <Modal open onClose={onClose} wide title={`Receive against ${po.poNumber}`} footer={res ? <Button onClick={onClose}>Done</Button> : <Button loading={go.isPending} onClick={() => go.mutate(undefined)}>Record receipt</Button>}>
      <p className="mb-2 text-xs text-subtle">Received units are held in QUARANTINE until quality inspection accepts them.</p>
      {lines.map((l, i) => (
        <div key={l.skuId} className="mb-2 grid grid-cols-5 items-end gap-2">
          <span className="font-mono text-xs">{l.skuId.slice(0, 8)} <span className="text-subtle">(pending {l.pending})</span></span>
          <Field label="Qty"><Input type="number" min={0} max={l.pending} value={l.receivedQty} onChange={(e) => set(i, 'receivedQty', e.target.value)} /></Field>
          <Field label="Batch"><Input value={l.batchNumber} onChange={(e) => set(i, 'batchNumber', e.target.value)} /></Field>
          <Field label="Expiry"><Input type="date" value={l.expiresAt} onChange={(e) => set(i, 'expiresAt', e.target.value)} /></Field>
          <Field label="Invoice cost"><Input type="number" step="0.01" onChange={(e) => set(i, 'unitCost', e.target.value)} /></Field>
        </div>
      ))}
      <FormError error={go.error} />
      {res?.discrepancies?.length > 0 && <p className="mt-2 text-sm text-warn">Price discrepancies flagged on {res.discrepancies.length} line(s) for invoice verification.</p>}
      {res && <p className="mt-2 text-sm text-ok">Recorded {res.grnNumber}.</p>}
    </Modal>
  );
}

function InspectModal({ grn, onClose }: { grn: any; onClose: () => void }) {
  const [lines, setLines] = useState<any[]>(grn.items.filter((i: any) => !i.inspectedAt).map((i: any) => ({ itemId: i.id, batch: i.batchNumber, received: i.receivedQty, acceptedQty: i.receivedQty, rejectedQty: 0, damagedQty: 0, rejectionReason: '' })));
  const go = useAction(() => api(`/goods-receipts/${grn.id}/inspect`, { method: 'POST', json: { lines: lines.map(({ batch, received, ...l }) => ({ ...l, acceptedQty: Number(l.acceptedQty), rejectedQty: Number(l.rejectedQty), damagedQty: Number(l.damagedQty), rejectionReason: l.rejectionReason || undefined })) } }), ['/purchase-orders', '/inventory'], onClose);
  const set = (i: number, k: string, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <Modal open onClose={onClose} wide title={`Quality inspection · ${grn.grnNumber}`} footer={<Button loading={go.isPending} onClick={() => go.mutate(undefined)}>Submit inspection</Button>}>
      {lines.map((l, i) => (
        <div key={l.itemId} className="mb-2 grid grid-cols-5 items-end gap-2">
          <span className="text-xs">Batch {l.batch} · {l.received} rcvd</span>
          <Field label="Accept"><Input type="number" min={0} value={l.acceptedQty} onChange={(e) => set(i, 'acceptedQty', e.target.value)} /></Field>
          <Field label="Damaged"><Input type="number" min={0} value={l.damagedQty} onChange={(e) => set(i, 'damagedQty', e.target.value)} /></Field>
          <Field label="Reject"><Input type="number" min={0} value={l.rejectedQty} onChange={(e) => set(i, 'rejectedQty', e.target.value)} /></Field>
          <Field label="Reason"><Input value={l.rejectionReason} onChange={(e) => set(i, 'rejectionReason', e.target.value)} /></Field>
        </div>
      ))}
      <FormError error={go.error} />
    </Modal>
  );
}

export function Suppliers() {
  const can = useCan();
  const list = useList<any>('/suppliers');
  const [open, setOpen] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Suppliers" actions={can('suppliers.manage') && <Button onClick={() => setCreating(true)}>New supplier</Button>} />
      <Card>
        <Input placeholder="Search name, code, GSTIN" className="mb-3 max-w-xs" onChange={(e) => list.set({ search: e.target.value })} />
        {list.isLoading ? <Spinner /> : !list.data?.data.length ? <Empty message="No suppliers." /> : (
          <>
            <DataTable rows={list.data.data} rowKey={(s) => s.id} onRowClick={setOpen} columns={[
              { key: 'c', header: 'Code', render: (s) => <span className="font-mono text-xs">{s.code}</span> },
              { key: 'n', header: 'Name', render: (s) => s.name },
              { key: 'g', header: 'GSTIN', render: (s) => s.gstin ?? '—' },
              { key: 'l', header: 'Lead time', render: (s) => `${s.leadTimeDays} d` },
              { key: 'p', header: 'Terms', render: (s) => `${s.paymentTermsDays} d` },
              { key: 's', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
            ]} />
            <Pager {...list.data.meta} onPage={list.setPage} />
          </>
        )}
      </Card>
      {open && <SupplierPerf id={open.id} onClose={() => setOpen(null)} />}
      {creating && <CreateSupplier onClose={() => setCreating(false)} />}
    </>
  );
}

function SupplierPerf({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useGet<any>(['/suppliers', id], `/suppliers/${id}`);
  const p = q.data?.performance;
  return (
    <Modal open onClose={onClose} title={q.data?.name ?? 'Supplier'}>
      {q.isLoading ? <Spinner /> : (
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-subtle">Purchase orders</dt><dd>{p.purchaseOrders}</dd>
          <dt className="text-subtle">Fill rate</dt><dd>{p.fillRate === null ? '—' : `${(p.fillRate * 100).toFixed(1)}%`}</dd>
          <dt className="text-subtle">Rejection rate</dt><dd>{p.rejectionRate === null ? '—' : `${(p.rejectionRate * 100).toFixed(1)}%`}</dd>
          <dt className="text-subtle">On-time receipts</dt><dd>{p.onTimeRate === null ? '—' : `${(p.onTimeRate * 100).toFixed(1)}%`}</dd>
          <dt className="text-subtle">Price history entries</dt><dd>{q.data.products.length}</dd>
        </dl>
      )}
    </Modal>
  );
}

function CreateSupplier({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState<any>({});
  const go = useAction(() => api('/suppliers', { method: 'POST', json: { ...f, leadTimeDays: f.leadTimeDays ? Number(f.leadTimeDays) : undefined, paymentTermsDays: f.paymentTermsDays ? Number(f.paymentTermsDays) : undefined } }), ['/suppliers'], onClose);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value || undefined });
  return (
    <Modal open onClose={onClose} title="New supplier" footer={<Button loading={go.isPending} onClick={() => go.mutate(undefined)}>Create</Button>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Code"><Input onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Name"><Input onChange={set('name')} /></Field>
        <Field label="GSTIN"><Input onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() || undefined })} /></Field>
        <Field label="Contact"><Input onChange={set('contactName')} /></Field>
        <Field label="Email"><Input type="email" onChange={set('email')} /></Field>
        <Field label="Phone"><Input onChange={set('phone')} /></Field>
        <Field label="Lead time (days)"><Input type="number" onChange={set('leadTimeDays')} /></Field>
        <Field label="Payment terms (days)"><Input type="number" onChange={set('paymentTermsDays')} /></Field>
      </div>
      <div className="mt-3"><FormError error={go.error} /></div>
    </Modal>
  );
}
