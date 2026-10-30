import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronLeft, Clock, Home as HomeIcon, MapPin, Minus, Package, Plus, Search, ShoppingBag, User } from 'lucide-react';
import { FormEvent, ReactNode, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, inr, useApp } from './store';

// ------------------------------------------------------------------ shell

function Shell({ children, title, back }: { children: ReactNode; title?: string; back?: boolean }) {
  const { storeName, postalCode, token } = useApp();
  const navigate = useNavigate();
  const cart = useCart();
  const count = cart.data?.items.reduce((s: number, i: any) => s + i.quantity, 0) ?? 0;
  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col bg-white shadow-sm">
      <header className="sticky top-0 z-10 border-b bg-white px-4 py-3">
        {back ? (
          <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm font-medium"><ChevronLeft className="h-5 w-5" />{title}</button>
        ) : (
          <Link to="/location" className="block">
            <p className="text-lg font-extrabold text-brand">QuickStore</p>
            <p className="flex items-center gap-1 text-xs text-slate-500"><MapPin className="h-3 w-3" />{storeName ? `Delivering to ${postalCode} from ${storeName}` : 'Set your delivery location'}</p>
          </Link>
        )}
      </header>
      <main className="flex-1 p-4 pb-24">{children}</main>
      <nav className="fixed bottom-0 left-1/2 grid w-full max-w-lg -translate-x-1/2 grid-cols-4 border-t bg-white text-xs">
        <Link to="/" className="flex flex-col items-center gap-1 py-2"><HomeIcon className="h-5 w-5" />Home</Link>
        <Link to="/search" className="flex flex-col items-center gap-1 py-2"><Search className="h-5 w-5" />Search</Link>
        <Link to="/cart" className="relative flex flex-col items-center gap-1 py-2"><ShoppingBag className="h-5 w-5" />Cart{count > 0 && <span className="absolute right-6 top-1 rounded-full bg-brand px-1.5 text-[10px] font-bold text-white">{count}</span>}</Link>
        <Link to={token ? '/account' : '/login'} className="flex flex-col items-center gap-1 py-2"><User className="h-5 w-5" />Account</Link>
      </nav>
    </div>
  );
}

const Btn = ({ className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button {...p} className={clsx('rounded-lg bg-brand px-4 py-3 font-semibold text-white disabled:opacity-50', className)} />
);
const Field = (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={clsx('w-full rounded-lg border px-3 py-3', p.className)} />;
const Err = ({ e }: { e: unknown }) => (e ? <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">{(e as Error).message}</p> : null);

// ------------------------------------------------------------------ data

function useCart() {
  const { token, storeId } = useApp();
  return useQuery({ queryKey: ['cart', storeId], queryFn: () => api(`/storefront/cart${storeId ? `?storeId=${storeId}` : ''}`), enabled: !!token });
}

function useSetCart() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: ({ skuId, quantity }: { skuId: string; quantity: number }) => {
      if (!useApp.getState().token) {
        navigate('/login');
        return Promise.reject(new Error('Please sign in'));
      }
      return api('/storefront/cart/items', { method: 'PUT', json: { skuId, quantity } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cart'] }),
  });
}

// ------------------------------------------------------------------ screens

function LocationScreen() {
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const setLocation = useApp((s) => s.setLocation);
  const navigate = useNavigate();
  const check = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const r = await api(`/storefront/serviceability?postalCode=${pin}`);
    if (!r.serviceable) return setMsg('Sorry, we do not deliver to this PIN code yet.');
    setLocation(pin, r.stores[0].id, r.stores[0].name);
    navigate('/');
  };
  return (
    <Shell back title="Delivery location">
      <form onSubmit={check} className="space-y-3">
        <p className="text-sm text-slate-600">Enter your PIN code to see what's available at your nearest store.</p>
        <Field inputMode="numeric" pattern="[0-9]{6}" placeholder="6-digit PIN code" value={pin} onChange={(e) => setPin(e.target.value)} required />
        {msg && <p className="text-sm text-red-700">{msg}</p>}
        <Btn className="w-full">Check availability</Btn>
      </form>
    </Shell>
  );
}

function ProductCard({ p }: { p: any }) {
  const v = p.variants[0];
  const cart = useCart();
  const setCart = useSetCart();
  const qty = cart.data?.items.find((i: any) => i.skuId === v?.skuId)?.quantity ?? 0;
  if (!v) return null;
  return (
    <div className="flex flex-col rounded-xl border p-3">
      <Link to={`/p/${p.id}`} className="flex-1">
        <div className="mb-2 grid aspect-square place-items-center rounded-lg bg-slate-100">
          {p.image ? <img src={p.image} alt="" className="h-full w-full rounded-lg object-cover" /> : <Package className="h-10 w-10 text-slate-300" />}
        </div>
        <p className="line-clamp-2 text-sm font-medium">{p.name}</p>
        <p className="text-xs text-slate-500">{v.variantName ?? `${v.netQuantity} ${v.unit.toLowerCase()}`}</p>
      </Link>
      <div className="mt-2 flex items-center justify-between">
        <div>
          <p className="text-sm font-bold">{inr(v.sellingPrice)}</p>
          {v.mrp > v.sellingPrice && <p className="text-[11px] text-slate-400 line-through">{inr(v.mrp)}</p>}
        </div>
        {!v.inStock ? <span className="text-xs font-medium text-slate-400">Out of stock</span> : qty === 0 ? (
          <button className="rounded-md border border-brand px-3 py-1 text-sm font-semibold text-brand" onClick={() => setCart.mutate({ skuId: v.skuId, quantity: 1 })}>ADD</button>
        ) : (
          <div className="flex items-center gap-2 rounded-md bg-brand px-2 py-1 text-white">
            <button aria-label="Decrease" onClick={() => setCart.mutate({ skuId: v.skuId, quantity: qty - 1 })}><Minus className="h-4 w-4" /></button>
            <span className="text-sm font-bold">{qty}</span>
            <button aria-label="Increase" disabled={qty >= v.maxPerOrder} onClick={() => setCart.mutate({ skuId: v.skuId, quantity: qty + 1 })}><Plus className="h-4 w-4" /></button>
          </div>
        )}
      </div>
    </div>
  );
}

function Home() {
  const storeId = useApp((s) => s.storeId);
  const [cat, setCat] = useState<string | undefined>();
  const cats = useQuery({ queryKey: ['cats'], queryFn: () => api<any[]>('/storefront/categories') });
  const products = useQuery({ queryKey: ['products', storeId, cat], queryFn: () => api(`/storefront/stores/${storeId}/products?pageSize=60${cat ? `&categoryId=${cat}` : ''}`), enabled: !!storeId });
  if (!storeId) return <Navigate to="/location" />;
  return (
    <Shell>
      <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
        <button onClick={() => setCat(undefined)} className={clsx('whitespace-nowrap rounded-full border px-3 py-1 text-sm', !cat && 'border-brand bg-brand-soft font-semibold text-brand-dark')}>All</button>
        {cats.data?.filter((c) => !c.parentId).map((c) => (
          <button key={c.id} onClick={() => setCat(c.id)} className={clsx('whitespace-nowrap rounded-full border px-3 py-1 text-sm', cat === c.id && 'border-brand bg-brand-soft font-semibold text-brand-dark')}>{c.name}</button>
        ))}
      </div>
      {products.isLoading ? <p className="text-sm text-slate-500">Loading products…</p> : products.error ? <Err e={products.error} /> : (
        <div className="grid grid-cols-2 gap-3">{products.data.data.map((p: any) => <ProductCard key={p.id} p={p} />)}</div>
      )}
    </Shell>
  );
}

function SearchScreen() {
  const storeId = useApp((s) => s.storeId);
  const [q, setQ] = useState('');
  const res = useQuery({ queryKey: ['search', storeId, q], queryFn: () => api(`/storefront/stores/${storeId}/products?search=${encodeURIComponent(q)}`), enabled: !!storeId && q.length >= 2 });
  if (!storeId) return <Navigate to="/location" />;
  return (
    <Shell back title="Search">
      <Field autoFocus placeholder="Search milk, chips, bread…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-4 grid grid-cols-2 gap-3">{res.data?.data.map((p: any) => <ProductCard key={p.id} p={p} />)}</div>
      {res.data && !res.data.data.length && <p className="mt-6 text-center text-sm text-slate-500">No products match "{q}".</p>}
    </Shell>
  );
}

function ProductScreen() {
  const { id } = useParams();
  const storeId = useApp((s) => s.storeId);
  const q = useQuery({ queryKey: ['product', storeId, id], queryFn: () => api(`/storefront/stores/${storeId}/products/${id}`), enabled: !!storeId });
  if (!storeId) return <Navigate to="/location" />;
  if (!q.data) return <Shell back title="Product"><Err e={q.error} /></Shell>;
  const p = q.data;
  return (
    <Shell back title={p.category.name}>
      <div className="mb-3 grid aspect-video place-items-center rounded-xl bg-slate-100">{p.image ? <img src={p.image} alt="" className="h-full object-contain" /> : <Package className="h-16 w-16 text-slate-300" />}</div>
      <h1 className="text-xl font-bold">{p.name}</h1>
      {p.brand && <p className="text-sm text-slate-500">{p.brand}</p>}
      <div className="mt-3 w-1/2"><ProductCard p={p} /></div>
      {p.description && <p className="mt-4 text-sm text-slate-700">{p.description}</p>}
      {p.substitutes.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 font-semibold">{p.inStock ? 'You might also like' : 'Available alternatives'}</h2>
          <div className="grid grid-cols-2 gap-3">{p.substitutes.map((s: any) => <ProductCard key={s.id} p={s} />)}</div>
        </>
      )}
    </Shell>
  );
}

function CartScreen() {
  const { token } = useApp();
  const cart = useCart();
  const navigate = useNavigate();
  if (!token) return <Navigate to="/login" />;
  const items = cart.data?.items ?? [];
  const short = items.filter((i: any) => i.available !== null && i.available < i.quantity);
  return (
    <Shell back title="Cart">
      {!items.length ? <p className="py-12 text-center text-slate-500">Your cart is empty.</p> : (
        <>
          <ul className="divide-y">
            {items.map((i: any) => (
              <li key={i.skuId} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm font-medium">{i.name}</p>
                  <p className="text-xs text-slate-500">{i.quantity} × {inr(i.unitPrice)}</p>
                  {i.available !== null && i.available < i.quantity && <p className="text-xs text-red-600">Only {i.available} left</p>}
                </div>
                <p className="font-semibold">{inr(i.lineTotal)}</p>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-between border-t pt-3 font-semibold"><span>Item total</span><span>{inr(cart.data.subtotal)}</span></div>
          <Btn className="mt-4 w-full" disabled={short.length > 0} onClick={() => navigate('/checkout')}>Proceed to checkout</Btn>
        </>
      )}
    </Shell>
  );
}

function Checkout() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const profile = useQuery({ queryKey: ['profile'], queryFn: () => api('/customers/profile') });
  const payments = useQuery({ queryKey: ['paycfg'], queryFn: () => api('/payments/config') });
  const [addressId, setAddressId] = useState<string>();
  const [method, setMethod] = useState('COD');
  const [coupon, setCoupon] = useState('');
  const [key] = useState(() => crypto.randomUUID()); // stable across retries of this checkout
  const place = useMutation({
    mutationFn: () => api('/orders', { method: 'POST', json: { addressId: addressId ?? profile.data.addresses.find((a: any) => a.isDefault)?.id, fromCart: true, paymentMethod: method, promotionCode: coupon || undefined, idempotencyKey: key } }),
    onSuccess: (o) => {
      qc.invalidateQueries({ queryKey: ['cart'] });
      navigate(`/orders/${o.id}`, { replace: true });
    },
  });
  const online = payments.data?.onlinePayments.status === 'CONFIGURED';
  if (!profile.data) return <Shell back title="Checkout"><Err e={profile.error} /></Shell>;
  return (
    <Shell back title="Checkout">
      <h2 className="mb-2 font-semibold">Deliver to</h2>
      {!profile.data.addresses.length ? <AddressForm /> : profile.data.addresses.map((a: any) => (
        <label key={a.id} className="mb-2 flex gap-2 rounded-lg border p-3 text-sm">
          <input type="radio" name="addr" defaultChecked={a.isDefault} onChange={() => setAddressId(a.id)} />
          <span><b>{a.label}</b> · {a.line1}, {a.city} {a.postalCode}</span>
        </label>
      ))}
      <h2 className="mb-2 mt-5 font-semibold">Payment</h2>
      {['UPI', 'CARD', 'NET_BANKING', 'WALLET'].map((m) => (
        <label key={m} className={clsx('mb-2 flex items-center justify-between rounded-lg border p-3 text-sm', !online && 'opacity-50')}>
          <span><input type="radio" name="pay" disabled={!online} checked={method === m} onChange={() => setMethod(m)} /> {m.replace('_', ' ')}</span>
          {!online && <span className="text-xs text-slate-500">Not available</span>}
        </label>
      ))}
      {payments.data?.cashOnDelivery === 'ENABLED' && (
        <label className="mb-2 flex items-center gap-2 rounded-lg border p-3 text-sm"><input type="radio" name="pay" checked={method === 'COD'} onChange={() => setMethod('COD')} /> Cash on delivery</label>
      )}
      <Field className="mt-3" placeholder="Coupon code (optional)" value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} />
      <div className="mt-3"><Err e={place.error} /></div>
      <Btn className="mt-4 w-full" disabled={place.isPending} onClick={() => place.mutate()}>{place.isPending ? 'Placing order…' : 'Place order'}</Btn>
      <p className="mt-2 text-center text-xs text-slate-500">Prices and stock are confirmed by the store when you place the order.</p>
    </Shell>
  );
}

function AddressForm({ onDone }: { onDone?: () => void }) {
  const qc = useQueryClient();
  const postalCode = useApp((s) => s.postalCode) ?? '';
  const [f, setF] = useState<any>({ label: 'Home', city: 'Bengaluru', state: 'KA', postalCode });
  const save = useMutation({ mutationFn: () => api('/customers/addresses', { method: 'POST', json: f }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['profile'] }); onDone?.(); } });
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <Field placeholder="House / street" onChange={(e) => setF({ ...f, line1: e.target.value })} />
      <Field placeholder="Landmark (optional)" onChange={(e) => setF({ ...f, line2: e.target.value || undefined })} />
      <div className="grid grid-cols-2 gap-2">
        <Field placeholder="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
        <Field placeholder="PIN" value={f.postalCode} onChange={(e) => setF({ ...f, postalCode: e.target.value })} />
      </div>
      <Err e={save.error} />
      <Btn className="w-full" onClick={() => save.mutate()}>Save address</Btn>
    </div>
  );
}

function OrderScreen() {
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['order', id], queryFn: () => api(`/orders/${id}`), refetchInterval: 10_000 });
  const cancel = useMutation({ mutationFn: () => api(`/orders/${id}/cancel`, { method: 'POST', json: { reason: 'cancelled by customer' } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['order', id] }) });
  const ret = useMutation({ mutationFn: () => api(`/orders/${id}/return-request`, { method: 'POST', json: { reason: 'requested by customer' } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['order', id] }) });
  if (!q.data) return <Shell back title="Order"><Err e={q.error} /></Shell>;
  const o = q.data;
  const steps = ['ACCEPTED', 'PICKING', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED'];
  const reached = new Set(o.statusHistory.map((h: any) => h.toStatus));
  return (
    <Shell back title={o.orderNumber}>
      <div className="rounded-xl bg-brand-soft p-4">
        <p className="text-xs uppercase tracking-wide text-brand-dark">Status</p>
        <p className="text-xl font-bold">{o.status.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c: string) => c.toUpperCase())}</p>
        {o.deliveryOtp && <p className="mt-2 text-sm">Share this code with your rider: <b className="text-2xl tracking-widest">{o.deliveryOtp}</b></p>}
        <p className="mt-1 flex items-center gap-1 text-xs text-slate-600"><Clock className="h-3 w-3" />Live ETA is shown only when a routing provider is configured.</p>
      </div>
      <ol className="my-4 flex justify-between text-[11px]">
        {steps.map((s) => (
          <li key={s} className="flex flex-1 flex-col items-center gap-1 text-center">
            <span className={clsx('h-3 w-3 rounded-full', reached.has(s) ? 'bg-brand' : 'bg-slate-200')} />
            {s.replace(/_/g, ' ').toLowerCase()}
          </li>
        ))}
      </ol>
      {o.delivery && <p className="text-sm">Rider: {o.delivery.rider.fullName} ({o.delivery.rider.vehicleType.replace('_', ' ').toLowerCase()})</p>}
      <ul className="mt-4 divide-y text-sm">{o.items.map((i: any) => <li key={i.id} className="flex justify-between py-2"><span>{i.quantity} × {i.productName}</span><span>{inr(i.lineTotal)}</span></li>)}</ul>
      <div className="mt-2 space-y-1 border-t pt-2 text-sm">
        <p className="flex justify-between"><span>Delivery fee</span><span>{inr(o.deliveryFee)}</span></p>
        {Number(o.discountTotal) > 0 && <p className="flex justify-between text-brand"><span>Discount</span><span>−{inr(o.discountTotal)}</span></p>}
        <p className="flex justify-between font-bold"><span>Total ({o.paymentMethod})</span><span>{inr(o.total)}</span></p>
      </div>
      <Err e={cancel.error || ret.error} />
      {['CREATED', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'ACCEPTED', 'INVENTORY_RESERVED'].includes(o.status) && (
        <button className="mt-4 w-full rounded-lg border border-red-300 py-3 text-sm font-medium text-red-700" onClick={() => cancel.mutate()}>Cancel order</button>
      )}
      {o.status === 'DELIVERED' && <button className="mt-4 w-full rounded-lg border py-3 text-sm font-medium" onClick={() => ret.mutate()}>Request return</button>}
      <Link to="/support" className="mt-3 block text-center text-sm text-brand underline">Need help with this order?</Link>
    </Shell>
  );
}

function Account() {
  const { token, setToken } = useApp();
  const profile = useQuery({ queryKey: ['profile'], queryFn: () => api('/customers/profile'), enabled: !!token });
  const orders = useQuery({ queryKey: ['orders'], queryFn: () => api('/orders?pageSize=20'), enabled: !!token });
  const [adding, setAdding] = useState(false);
  if (!token) return <Navigate to="/login" />;
  return (
    <Shell back title="Account">
      <p className="text-lg font-bold">{profile.data?.fullName}</p>
      <p className="text-sm text-slate-500">{profile.data?.phone}</p>
      <h2 className="mb-2 mt-5 font-semibold">Addresses</h2>
      {profile.data?.addresses.map((a: any) => <p key={a.id} className="mb-1 text-sm">{a.label}: {a.line1}, {a.postalCode}{a.isDefault && ' (default)'}</p>)}
      {adding ? <AddressForm onDone={() => setAdding(false)} /> : <button className="text-sm text-brand" onClick={() => setAdding(true)}>+ Add address</button>}
      <h2 className="mb-2 mt-5 font-semibold">Orders</h2>
      {orders.data?.data.map((o: any) => (
        <Link key={o.id} to={`/orders/${o.id}`} className="mb-2 flex justify-between rounded-lg border p-3 text-sm">
          <span>{o.orderNumber}<br /><span className="text-xs text-slate-500">{new Date(o.placedAt).toLocaleString('en-IN')}</span></span>
          <span className="text-right">{inr(o.total)}<br /><span className="text-xs">{o.status.replace(/_/g, ' ').toLowerCase()}</span></span>
        </Link>
      ))}
      <button className="mt-6 w-full rounded-lg border py-3 text-sm" onClick={() => setToken(null)}>Sign out</button>
    </Shell>
  );
}

function Login({ register }: { register?: boolean }) {
  const [f, setF] = useState<any>({});
  const [err, setErr] = useState<unknown>(null);
  const setToken = useApp((s) => s.setToken);
  const navigate = useNavigate();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const r = register
        ? await api('/customers/register', { method: 'POST', json: { fullName: f.name, phone: f.phone, email: f.email || undefined, password: f.password } })
        : await api('/customers/login', { method: 'POST', json: { identifier: f.phone, password: f.password } });
      setToken(r.accessToken);
      navigate('/');
    } catch (x) {
      setErr(x instanceof ApiError && x.status === 400 && register ? new Error('Use a 10-digit phone and a password with 10+ characters including upper/lower case and a digit.') : x);
    }
  };
  return (
    <Shell back title={register ? 'Create account' : 'Sign in'}>
      <form onSubmit={submit} className="space-y-3">
        {register && <Field placeholder="Full name" required onChange={(e) => setF({ ...f, name: e.target.value })} />}
        <Field placeholder="Phone number" inputMode="tel" required onChange={(e) => setF({ ...f, phone: e.target.value })} />
        {register && <Field placeholder="Email (optional)" type="email" onChange={(e) => setF({ ...f, email: e.target.value })} />}
        <Field placeholder="Password" type="password" required onChange={(e) => setF({ ...f, password: e.target.value })} />
        <Err e={err} />
        <Btn className="w-full">{register ? 'Create account' : 'Sign in'}</Btn>
        <Link className="block text-center text-sm text-brand" to={register ? '/login' : '/register'}>{register ? 'Already have an account? Sign in' : 'New here? Create an account'}</Link>
      </form>
    </Shell>
  );
}

function Support() {
  return (
    <Shell back title="Support">
      <p className="text-sm text-slate-700">For help with an order, open the order and use cancel or return where available. For anything else our support team can see your order history once you share your order number.</p>
    </Shell>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/location" element={<LocationScreen />} />
      <Route path="/search" element={<SearchScreen />} />
      <Route path="/p/:id" element={<ProductScreen />} />
      <Route path="/cart" element={<CartScreen />} />
      <Route path="/checkout" element={<Checkout />} />
      <Route path="/orders/:id" element={<OrderScreen />} />
      <Route path="/account" element={<Account />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Login register />} />
      <Route path="/support" element={<Support />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}
