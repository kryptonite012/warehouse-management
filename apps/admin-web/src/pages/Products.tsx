import { FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, Card, DataTable, Empty, ErrorState, Field, FormError, Input, Modal, PageHeader, Pager, Select, Spinner, StatusBadge } from '@/components/ui';
import { api } from '@/lib/api';
import { inr, title } from '@/lib/format';
import { useAction, useGet, useList } from '@/lib/hooks';
import { useAuth, useCan } from '@/stores/auth';

export function ProductList() {
  const can = useCan();
  const navigate = useNavigate();
  const list = useList<any>('/products');
  const cats = useGet<any[]>(['/categories'], '/categories');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const token = useAuth((s) => s.accessToken);

  const exportCsv = async () => {
    const res = await fetch('/api/v1/products/export.csv', { headers: { authorization: `Bearer ${token}` } });
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement('a'), { href: url, download: 'products.csv' }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader title="Product catalog" subtitle="Products, SKUs, prices and barcodes"
        actions={<>
          <Button variant="secondary" onClick={exportCsv}>Export CSV</Button>
          {can('products.manage') && <Button variant="secondary" onClick={() => setImporting(true)}>Import CSV</Button>}
          {can('products.manage') && <Button onClick={() => setCreating(true)}>New product</Button>}
        </>} />
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <Input placeholder="Search name or SKU" className="max-w-xs" onChange={(e) => list.set({ search: e.target.value })} />
          <Input placeholder="Scan / type barcode" className="max-w-[200px]" onChange={(e) => list.set({ barcode: e.target.value || undefined })} />
          <Select onChange={(e) => list.set({ categoryId: e.target.value || undefined })} aria-label="Category">
            <option value="">All categories</option>
            {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.parentId ? '— ' : ''}{c.name}</option>)}
          </Select>
          <Select onChange={(e) => list.set({ status: e.target.value || undefined })} aria-label="Status">
            <option value="">Any status</option>
            {['ACTIVE', 'DRAFT', 'INACTIVE', 'DISCONTINUED'].map((s) => <option key={s} value={s}>{title(s)}</option>)}
          </Select>
        </div>
        {list.isLoading ? <Spinner /> : list.error ? <ErrorState error={list.error} /> : !list.data?.data.length ? <Empty message="No products found." /> : (
          <>
            <DataTable rows={list.data.data} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/products/${r.id}`)} columns={[
              { key: 'name', header: 'Product', render: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-subtle">{r.brand?.name}</p></div> },
              { key: 'cat', header: 'Category', render: (r) => r.category.name },
              { key: 'skus', header: 'SKUs', render: (r) => r.skus.map((s: any) => <span key={s.id} className="mr-1 font-mono text-xs">{s.code}</span>) },
              { key: 'price', header: 'Selling price', render: (r) => inr(r.skus[0]?.sellingPrice), className: 'text-right' },
              { key: 'storage', header: 'Storage', render: (r) => <Badge>{r.storageCondition}</Badge> },
              { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            ]} />
            <Pager {...list.data.meta} onPage={list.setPage} />
          </>
        )}
      </Card>
      <CreateProduct open={creating} onClose={() => setCreating(false)} categories={cats.data ?? []} />
      <ImportCsv open={importing} onClose={() => setImporting(false)} />
    </>
  );
}

function CreateProduct({ open, onClose, categories }: { open: boolean; onClose: () => void; categories: any[] }) {
  const [f, setF] = useState<any>({ storageCondition: 'AMBIENT', unit: 'EACH' });
  const set = (k: string) => (e: any) => setF((x: any) => ({ ...x, [k]: e.target.value }));
  const create = useAction((b: any) => api('/products', { method: 'POST', json: b }), ['/products'], onClose);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({
      name: f.name, brand: f.brand || undefined, categoryId: f.categoryId, description: f.description || undefined,
      storageCondition: f.storageCondition, shelfLifeDays: f.shelfLifeDays ? Number(f.shelfLifeDays) : undefined,
      skus: [{ code: f.code, variantName: f.variantName || undefined, unit: f.unit, mrp: Number(f.mrp), sellingPrice: Number(f.sellingPrice), purchasePrice: Number(f.purchasePrice),
        reorderPoint: f.reorderPoint ? Number(f.reorderPoint) : undefined, barcodes: f.barcode ? [f.barcode] : [] }],
    });
  };
  return (
    <Modal open={open} onClose={onClose} title="New product" wide footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="pform" loading={create.isPending}>Create</Button></>}>
      <form id="pform" onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2"><Field label="Name"><Input required onChange={set('name')} /></Field></div>
        <Field label="Brand"><Input onChange={set('brand')} /></Field>
        <Field label="Category"><Select required className="w-full" onChange={set('categoryId')} defaultValue=""><option value="" disabled>Select…</option>{categories.filter((c) => !c.parentId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label="Storage"><Select className="w-full" value={f.storageCondition} onChange={set('storageCondition')}>{['AMBIENT', 'CHILLED', 'FROZEN'].map((s) => <option key={s}>{s}</option>)}</Select></Field>
        <Field label="Shelf life (days)"><Input type="number" min={1} onChange={set('shelfLifeDays')} /></Field>
        <Field label="SKU code"><Input required pattern="[A-Z0-9-]{3,40}" onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} value={f.code ?? ''} /></Field>
        <Field label="Variant"><Input placeholder="500 ml" onChange={set('variantName')} /></Field>
        <Field label="Unit"><Select className="w-full" value={f.unit} onChange={set('unit')}>{['EACH', 'GRAM', 'KILOGRAM', 'MILLILITRE', 'LITRE', 'PACK'].map((s) => <option key={s}>{s}</option>)}</Select></Field>
        <Field label="MRP (₹)"><Input required type="number" step="0.01" min={0} onChange={set('mrp')} /></Field>
        <Field label="Selling price (₹)"><Input required type="number" step="0.01" min={0} onChange={set('sellingPrice')} /></Field>
        <Field label="Purchase price (₹)"><Input required type="number" step="0.01" min={0} onChange={set('purchasePrice')} /></Field>
        <Field label="Barcode (EAN)"><Input onChange={set('barcode')} /></Field>
        <Field label="Reorder point"><Input type="number" min={0} onChange={set('reorderPoint')} /></Field>
        <div className="sm:col-span-3"><Field label="Description"><Input onChange={set('description')} /></Field></div>
        <div className="sm:col-span-3"><FormError error={create.error} /></div>
      </form>
    </Modal>
  );
}

function ImportCsv({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<any>(null);
  const run = useAction((dryRun: boolean) => api('/products/import', { method: 'POST', json: { csv, dryRun } }), ['/products'], setResult);
  return (
    <Modal open={open} onClose={onClose} title="Bulk import products (CSV)" wide
      footer={<><Button variant="secondary" disabled={!csv} loading={run.isPending} onClick={() => run.mutate(true)}>Validate</Button><Button disabled={!csv || !result?.valid} loading={run.isPending} onClick={() => run.mutate(false)}>Import</Button></>}>
      <p className="mb-2 text-xs text-subtle">Required columns: product_name, category, sku_code, mrp, selling_price, purchase_price. Optional: brand, subcategory, storage_condition, shelf_life_days, variant_name, unit, barcodes (pipe-separated), reorder_point, tax_code, status. The whole file is validated before anything is written.</p>
      <input type="file" accept=".csv,text/csv" onChange={async (e) => { setResult(null); setCsv((await e.target.files?.[0]?.text()) ?? ''); }} />
      {result && (
        <div className="mt-3 text-sm">
          {result.imported ? <p className="text-ok">Imported {result.imported} products ({result.skus} SKUs).</p>
            : result.valid ? <p className="text-ok">File is valid: {result.products} products, {result.skus} SKUs.</p>
            : <ul className="max-h-48 list-disc overflow-y-auto pl-5 text-bad">{result.errors.map((e: any, i: number) => <li key={i}>{e.row ? `Row ${e.row}: ` : ''}{e.message}</li>)}</ul>}
        </div>
      )}
      <FormError error={run.error} />
    </Modal>
  );
}

export function ProductDetail() {
  const { id } = useParams();
  const can = useCan();
  const p = useGet<any>(['/products', id], `/products/${id}`);
  const [pricing, setPricing] = useState<any>(null);
  const setStatus = useAction((status: string) => api(`/products/${id}`, { method: 'PATCH', json: { version: p.data.version, status } }), ['/products']);
  if (p.isLoading) return <Spinner />;
  if (p.error) return <ErrorState error={p.error} />;
  const prod = p.data;
  return (
    <>
      <PageHeader title={prod.name} subtitle={`${prod.category.name}${prod.brand ? ` · ${prod.brand.name}` : ''} · ${prod.storageCondition}`}
        actions={can('products.manage') && (prod.status === 'ACTIVE'
          ? <Button variant="secondary" onClick={() => setStatus.mutate('INACTIVE')} loading={setStatus.isPending}>Deactivate</Button>
          : <Button onClick={() => setStatus.mutate('ACTIVE')} loading={setStatus.isPending}>Activate</Button>)} />
      <FormError error={setStatus.error} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-1">
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-subtle">Status</dt><dd><StatusBadge status={prod.status} /></dd>
            <dt className="text-subtle">Shelf life</dt><dd>{prod.shelfLifeDays ? `${prod.shelfLifeDays} days` : '—'}</dd>
            <dt className="text-subtle">Batch tracked</dt><dd>{prod.batchTracked ? 'Yes' : 'No'}</dd>
            <dt className="text-subtle">Expiry tracked</dt><dd>{prod.expiryTracked ? 'Yes' : 'No'}</dd>
            <dt className="text-subtle">Tax</dt><dd>{prod.taxCategory ? `${prod.taxCategory.code} (${prod.taxCategory.ratePercent}%)` : '—'}</dd>
          </dl>
          {prod.description && <p className="mt-3 text-sm text-subtle">{prod.description}</p>}
        </Card>
        <Card title="SKUs" className="lg:col-span-2">
          <DataTable rows={prod.skus} rowKey={(s: any) => s.id} columns={[
            { key: 'code', header: 'SKU', render: (s: any) => <span className="font-mono text-xs">{s.code}</span> },
            { key: 'v', header: 'Variant', render: (s: any) => s.variantName ?? '—' },
            { key: 'mrp', header: 'MRP', render: (s: any) => inr(s.mrp), className: 'text-right' },
            { key: 'sp', header: 'Selling', render: (s: any) => inr(s.sellingPrice), className: 'text-right' },
            { key: 'pp', header: 'Purchase', render: (s: any) => (s.purchasePrice === null ? <span className="text-subtle">hidden</span> : inr(s.purchasePrice)), className: 'text-right' },
            { key: 'rp', header: 'Reorder pt', render: (s: any) => s.reorderPoint, className: 'text-right' },
            { key: 'bc', header: 'Barcodes', render: (s: any) => s.barcodes.map((b: any) => <img key={b.id} alt={b.barcode} className="mr-1 inline h-10 bg-white" src={`/api/v1/labels/barcode.svg?text=${b.barcode}`} />) },
            { key: 'a', header: '', render: (s: any) => can('products.manage') && <Button size="sm" variant="secondary" onClick={() => setPricing(s)}>Edit</Button> },
          ]} />
        </Card>
      </div>
      {pricing && <PricingModal sku={pricing} onClose={() => setPricing(null)} />}
    </>
  );
}

function PricingModal({ sku, onClose }: { sku: any; onClose: () => void }) {
  const can = useCan();
  const canPrice = can('prices.manage');
  const [f, setF] = useState<any>({ mrp: sku.mrp, sellingPrice: sku.sellingPrice, purchasePrice: sku.purchasePrice, reorderPoint: sku.reorderPoint, reorderQty: sku.reorderQty });
  const save = useAction(() => {
    const body: any = { version: sku.version, reorderPoint: Number(f.reorderPoint), reorderQty: Number(f.reorderQty) };
    if (canPrice) Object.assign(body, { mrp: Number(f.mrp), sellingPrice: Number(f.sellingPrice), purchasePrice: Number(f.purchasePrice) });
    return api(`/skus/${sku.id}/pricing`, { method: 'PATCH', json: body });
  }, ['/products'], onClose);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title={`Edit ${sku.code}`} footer={<Button loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="MRP"><Input disabled={!canPrice} type="number" step="0.01" value={f.mrp} onChange={set('mrp')} /></Field>
        <Field label="Selling price"><Input disabled={!canPrice} type="number" step="0.01" value={f.sellingPrice} onChange={set('sellingPrice')} /></Field>
        <Field label="Purchase price" hint={!canPrice ? 'Requires prices.manage' : undefined}><Input disabled={!canPrice} type="number" step="0.01" value={f.purchasePrice ?? ''} onChange={set('purchasePrice')} /></Field>
        <Field label="Reorder point"><Input type="number" value={f.reorderPoint} onChange={set('reorderPoint')} /></Field>
        <Field label="Reorder qty"><Input type="number" value={f.reorderQty} onChange={set('reorderQty')} /></Field>
      </div>
      <div className="mt-3"><FormError error={save.error} /></div>
    </Modal>
  );
}
