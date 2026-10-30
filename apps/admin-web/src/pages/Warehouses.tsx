import { FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, Card, DataTable, Empty, ErrorState, Field, FormError, Input, Modal, PageHeader, Pager, Select, Spinner, Stat, StatusBadge, cn } from '@/components/ui';
import { api } from '@/lib/api';
import { num, pct, title } from '@/lib/format';
import { useAction, useGet, useList } from '@/lib/hooks';
import { useCan } from '@/stores/auth';

export function WarehouseList({ darkStores = false }: { darkStores?: boolean }) {
  const can = useCan();
  const navigate = useNavigate();
  const path = darkStores ? '/dark-stores' : '/warehouses';
  const list = useList<any>(path);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title={darkStores ? 'Dark stores' : 'Warehouses & sites'}
        subtitle={darkStores ? 'Customer-facing fulfilment sites' : 'Central warehouses, distribution centres and dark stores'}
        actions={can(darkStores ? 'dark_stores.manage' : 'warehouses.manage') && <Button onClick={() => setCreating(true)}>New {darkStores ? 'dark store' : 'site'}</Button>}
      />
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <Input placeholder="Search name, code, city" className="max-w-xs" onChange={(e) => list.set({ search: e.target.value })} />
          {!darkStores && (
            <Select onChange={(e) => list.set({ type: e.target.value || undefined })} aria-label="Type">
              <option value="">All types</option>
              <option value="CENTRAL_WAREHOUSE">Central warehouse</option>
              <option value="DISTRIBUTION_CENTER">Distribution centre</option>
              <option value="DARK_STORE">Dark store</option>
            </Select>
          )}
          <Select onChange={(e) => list.set({ status: e.target.value || undefined })} aria-label="Status">
            <option value="">All statuses</option>
            {['ACTIVE', 'INACTIVE', 'MAINTENANCE', 'CLOSED'].map((s) => <option key={s} value={s}>{title(s)}</option>)}
          </Select>
        </div>
        {list.isLoading ? <Spinner /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.data.length ? (
          <Empty message="No sites match these filters." />
        ) : (
          <>
            <DataTable
              rows={list.data.data}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/warehouses/${r.id}`)}
              columns={[
                { key: 'code', header: 'Code', render: (r) => <span className="font-mono text-xs">{r.code}</span> },
                { key: 'name', header: 'Name', render: (r) => r.name },
                { key: 'type', header: 'Type', render: (r) => <Badge>{title(r.type)}</Badge> },
                { key: 'city', header: 'City', render: (r) => `${r.city}, ${r.state}` },
                { key: 'cap', header: 'Capacity', render: (r) => num(r.capacityUnits), className: 'text-right' },
                ...(darkStores ? [{ key: 'acc', header: 'Orders', render: (r: any) => (r.darkStore?.acceptingOrders ? <Badge tone="ok">Accepting</Badge> : <Badge tone="bad">Paused</Badge>) }] : []),
                { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
              ]}
            />
            <Pager {...list.data.meta} onPage={list.setPage} />
          </>
        )}
      </Card>
      <CreateSite open={creating} onClose={() => setCreating(false)} darkStore={darkStores} />
    </>
  );
}

function CreateSite({ open, onClose, darkStore }: { open: boolean; onClose: () => void; darkStore: boolean }) {
  const [f, setF] = useState<any>({ type: darkStore ? 'DARK_STORE' : 'CENTRAL_WAREHOUSE', state: 'KA', city: 'Bengaluru' });
  const set = (k: string) => (e: any) => setF((x: any) => ({ ...x, [k]: e.target.value }));
  const create = useAction((body: any) => api('/warehouses', { method: 'POST', json: body }), ['/warehouses', '/dark-stores'], onClose);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: any = {
      code: f.code, name: f.name, type: f.type, addressLine1: f.addressLine1, city: f.city, state: f.state, postalCode: f.postalCode,
      capacityUnits: f.capacityUnits ? Number(f.capacityUnits) : undefined,
      latitude: f.latitude ? Number(f.latitude) : undefined, longitude: f.longitude ? Number(f.longitude) : undefined,
    };
    if (f.type === 'DARK_STORE') body.darkStore = { serviceRadiusKm: Number(f.radius || 3), servicePostalCodes: (f.pins || '').split(/[\s,]+/).filter(Boolean) };
    create.mutate(body);
  };
  return (
    <Modal open={open} onClose={onClose} title={darkStore ? 'Register dark store' : 'Register site'} wide
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="site-form" type="submit" loading={create.isPending}>Create</Button></>}>
      <form id="site-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" hint="Uppercase letters, digits, dashes"><Input required pattern="[A-Z0-9-]{2,20}" onChange={set('code')} /></Field>
        <Field label="Name"><Input required onChange={set('name')} /></Field>
        {!darkStore && (
          <Field label="Type">
            <Select value={f.type} onChange={set('type')} className="w-full">
              <option value="CENTRAL_WAREHOUSE">Central warehouse</option>
              <option value="DISTRIBUTION_CENTER">Distribution centre</option>
              <option value="DARK_STORE">Dark store</option>
            </Select>
          </Field>
        )}
        <Field label="Capacity (units)"><Input type="number" min={0} onChange={set('capacityUnits')} /></Field>
        <Field label="Address"><Input required onChange={set('addressLine1')} /></Field>
        <Field label="City"><Input required value={f.city} onChange={set('city')} /></Field>
        <Field label="State"><Input required value={f.state} onChange={set('state')} /></Field>
        <Field label="PIN code"><Input required pattern="[0-9]{6}" onChange={set('postalCode')} /></Field>
        <Field label="Latitude" hint={f.type === 'DARK_STORE' ? 'Required for serviceability' : undefined}><Input type="number" step="any" required={f.type === 'DARK_STORE'} onChange={set('latitude')} /></Field>
        <Field label="Longitude"><Input type="number" step="any" required={f.type === 'DARK_STORE'} onChange={set('longitude')} /></Field>
        {f.type === 'DARK_STORE' && (
          <>
            <Field label="Service radius (km)"><Input type="number" step="0.5" min={0.5} defaultValue={3} onChange={set('radius')} /></Field>
            <Field label="Serviceable PIN codes" hint="Comma separated"><Input onChange={set('pins')} /></Field>
          </>
        )}
        <div className="sm:col-span-2"><FormError error={create.error} /></div>
      </form>
    </Modal>
  );
}

const CELL: Record<string, string> = {
  EMPTY: 'bg-muted border-border',
  ASSIGNED: 'bg-brand/15 border-brand/40',
  OCCUPIED: 'bg-brand border-brand',
  RESERVED: 'bg-warn/30 border-warn',
  RESTRICTED: 'bg-bad/25 border-bad',
  BLOCKED: 'bg-bad/60 border-bad',
};

export function WarehouseDetail() {
  const { id } = useParams();
  const can = useCan();
  const wh = useGet<any>(['/warehouses', id], `/warehouses/${id}`);
  const layout = useGet<any>(['/warehouses', id, 'layout'], `/warehouses/${id}/layout`);
  const perf = useGet<any>(['/dark-stores', id, 'perf'], wh.data?.type === 'DARK_STORE' ? `/dark-stores/${id}/performance` : null);
  const [gen, setGen] = useState(false);
  const [selected, setSelected] = useState<any>(null);

  if (wh.isLoading) return <Spinner />;
  if (wh.error) return <ErrorState error={wh.error} />;
  const w = wh.data;
  return (
    <>
      <PageHeader title={`${w.code} · ${w.name}`} subtitle={`${title(w.type)} · ${w.addressLine1}, ${w.city} ${w.postalCode}`}
        actions={can('layout.manage') && <Button variant="secondary" onClick={() => setGen(true)}>Generate zone layout</Button>} />
      {perf.data && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label={`Orders (${perf.data.period.days}d)`} value={num(perf.data.orders.total)} />
          <Stat label="Avg order→delivery" value={perf.data.fulfillment.avgOrderToDeliveryMinutes ? `${num(perf.data.fulfillment.avgOrderToDeliveryMinutes, 1)} min` : '—'} />
          <Stat label="Avg pick" value={perf.data.fulfillment.avgPickSeconds ? `${num(perf.data.fulfillment.avgPickSeconds)} s` : '—'} />
          <Stat label="Stockout rate" value={pct(perf.data.inventory.stockoutRate)} />
          <Stat label="Last edge sync" value={perf.data.sync.lastSyncAt ? new Date(perf.data.sync.lastSyncAt).toLocaleTimeString() : 'never'} />
        </div>
      )}
      <Card title="Layout" actions={layout.data && <span className="text-xs text-subtle">{layout.data.summary.bins} bins · utilization {pct(layout.data.summary.utilization)}</span>}>
        <div className="mb-3 flex flex-wrap gap-3 text-xs text-subtle">
          {Object.entries(CELL).map(([k, c]) => <span key={k} className="flex items-center gap-1"><span className={cn('h-3 w-3 rounded-sm border', c)} />{title(k)}</span>)}
        </div>
        {layout.isLoading ? <Spinner /> : !layout.data?.tree.length ? <Empty message="No layout defined yet." /> : (
          <div className="space-y-6">
            {layout.data.tree.map((zone: any) => (
              <div key={zone.id}>
                <p className="mb-2 text-sm font-medium">Zone {zone.code} <Badge>{zone.temperatureZone}</Badge></p>
                <div className="flex flex-wrap gap-4">
                  {zone.children.map((aisle: any) => (
                    <div key={aisle.id} className="rounded-md border border-border p-2">
                      <p className="mb-1 text-[11px] text-subtle">Aisle {aisle.code}</p>
                      <div className="flex gap-1">
                        {aisle.children.map((rack: any) => (
                          <div key={rack.id} className="flex flex-col-reverse gap-0.5">
                            {rack.children.map((shelf: any) => (
                              <div key={shelf.id} className="flex gap-0.5">
                                {shelf.children.map((bin: any) => {
                                  const k = bin.state !== 'AVAILABLE' ? bin.state : bin.occupancy;
                                  return (
                                    <button key={bin.id} title={`${bin.fullCode} · ${title(k)}`} onClick={() => setSelected(bin)}
                                      className={cn('h-4 w-4 rounded-[3px] border', CELL[k])} aria-label={`Bin ${bin.fullCode}`} />
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      <GenerateLayout open={gen} onClose={() => setGen(false)} warehouseId={id!} />
      <BinDetail bin={selected} warehouseId={id!} onClose={() => setSelected(null)} />
    </>
  );
}

function GenerateLayout({ open, onClose, warehouseId }: { open: boolean; onClose: () => void; warehouseId: string }) {
  const [f, setF] = useState<any>({ zoneCode: 'A', aisles: 4, racksPerAisle: 6, shelvesPerRack: 4, binsPerShelf: 3, binCapacityUnits: 50, temperatureZone: 'AMBIENT' });
  const gen = useAction((body: any) => api(`/warehouses/${warehouseId}/layout/generate`, { method: 'POST', json: body }), ['/warehouses'], onClose);
  const num = (k: string) => (e: any) => setF((x: any) => ({ ...x, [k]: Number(e.target.value) }));
  return (
    <Modal open={open} onClose={onClose} title="Generate zone layout"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={gen.isPending} onClick={() => gen.mutate(f)}>Generate {f.aisles * f.racksPerAisle * f.shelvesPerRack * f.binsPerShelf} bins</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Zone code"><Input value={f.zoneCode} onChange={(e) => setF({ ...f, zoneCode: e.target.value.toUpperCase() })} /></Field>
        <Field label="Temperature"><Select className="w-full" value={f.temperatureZone} onChange={(e) => setF({ ...f, temperatureZone: e.target.value })}>{['AMBIENT', 'CHILLED', 'FROZEN'].map((t) => <option key={t}>{t}</option>)}</Select></Field>
        <Field label="Aisles"><Input type="number" min={1} max={50} value={f.aisles} onChange={num('aisles')} /></Field>
        <Field label="Racks per aisle"><Input type="number" min={1} max={50} value={f.racksPerAisle} onChange={num('racksPerAisle')} /></Field>
        <Field label="Shelves per rack"><Input type="number" min={1} max={20} value={f.shelvesPerRack} onChange={num('shelvesPerRack')} /></Field>
        <Field label="Bins per shelf"><Input type="number" min={1} max={20} value={f.binsPerShelf} onChange={num('binsPerShelf')} /></Field>
        <Field label="Bin capacity (units)"><Input type="number" min={1} value={f.binCapacityUnits} onChange={num('binCapacityUnits')} /></Field>
      </div>
      <div className="mt-3"><FormError error={gen.error} /></div>
    </Modal>
  );
}

function BinDetail({ bin, warehouseId, onClose }: { bin: any; warehouseId: string; onClose: () => void }) {
  const can = useCan();
  const update = useAction((state: string) => api(`/warehouses/${warehouseId}/locations/${bin.id}`, { method: 'PATCH', json: { state } }), ['/warehouses'], onClose);
  if (!bin) return null;
  return (
    <Modal open={!!bin} onClose={onClose} title={`Bin ${bin.fullCode}`}>
      <div className="flex gap-4">
        <img alt={`Barcode ${bin.barcode}`} className="h-24 rounded border border-border bg-white p-1" src={`/api/v1/labels/qr.svg?text=${encodeURIComponent(bin.barcode)}`} />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-subtle">Barcode</dt><dd className="font-mono text-xs">{bin.barcode}</dd>
          <dt className="text-subtle">State</dt><dd><StatusBadge status={bin.state} /></dd>
          <dt className="text-subtle">Occupied</dt><dd>{bin.occupiedUnits} / {bin.capacityUnits ?? '∞'}</dd>
          <dt className="text-subtle">Pick sequence</dt><dd>{bin.pickSequence}</dd>
        </dl>
      </div>
      {can('layout.manage') && (
        <div className="mt-4 flex flex-wrap gap-2">
          {['AVAILABLE', 'RESERVED', 'RESTRICTED', 'BLOCKED'].filter((s) => s !== bin.state).map((s) => (
            <Button key={s} size="sm" variant="secondary" loading={update.isPending} onClick={() => update.mutate(s)}>Mark {title(s)}</Button>
          ))}
        </div>
      )}
      <FormError error={update.error} />
    </Modal>
  );
}
