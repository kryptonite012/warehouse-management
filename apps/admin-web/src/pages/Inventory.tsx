import { useState } from 'react';
import { Badge, Button, Card, DataTable, Empty, ErrorState, Field, FormError, Input, Modal, PageHeader, Pager, Select, Spinner, StatusBadge, cn } from '@/components/ui';
import { api, newIdempotencyKey } from '@/lib/api';
import { d, dt, inr, num, title } from '@/lib/format';
import { useAction, useGet, useList, useSites } from '@/lib/hooks';
import { useCan } from '@/stores/auth';
import { useUi } from '@/stores/ui';

const TABS = ['Stock', 'Expiring', 'Movements', 'Adjustments', 'Counts', 'Transfers'] as const;

export default function Inventory() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Stock');
  return (
    <>
      <PageHeader title="Inventory" subtitle="Ledger-backed stock: every quantity below is the sum of auditable movements" />
      <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-sm', tab === t ? 'border-brand font-medium text-fg' : 'border-transparent text-subtle hover:text-fg')}>{t}</button>
        ))}
      </div>
      {tab === 'Stock' && <Stock />}
      {tab === 'Expiring' && <Expiring />}
      {tab === 'Movements' && <Movements />}
      {tab === 'Adjustments' && <Adjustments />}
      {tab === 'Counts' && <Counts />}
      {tab === 'Transfers' && <Transfers />}
    </>
  );
}

function Stock() {
  const siteId = useUi((s) => s.siteId) ?? undefined;
  const list = useList<any>('/inventory', { warehouseId: siteId });
  const [sku, setSku] = useState<any>(null);
  return (
    <Card>
      <div className="mb-3 flex flex-wrap gap-2">
        <Input placeholder="Search product or SKU" className="max-w-xs" onChange={(e) => list.set({ search: e.target.value })} />
        <Select onChange={(e) => list.set({ stock: e.target.value || undefined })} aria-label="Stock level">
          <option value="">All stock levels</option><option value="LOW">Low (≤ reorder point)</option><option value="OUT">Out of stock</option><option value="IN">In stock</option>
        </Select>
      </div>
      {list.isLoading ? <Spinner /> : list.error ? <ErrorState error={list.error} /> : !list.data?.data.length ? <Empty message="No stock records." /> : (
        <>
          <DataTable rows={list.data.data} rowKey={(r) => r.warehouseId + r.skuId} onRowClick={setSku} columns={[
            { key: 'p', header: 'Product', render: (r) => <div><p>{r.productName}</p><p className="font-mono text-[11px] text-subtle">{r.skuCode}</p></div> },
            { key: 'w', header: 'Site', render: (r) => r.warehouseCode },
            { key: 'oh', header: 'On hand', render: (r) => num(r.onHand), className: 'text-right' },
            { key: 'av', header: 'Available', render: (r) => <span className={cn(r.available === 0 ? 'text-bad' : r.available <= r.reorderPoint ? 'text-warn' : '')}>{num(r.available)}</span>, className: 'text-right font-medium' },
            { key: 'rs', header: 'Reserved', render: (r) => num(r.reserved), className: 'text-right' },
            { key: 'dm', header: 'Damaged', render: (r) => num(r.damaged), className: 'text-right' },
            { key: 'q', header: 'Quarantined', render: (r) => num(r.quarantined), className: 'text-right' },
            { key: 'ex', header: 'Expired', render: (r) => num(r.expired), className: 'text-right' },
            { key: 'it', header: 'In transit', render: (r) => num(r.inTransit), className: 'text-right' },
            { key: 'v', header: 'Value (cost)', render: (r) => inr(r.valuationAtCost), className: 'text-right' },
          ]} />
          <Pager {...list.data.meta} onPage={list.setPage} />
        </>
      )}
      {sku && <SkuBatches row={sku} onClose={() => setSku(null)} />}
    </Card>
  );
}

function SkuBatches({ row, onClose }: { row: any; onClose: () => void }) {
  const can = useCan();
  const q = useGet<any>(['/inventory', row.skuId, row.warehouseId], `/inventory/${row.skuId}?warehouseId=${row.warehouseId}`);
  const [action, setAction] = useState<{ batch: any; kind: 'adjust' | 'status' } | null>(null);
  return (
    <Modal open onClose={onClose} wide title={`${row.productName} @ ${row.warehouseCode}`}>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} /> : (
        <>
          <p className="mb-2 text-xs text-subtle">Batches in FEFO order (earliest expiry is picked first).</p>
          <DataTable rows={q.data.batches} rowKey={(b: any) => b.id} columns={[
            { key: 'n', header: 'Batch', render: (b: any) => <span className="font-mono text-xs">{b.batchNumber}</span> },
            { key: 'e', header: 'Expires', render: (b: any) => d(b.expiresAt) },
            { key: 's', header: 'Status', render: (b: any) => <StatusBadge status={b.status} /> },
            { key: 'a', header: 'Avail', render: (b: any) => b.balance?.available, className: 'text-right' },
            { key: 'r', header: 'Resv', render: (b: any) => b.balance?.reserved, className: 'text-right' },
            { key: 'q', header: 'Quar', render: (b: any) => b.balance?.quarantined, className: 'text-right' },
            { key: 'd', header: 'Dmg', render: (b: any) => b.balance?.damaged, className: 'text-right' },
            { key: 'x', header: '', render: (b: any) => (
              <div className="flex gap-1">
                {can('inventory.quality') && <Button size="sm" variant="secondary" onClick={() => setAction({ batch: b, kind: 'status' })}>QC</Button>}
                {can('inventory.adjust.request') && <Button size="sm" variant="secondary" onClick={() => setAction({ batch: b, kind: 'adjust' })}>Adjust</Button>}
              </div>
            ) },
          ]} />
          {q.data.locations.length > 0 && <p className="mt-3 text-xs text-subtle">Locations: {q.data.locations.map((l: any) => l.code).join(', ')}</p>}
        </>
      )}
      {action?.kind === 'adjust' && <AdjustModal batch={action.batch} warehouseId={row.warehouseId} onClose={() => setAction(null)} />}
      {action?.kind === 'status' && <StatusModal batch={action.batch} warehouseId={row.warehouseId} onClose={() => setAction(null)} />}
    </Modal>
  );
}

function AdjustModal({ batch, warehouseId, onClose }: { batch: any; warehouseId: string; onClose: () => void }) {
  const [f, setF] = useState<any>({ bucket: 'AVAILABLE', reasonCode: 'DATA_CORRECTION', quantityDelta: 0 });
  const req = useAction(() => api('/inventory/adjustments', { method: 'POST', json: { ...f, quantityDelta: Number(f.quantityDelta), warehouseId, batchId: batch.id } }), ['/inventory'], onClose);
  return (
    <Modal open onClose={onClose} title={`Request adjustment · ${batch.batchNumber}`} footer={<Button loading={req.isPending} onClick={() => req.mutate(undefined)}>Submit for approval</Button>}>
      <p className="mb-3 text-xs text-subtle">Adjustments take effect only after a second authorised person approves them.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Bucket"><Select className="w-full" value={f.bucket} onChange={(e) => setF({ ...f, bucket: e.target.value })}>{['AVAILABLE', 'DAMAGED', 'QUARANTINED', 'EXPIRED'].map((b) => <option key={b}>{b}</option>)}</Select></Field>
        <Field label="Quantity (+/-)"><Input type="number" value={f.quantityDelta} onChange={(e) => setF({ ...f, quantityDelta: e.target.value })} /></Field>
        <Field label="Reason"><Select className="w-full" value={f.reasonCode} onChange={(e) => setF({ ...f, reasonCode: e.target.value })}>{['FOUND', 'LOST', 'THEFT', 'DATA_CORRECTION', 'WRITE_OFF', 'DAMAGE_WRITE_OFF', 'EXPIRY_WRITE_OFF'].map((r) => <option key={r} value={r}>{title(r)}</option>)}</Select></Field>
        <Field label="Notes"><Input onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
      <div className="mt-3"><FormError error={req.error} /></div>
    </Modal>
  );
}

function StatusModal({ batch, warehouseId, onClose }: { batch: any; warehouseId: string; onClose: () => void }) {
  const [f, setF] = useState<any>({ action: 'QUARANTINE', quantity: 1, reason: '' });
  const go = useAction(() => api(`/inventory/warehouses/${warehouseId}/status-changes`, { method: 'POST', json: { ...f, quantity: Number(f.quantity), batchId: batch.id, idempotencyKey: newIdempotencyKey() } }), ['/inventory'], onClose);
  return (
    <Modal open onClose={onClose} title={`Quality action · ${batch.batchNumber}`} footer={<Button loading={go.isPending} onClick={() => go.mutate(undefined)}>Apply</Button>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Action"><Select className="w-full" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}>
          <option value="QUARANTINE">Available → Quarantined</option><option value="DAMAGE">Available → Damaged</option>
          <option value="QUARANTINE_RELEASE">Quarantined → Available</option><option value="QUARANTINE_TO_DAMAGED">Quarantined → Damaged</option>
        </Select></Field>
        <Field label="Quantity"><Input type="number" min={1} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>
        <div className="col-span-2"><Field label="Reason"><Input required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field></div>
      </div>
      <div className="mt-3"><FormError error={go.error} /></div>
    </Modal>
  );
}

function Expiring() {
  const siteId = useUi((s) => s.siteId) ?? '';
  const [days, setDays] = useState(7);
  const q = useGet<any[]>(['/inventory/expiring', days, siteId], `/inventory/expiring?days=${days}${siteId ? `&warehouseId=${siteId}` : ''}`);
  return (
    <Card actions={<Select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Window">{[3, 7, 14, 30].map((n) => <option key={n} value={n}>Next {n} days</option>)}</Select>} title="Batches nearing expiry">
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} /> : !q.data?.length ? <Empty message="Nothing expiring in this window." /> : (
        <DataTable rows={q.data} rowKey={(b) => b.id} columns={[
          { key: 'p', header: 'Product', render: (b) => b.sku.product.name },
          { key: 's', header: 'Site', render: (b) => b.warehouse.code },
          { key: 'b', header: 'Batch', render: (b) => <span className="font-mono text-xs">{b.batchNumber}</span> },
          { key: 'e', header: 'Expires', render: (b) => <span className={new Date(b.expiresAt) < new Date() ? 'text-bad' : 'text-warn'}>{d(b.expiresAt)}</span> },
          { key: 'u', header: 'Units on hand', render: (b) => b.balance?.onHand, className: 'text-right' },
        ]} />
      )}
    </Card>
  );
}

function Movements() {
  const siteId = useUi((s) => s.siteId) ?? undefined;
  const list = useList<any>('/inventory/movements', { warehouseId: siteId });
  return (
    <Card title="Ledger movements (append-only)">
      <div className="mb-3 flex gap-2">
        <Select onChange={(e) => list.set({ movementType: e.target.value || undefined })} aria-label="Type">
          <option value="">All types</option>
          {['RECEIPT', 'PUTAWAY', 'RESERVE', 'RELEASE', 'PICK', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DAMAGE', 'QUARANTINE', 'QUARANTINE_RELEASE', 'EXPIRE', 'TRANSFER_OUT', 'TRANSFER_IN', 'RETURN_IN', 'COUNT_CORRECTION', 'WRITE_OFF'].map((t) => <option key={t}>{t}</option>)}
        </Select>
      </div>
      {list.isLoading ? <Spinner /> : list.error ? <ErrorState error={list.error} /> : !list.data?.data.length ? <Empty message="No movements." /> : (
        <>
          <DataTable rows={list.data.data} rowKey={(m) => m.id} columns={[
            { key: 't', header: 'Time', render: (m) => dt(m.createdAt) },
            { key: 'ty', header: 'Type', render: (m) => <Badge>{m.movementType}</Badge> },
            { key: 'f', header: 'From → To', render: (m) => `${m.fromBucket} → ${m.toBucket}` },
            { key: 'q', header: 'Qty', render: (m) => m.quantity, className: 'text-right' },
            { key: 'r', header: 'Reference', render: (m) => <span className="text-xs">{m.referenceType} <span className="font-mono text-subtle">{m.referenceId.slice(0, 8)}</span></span> },
            { key: 'a', header: 'Actor', render: (m) => m.actorType },
            { key: 'rs', header: 'Reason', render: (m) => <span className="text-xs text-subtle">{m.reason}</span> },
          ]} />
          <Pager {...list.data.meta} onPage={list.setPage} />
        </>
      )}
    </Card>
  );
}

function Adjustments() {
  const can = useCan();
  const [status, setStatus] = useState('PENDING');
  const q = useGet<any[]>(['/inventory/adjustments', status], `/inventory/adjustments?status=${status}`);
  const decide = useAction(({ id, approve }: { id: string; approve: boolean }) => api(`/inventory/adjustments/${id}/decision`, { method: 'POST', json: { approve } }), ['/inventory/adjustments', '/inventory']);
  return (
    <Card title="Adjustment requests" actions={<Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">{['PENDING', 'APPROVED', 'REJECTED'].map((s) => <option key={s}>{s}</option>)}</Select>}>
      <FormError error={decide.error} />
      {q.isLoading ? <Spinner /> : !q.data?.length ? <Empty message="No adjustments." /> : (
        <DataTable rows={q.data} rowKey={(a) => a.id} columns={[
          { key: 't', header: 'Requested', render: (a) => dt(a.createdAt) },
          { key: 'b', header: 'Bucket', render: (a) => a.bucket },
          { key: 'q', header: 'Δ Qty', render: (a) => <span className={a.quantityDelta < 0 ? 'text-bad' : 'text-ok'}>{a.quantityDelta > 0 ? '+' : ''}{a.quantityDelta}</span>, className: 'text-right' },
          { key: 'r', header: 'Reason', render: (a) => title(a.reasonCode) },
          { key: 'n', header: 'Notes', render: (a) => <span className="text-xs text-subtle">{a.notes}</span> },
          { key: 's', header: 'Status', render: (a) => <StatusBadge status={a.status} /> },
          { key: 'x', header: '', render: (a) => a.status === 'PENDING' && can('inventory.adjust.approve') && (
            <div className="flex gap-1">
              <Button size="sm" onClick={() => decide.mutate({ id: a.id, approve: true })}>Approve</Button>
              <Button size="sm" variant="secondary" onClick={() => decide.mutate({ id: a.id, approve: false })}>Reject</Button>
            </div>
          ) },
        ]} />
      )}
    </Card>
  );
}

function Counts() {
  const can = useCan();
  const siteId = useUi((s) => s.siteId);
  const q = useGet<any[]>(['/inventory/counts', siteId], `/inventory/counts${siteId ? `?warehouseId=${siteId}` : ''}`);
  const [open, setOpen] = useState<string | null>(null);
  const create = useAction(() => api('/inventory/counts', { method: 'POST', json: { warehouseId: siteId } }), ['/inventory/counts'], (c: any) => setOpen(c.id));
  return (
    <Card title="Cycle counts" actions={can('inventory.count') && <Button size="sm" disabled={!siteId} title={!siteId ? 'Select a site in the top bar' : undefined} loading={create.isPending} onClick={() => create.mutate(undefined)}>Start blind count</Button>}>
      <FormError error={create.error} />
      {q.isLoading ? <Spinner /> : !q.data?.length ? <Empty message="No counts yet." /> : (
        <DataTable rows={q.data} rowKey={(c) => c.id} onRowClick={(c) => setOpen(c.id)} columns={[
          { key: 'c', header: 'Created', render: (c) => dt(c.createdAt) },
          { key: 'i', header: 'Lines', render: (c) => c._count.items },
          { key: 'b', header: 'Blind', render: (c) => (c.blind ? 'Yes' : 'No') },
          { key: 's', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
        ]} />
      )}
      {open && <CountSheet id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function CountSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const can = useCan();
  const q = useGet<any>(['/inventory/counts', id], `/inventory/counts/${id}`);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any>(null);
  const submit = useAction(() => api(`/inventory/counts/${id}/submit`, { method: 'POST', json: { lines: Object.entries(counts).filter(([, v]) => v !== '').map(([itemId, v]) => ({ itemId, countedQuantity: Number(v) })) } }), ['/inventory/counts']);
  const reconcile = useAction(() => api(`/inventory/counts/${id}/reconcile`, { method: 'POST' }), ['/inventory/counts', '/inventory'], setResult);
  if (q.isLoading) return null;
  const c = q.data;
  return (
    <Modal open onClose={onClose} wide title={`Count · ${c.status}`} footer={<>
      {c.status === 'OPEN' && <Button loading={submit.isPending} onClick={() => submit.mutate(undefined)}>Save counts</Button>}
      {c.status === 'SUBMITTED' && can('inventory.count.reconcile') && <Button loading={reconcile.isPending} onClick={() => reconcile.mutate(undefined)}>Reconcile</Button>}
    </>}>
      <DataTable rows={c.items} rowKey={(i: any) => i.id} columns={[
        { key: 's', header: 'SKU', render: (i: any) => <span className="font-mono text-xs">{i.skuId.slice(0, 8)}</span> },
        { key: 'b', header: 'Batch', render: (i: any) => <span className="font-mono text-xs">{i.batchId.slice(0, 8)}</span> },
        { key: 'sys', header: 'System', render: (i: any) => i.systemQuantity ?? <span className="text-subtle">hidden (blind)</span> },
        { key: 'c', header: 'Counted', render: (i: any) => c.status === 'OPEN'
          ? <Input type="number" min={0} className="w-24" defaultValue={i.countedQuantity ?? ''} onChange={(e) => setCounts({ ...counts, [i.id]: e.target.value })} />
          : i.countedQuantity },
      ]} />
      <FormError error={submit.error || reconcile.error} />
      {result && <p className="mt-3 text-sm">Booked {result.corrections.length} corrections; {result.discrepancies.length} discrepancies need manual review.</p>}
    </Modal>
  );
}

function Transfers() {
  const can = useCan();
  const q = useGet<any[]>(['/inventory/transfers'], '/inventory/transfers');
  const sites = useSites();
  const name = (id: string) => sites.data?.data.find((s: any) => s.id === id)?.code ?? id.slice(0, 8);
  const act = useAction(({ id, step, body }: { id: string; step: string; body?: any }) => api(`/inventory/transfers/${id}/${step}`, { method: 'POST', json: body ?? {} }), ['/inventory/transfers', '/inventory']);
  return (
    <Card title="Stock transfers">
      <FormError error={act.error} />
      {q.isLoading ? <Spinner /> : !q.data?.length ? <Empty message="No transfers." /> : (
        <DataTable rows={q.data} rowKey={(t) => t.id} columns={[
          { key: 'n', header: 'Number', render: (t) => <span className="font-mono text-xs">{t.transferNumber}</span> },
          { key: 'r', header: 'Route', render: (t) => `${name(t.fromWarehouseId)} → ${name(t.toWarehouseId)}` },
          { key: 'i', header: 'Lines', render: (t) => t.items.length },
          { key: 'u', header: 'Units', render: (t) => t.items.reduce((s: number, i: any) => s + i.quantity, 0), className: 'text-right' },
          { key: 's', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
          { key: 'x', header: '', render: (t) => can('inventory.transfer') && (
            t.status === 'DRAFT' ? <Button size="sm" onClick={() => act.mutate({ id: t.id, step: 'dispatch' })}>Dispatch</Button>
            : t.status === 'DISPATCHED' ? <Button size="sm" onClick={() => act.mutate({ id: t.id, step: 'receive', body: { lines: t.items.map((i: any) => ({ itemId: i.id, receivedQty: i.dispatchedQty })) } })}>Receive all</Button>
            : null
          ) },
        ]} />
      )}
    </Card>
  );
}
