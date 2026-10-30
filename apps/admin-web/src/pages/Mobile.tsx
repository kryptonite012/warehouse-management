import { Camera, CheckCircle2, LogOut, MapPin, PackageCheck, ScanLine } from 'lucide-react';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Empty, FormError, Input, Select, Spinner, StatusBadge, cn } from '@/components/ui';
import { api } from '@/lib/api';
import { d, inr } from '@/lib/format';
import { useAction, useGet, useSites } from '@/lib/hooks';
import { useAuth, useCan } from '@/stores/auth';
import { useUi } from '@/stores/ui';

function MobileFrame({ title, children, tabs }: { title: string; children: React.ReactNode; tabs?: React.ReactNode }) {
  const navigate = useNavigate();
  const logout = useAuth((s) => s.logout);
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-bg">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-panel px-4 py-3">
        <h1 className="text-lg font-semibold">{title}</h1>
        <button aria-label="Sign out" className="rounded p-2 hover:bg-muted" onClick={() => { logout(); navigate('/login'); }}><LogOut className="h-5 w-5" /></button>
      </header>
      {tabs}
      <main className="flex-1 space-y-3 p-3">{children}</main>
    </div>
  );
}

/** Camera scanning via the BarcodeDetector API where supported; hardware scanners type into the input. */
function ScanInput({ onScan, placeholder }: { onScan: (code: string) => void; placeholder: string }) {
  const [value, setValue] = useState('');
  const [camera, setCamera] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const supported = typeof window !== 'undefined' && 'BarcodeDetector' in window;

  useEffect(() => {
    if (!camera || !videoRef.current) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    const detector = new (window as any).BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'qr_code', 'upc_a'] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then((s) => {
      stream = s;
      videoRef.current!.srcObject = s;
      videoRef.current!.play();
      const tick = async () => {
        const codes = await detector.detect(videoRef.current!).catch(() => []);
        if (codes[0]) {
          onScan(codes[0].rawValue);
          setCamera(false);
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    }).catch(() => setCamera(false));
    return () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [camera, onScan]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onScan(value.trim());
    setValue('');
  };
  return (
    <div className="space-y-2">
      <form onSubmit={submit} className="flex gap-2">
        <div className="relative flex-1">
          <ScanLine className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-subtle" />
          <Input autoFocus inputMode="numeric" className="h-14 pl-10 text-lg" placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        {supported && <Button type="button" size="lg" variant="secondary" aria-label="Scan with camera" onClick={() => setCamera((c) => !c)}><Camera className="h-5 w-5" /></Button>}
      </form>
      {camera && <video ref={videoRef} className="w-full rounded-lg bg-black" muted playsInline />}
    </div>
  );
}

function StorePicker() {
  const { siteId, setSite } = useUi();
  const sites = useSites('DARK_STORE');
  if (siteId) return null;
  return (
    <div className="rounded-lg border border-border bg-panel p-3">
      <p className="mb-2 text-sm font-medium">Choose your store</p>
      <Select className="h-12 w-full" defaultValue="" onChange={(e) => setSite(e.target.value)}>
        <option value="" disabled>Select…</option>
        {sites.data?.data.map((s: any) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
      </Select>
    </div>
  );
}

function OpsTabs({ active }: { active: 'pick' | 'pack' }) {
  const navigate = useNavigate();
  const can = useCan();
  return (
    <nav className="grid grid-cols-2 border-b border-border bg-panel text-sm">
      {can('fulfillment.pick') && <button onClick={() => navigate('/ops/pick')} className={cn('py-3', active === 'pick' && 'border-b-2 border-brand font-semibold')}>Pick</button>}
      {can('fulfillment.pack') && <button onClick={() => navigate('/ops/pack')} className={cn('py-3', active === 'pack' && 'border-b-2 border-brand font-semibold')}>Pack</button>}
    </nav>
  );
}

export function PickerApp() {
  const siteId = useUi((s) => s.siteId);
  const [taskId, setTaskId] = useState<string | null>(null);
  const tasks = useGet<any[]>(['/picking-tasks', siteId, 'mobile'], siteId ? `/picking-tasks?warehouseId=${siteId}` : null);
  const claim = useAction((id: string) => api(`/picking-tasks/${id}/claim`, { method: 'POST' }), ['/picking-tasks'], (t: any) => setTaskId(t.id));
  if (taskId) return <PickTask id={taskId} onDone={() => setTaskId(null)} />;
  const me = useAuth.getState().me;
  const mine = tasks.data?.filter((t) => t.status === 'IN_PROGRESS' && t.assignedToId === me?.id) ?? [];
  const open = tasks.data?.filter((t) => t.status === 'PENDING' || (t.status === 'ASSIGNED' && t.assignedToId === me?.id)) ?? [];
  return (
    <MobileFrame title="Picking" tabs={<OpsTabs active="pick" />}>
      <StorePicker />
      <FormError error={claim.error} />
      {tasks.isLoading ? <Spinner /> : (
        <>
          {mine.map((t) => <TaskCard key={t.id} t={t} action="Continue" onClick={() => setTaskId(t.id)} />)}
          {open.length === 0 && mine.length === 0 ? <Empty message="No orders waiting to be picked." /> : open.map((t) => <TaskCard key={t.id} t={t} action="Start picking" onClick={() => claim.mutate(t.id)} />)}
        </>
      )}
    </MobileFrame>
  );
}

function TaskCard({ t, action, onClick }: { t: any; action: string; onClick: () => void }) {
  return (
    <div className="rounded-lg border border-border bg-panel p-4">
      <div className="flex items-center justify-between">
        <p className="font-mono text-sm">{t.order?.orderNumber}</p>
        <StatusBadge status={t.status} />
      </div>
      <p className="mt-1 text-sm text-subtle">{t.items.length} lines · {t.items.reduce((s: number, i: any) => s + i.quantity, 0)} units</p>
      <Button size="lg" className="mt-3 w-full" onClick={onClick}>{action}</Button>
    </div>
  );
}

function PickTask({ id, onDone }: { id: string; onDone: () => void }) {
  const task = useGet<any>(['/picking-tasks', id], `/picking-tasks/${id}`);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const scan = useAction(({ itemId, barcode }: { itemId: string; barcode: string }) => api(`/picking-tasks/${id}/scan`, { method: 'POST', json: { itemId, barcode, quantity: 1 } }), ['/picking-tasks']);
  const complete = useAction((shortPicks: any[]) => api(`/picking-tasks/${id}/complete`, { method: 'POST', json: { shortPicks } }), ['/picking-tasks'], onDone);
  if (task.isLoading) return <Spinner />;
  const t = task.data;
  const current = t.items.find((i: any) => i.pickedQty < i.quantity);
  const onScan = (barcode: string) => {
    if (!current) return;
    scan.mutate({ itemId: current.id, barcode }, {
      onSuccess: () => { setMsg({ ok: true, text: `✓ ${current.sku.name}` }); navigator.vibrate?.(40); },
      onError: (e: any) => { setMsg({ ok: false, text: e.message }); navigator.vibrate?.([80, 60, 80]); },
    });
  };
  return (
    <MobileFrame title={`Pick ${t.taskNumber}`}>
      {current ? (
        <div className="rounded-lg border-2 border-brand bg-panel p-4">
          <p className="text-xs uppercase tracking-wide text-subtle">Go to</p>
          <p className="flex items-center gap-2 text-3xl font-bold"><MapPin className="h-6 w-6 text-brand" />{current.locationCode ?? 'Unassigned'}</p>
          <div className="mt-3 flex gap-3">
            {current.sku.image ? <img src={current.sku.image} alt="" className="h-20 w-20 rounded object-cover" /> : <div className="grid h-20 w-20 place-items-center rounded bg-muted text-xs text-subtle">No image</div>}
            <div>
              <p className="font-semibold">{current.sku.name}</p>
              <p className="font-mono text-xs text-subtle">{current.sku.code} · {current.sku.barcode}</p>
              <p className="text-xs text-subtle">Batch {current.batch?.number} · exp {d(current.batch?.expiresAt)}</p>
              <p className="mt-1 text-2xl font-bold">{current.pickedQty} / {current.quantity}</p>
            </div>
          </div>
          <div className="mt-3"><ScanInput onScan={onScan} placeholder="Scan product barcode" /></div>
          {msg && <p className={cn('mt-2 rounded p-2 text-sm font-medium', msg.ok ? 'bg-ok/10 text-ok' : 'bg-bad/10 text-bad')}>{msg.text}</p>}
          <Button variant="ghost" className="mt-2 w-full" onClick={() => complete.mutate(t.items.filter((i: any) => i.pickedQty < i.quantity).map((i: any) => ({ itemId: i.id, pickedQty: i.pickedQty })))}>Item not found — finish with short pick</Button>
        </div>
      ) : (
        <div className="rounded-lg border border-ok bg-ok/5 p-4 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-ok" />
          <p className="mt-2 font-semibold">All items scanned</p>
          <Button size="lg" className="mt-3 w-full" loading={complete.isPending} onClick={() => complete.mutate([])}>Complete & send to packing</Button>
        </div>
      )}
      <FormError error={complete.error} />
      <ol className="space-y-1">
        {t.items.map((i: any) => (
          <li key={i.id} className={cn('flex items-center justify-between rounded border border-border bg-panel px-3 py-2 text-sm', i.pickedQty >= i.quantity && 'opacity-50')}>
            <span><b className="font-mono">{i.locationCode ?? '—'}</b> · {i.sku.name}</span>
            <span>{i.pickedQty}/{i.quantity}{i.verified && <Badge tone="ok">scanned</Badge>}</span>
          </li>
        ))}
      </ol>
    </MobileFrame>
  );
}

export function PackerApp() {
  const siteId = useUi((s) => s.siteId);
  const tasks = useGet<any[]>(['/packing-tasks', siteId, 'mobile'], siteId ? `/packing-tasks?warehouseId=${siteId}&status=PENDING` : null);
  const [active, setActive] = useState<any>(null);
  return (
    <MobileFrame title="Packing" tabs={<OpsTabs active="pack" />}>
      <StorePicker />
      {active ? <PackTask task={active} onDone={() => setActive(null)} /> : tasks.isLoading ? <Spinner /> : !tasks.data?.length ? <Empty message="Nothing to pack." /> : tasks.data.map((t) => (
        <div key={t.id} className="rounded-lg border border-border bg-panel p-4">
          <p className="font-mono text-sm">Order {t.orderId.slice(0, 8)}</p>
          <Button size="lg" className="mt-3 w-full" onClick={() => setActive(t)}><PackageCheck className="h-5 w-5" /> Pack</Button>
        </div>
      ))}
    </MobileFrame>
  );
}

function PackTask({ task, onDone }: { task: any; onDone: () => void }) {
  const order = useGet<any>(['/orders', task.orderId], `/orders/${task.orderId}`);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [pkg, setPkg] = useState('BAG_SMALL');
  const [label, setLabel] = useState<any>(null);
  const done = useAction(() => api(`/packing-tasks/${task.id}/complete`, { method: 'POST', json: { packagingType: pkg, lines: Object.entries(counts).map(([orderItemId, quantity]) => ({ orderItemId, quantity })) } }), ['/packing-tasks', '/orders'],
    async () => setLabel(await api(`/packing-tasks/${task.id}/label`)));
  if (order.isLoading) return <Spinner />;
  const o = order.data;
  const [scanError, setScanError] = useState<string | null>(null);
  const onScan = (code: string) => {
    setScanError(null);
    api(`/barcodes/${encodeURIComponent(code)}`)
      .then((b: any) => {
        const it = o.items.find((i: any) => i.skuId === b.skuId);
        if (!it) return setScanError('This item is not part of the order');
        setCounts((c) => ({ ...c, [it.id]: Math.min((c[it.id] ?? 0) + 1, it.pickedQty) }));
      })
      .catch(() => setScanError('Unknown barcode'));
  };
  if (label) {
    return (
      <div className="rounded-lg border border-ok bg-panel p-4 text-center">
        <CheckCircle2 className="mx-auto h-10 w-10 text-ok" />
        <p className="mt-2 text-lg font-semibold">{label.labelCode}</p>
        <img alt={label.labelCode} src={label.barcodeUrl} className="mx-auto my-3 bg-white" />
        <p className="text-sm">{label.deliverTo.line1}, {label.deliverTo.postalCode} · {label.itemCount} items</p>
        {label.codAmount && <p className="mt-1 font-semibold text-warn">Collect {inr(label.codAmount)} (COD)</p>}
        <div className="mt-3 flex gap-2"><Button variant="secondary" className="flex-1" onClick={() => window.print()}>Print label</Button><Button className="flex-1" onClick={onDone}>Next</Button></div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="font-mono text-sm">{o.orderNumber}</p>
      <ScanInput onScan={onScan} placeholder="Scan each item into the bag" />
      {scanError && <p className="rounded bg-bad/10 p-2 text-sm text-bad">{scanError}</p>}
      {o.items.map((i: any) => (
        <div key={i.id} className="flex items-center justify-between rounded border border-border bg-panel p-3">
          <span className="text-sm">{i.productName}</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setCounts({ ...counts, [i.id]: Math.max((counts[i.id] ?? 0) - 1, 0) })}>−</Button>
            <span className={cn('w-12 text-center font-semibold', (counts[i.id] ?? 0) === i.pickedQty ? 'text-ok' : '')}>{counts[i.id] ?? 0}/{i.pickedQty}</span>
            <Button size="sm" variant="secondary" onClick={() => setCounts({ ...counts, [i.id]: Math.min((counts[i.id] ?? 0) + 1, i.pickedQty) })}>+</Button>
          </div>
        </div>
      ))}
      <Select className="h-12 w-full" value={pkg} onChange={(e) => setPkg(e.target.value)} aria-label="Packaging">
        <option value="BAG_SMALL">Small bag</option><option value="BAG_LARGE">Large bag</option><option value="BOX">Box</option><option value="COLD_BAG">Insulated cold bag</option>
      </Select>
      <FormError error={done.error} />
      <Button size="lg" className="w-full" loading={done.isPending} onClick={() => done.mutate(undefined)}>Seal & label</Button>
    </div>
  );
}

export function RiderApp() {
  const list = useGet<any[]>(['/deliveries', 'rider'], '/deliveries');
  const [active, setActive] = useState<string | null>(null);
  const live = list.data?.filter((d) => !['DELIVERED', 'FAILED', 'CANCELLED'].includes(d.status)) ?? [];
  if (active) return <RiderDelivery id={active} onBack={() => setActive(null)} />;
  return (
    <MobileFrame title="My deliveries">
      <FormError error={list.error} />
      {list.isLoading ? <Spinner /> : !live.length ? <Empty message="No active deliveries. Stay available for the next assignment." /> : live.map((dl) => (
        <div key={dl.id} className="rounded-lg border border-border bg-panel p-4">
          <div className="flex items-center justify-between"><span className="font-mono text-sm">{dl.orderId.slice(0, 8)}</span><StatusBadge status={dl.status} /></div>
          <Button size="lg" className="mt-3 w-full" onClick={() => setActive(dl.id)}>Open</Button>
        </div>
      ))}
    </MobileFrame>
  );
}

function RiderDelivery({ id, onBack }: { id: string; onBack: () => void }) {
  const q = useGet<any>(['/deliveries', id], `/deliveries/${id}`);
  const [otp, setOtp] = useState('');
  const [note, setNote] = useState('');
  const position = async (): Promise<{ latitude?: number; longitude?: number }> =>
    new Promise((res) => {
      // Only a real device fix is sent; if unavailable, no coordinates are recorded.
      if (!navigator.geolocation) return res({});
      navigator.geolocation.getCurrentPosition((p) => res({ latitude: p.coords.latitude, longitude: p.coords.longitude }), () => res({}), { timeout: 5000 });
    });
  const status = useAction(async (s: string) => api(`/deliveries/${id}/status`, { method: 'POST', json: { status: s, note: note || undefined, ...(await position()) } }), ['/deliveries']);
  const proof = useAction(async () => api(`/deliveries/${id}/proof-of-delivery`, { method: 'POST', json: { method: 'OTP', otp, ...(await position()) } }), ['/deliveries'], onBack);
  if (q.isLoading) return <Spinner />;
  const dl = q.data;
  const a = dl.order.addressSnapshot;
  const next: Record<string, string> = { ASSIGNED: 'ACCEPTED', ACCEPTED: 'PICKED_UP' };
  return (
    <MobileFrame title={dl.order.orderNumber}>
      <Button variant="ghost" onClick={onBack}>← Back</Button>
      <div className="rounded-lg border border-border bg-panel p-4">
        <StatusBadge status={dl.status} />
        <p className="mt-2 text-lg font-semibold">{a.line1}</p>
        <p className="text-sm text-subtle">{a.line2} {a.city} {a.postalCode}</p>
        {dl.order.paymentMethod === 'COD' && <p className="mt-2 rounded bg-warn/10 p-2 font-semibold text-warn">Collect cash: {inr(dl.order.total)}</p>}
        <a className="mt-3 block text-center text-sm text-brand underline" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(`${a.line1} ${a.city} ${a.postalCode}`)}`}>Open in maps</a>
      </div>
      <FormError error={status.error || proof.error} />
      {next[dl.status] && <Button size="lg" className="w-full" loading={status.isPending} onClick={() => status.mutate(next[dl.status])}>{next[dl.status] === 'ACCEPTED' ? 'Accept delivery' : 'Picked up from store'}</Button>}
      {['PICKED_UP', 'OUT_FOR_DELIVERY'].includes(dl.status) && (
        <div className="space-y-2 rounded-lg border border-border bg-panel p-4">
          <p className="text-sm font-medium">Ask the customer for their 4-digit delivery code</p>
          <Input inputMode="numeric" maxLength={4} className="h-14 text-center text-2xl tracking-[0.5em]" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
          <Button size="lg" className="w-full" disabled={otp.length !== 4} loading={proof.isPending} onClick={() => proof.mutate(undefined)}>Confirm delivery</Button>
        </div>
      )}
      {['ACCEPTED', 'PICKED_UP', 'OUT_FOR_DELIVERY'].includes(dl.status) && (
        <div className="space-y-2">
          <Input placeholder="Reason if delivery failed" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button variant="danger" className="w-full" disabled={!note} onClick={() => status.mutate('FAILED')}>Report failed delivery</Button>
        </div>
      )}
    </MobileFrame>
  );
}
