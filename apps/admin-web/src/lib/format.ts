export const inr = (v: number | string | null | undefined) =>
  v === null || v === undefined ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(v));
export const num = (v: number | string | null | undefined, digits = 0) =>
  v === null || v === undefined ? '—' : new Intl.NumberFormat('en-IN', { maximumFractionDigits: digits }).format(Number(v));
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
export const dt = (v: string | Date | null | undefined) => (v ? new Date(v).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const d = (v: string | Date | null | undefined) => (v ? new Date(v).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '—');
export const title = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
