import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface State {
  token: string | null;
  postalCode: string | null;
  storeId: string | null;
  storeName: string | null;
  setToken: (t: string | null) => void;
  setLocation: (pin: string, storeId: string, storeName: string) => void;
  clearLocation: () => void;
}

export const useApp = create<State>()(
  persist(
    (set) => ({
      token: null,
      postalCode: null,
      storeId: null,
      storeName: null,
      setToken: (token) => set({ token }),
      setLocation: (postalCode, storeId, storeName) => set({ postalCode, storeId, storeName }),
      clearLocation: () => set({ postalCode: null, storeId: null, storeName: null }),
    }),
    { name: 'qs-customer' },
  ),
);

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const token = useApp.getState().token;
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(`/api/v1${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  if (res.status === 401 && token) useApp.getState().setToken(null);
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'ERROR', body?.error?.message ?? res.statusText);
  return body as T;
}

export const inr = (v: number | string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(v));
