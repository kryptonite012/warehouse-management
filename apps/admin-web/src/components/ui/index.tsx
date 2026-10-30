import clsx from 'clsx';
import { AlertTriangle, Inbox, Loader2, X } from 'lucide-react';
import { ButtonHTMLAttributes, forwardRef, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, useEffect } from 'react';
import { ApiError } from '@/lib/api';
import { title } from '@/lib/format';

export const cn = clsx;

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; size?: 'sm' | 'md' | 'lg' }>(
  ({ variant = 'primary', loading, size = 'md', className, children, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' && 'h-8 px-3 text-xs',
        size === 'md' && 'h-9 px-4 text-sm',
        size === 'lg' && 'h-14 px-6 text-base',
        variant === 'primary' && 'bg-brand text-brand-fg hover:opacity-90',
        variant === 'secondary' && 'border border-border bg-panel hover:bg-muted',
        variant === 'ghost' && 'hover:bg-muted',
        variant === 'danger' && 'bg-bad text-white hover:opacity-90',
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  ),
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => (
  <input ref={ref} className={cn('h-9 w-full rounded-md border border-border bg-panel px-3 text-sm placeholder:text-subtle', className)} {...rest} />
));

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...rest }, ref) => (
  <select ref={ref} className={cn('h-9 rounded-md border border-border bg-panel px-2 text-sm', className)} {...rest}>
    {children}
  </select>
));

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-subtle">{label}</span>
      {children}
      {error ? <span className="text-xs text-bad">{error}</span> : hint ? <span className="text-xs text-subtle">{hint}</span> : null}
    </label>
  );
}

export function Card({ title: t, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-lg border border-border bg-panel', className)}>
      {(t || actions) && (
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{t}</h2>
          <div className="flex gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const TONE: Record<string, string> = {
  ok: 'bg-ok/10 text-ok', warn: 'bg-warn/10 text-warn', bad: 'bg-bad/10 text-bad', neutral: 'bg-muted text-subtle', brand: 'bg-brand/10 text-brand',
};
const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'ok', DELIVERED: 'ok', COMPLETED: 'ok', APPROVED: 'ok', RECEIVED: 'ok', CAPTURED: 'ok', APPLIED: 'ok', AVAILABLE: 'ok', REFUNDED: 'ok', COD_COLLECTED: 'ok',
  PENDING: 'warn', PENDING_APPROVAL: 'warn', PAYMENT_PENDING: 'warn', PARTIALLY_RECEIVED: 'warn', PARTIALLY_FULFILLED: 'warn', INSPECTING: 'warn', OPEN: 'warn', REFUND_PENDING: 'warn', IN_PROGRESS: 'brand', PICKING: 'brand', PACKING: 'brand', OUT_FOR_DELIVERY: 'brand', RIDER_ASSIGNED: 'brand', ON_DELIVERY: 'brand',
  CANCELLED: 'bad', FAILED: 'bad', REJECTED: 'bad', PAYMENT_FAILED: 'bad', CONFLICT: 'bad', SUSPENDED: 'bad', DENIED: 'bad', EXPIRED: 'bad',
};
export function Badge({ children, tone }: { children: ReactNode; tone?: keyof typeof TONE }) {
  return <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide', TONE[tone ?? 'neutral'])}>{children}</span>;
}
export const StatusBadge = ({ status }: { status: string }) => <Badge tone={(STATUS_TONE[status] as any) ?? 'neutral'}>{title(status)}</Badge>;

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-subtle">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}…
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error as ApiError;
  return (
    <div role="alert" className="flex flex-col items-center gap-2 py-10 text-center">
      <AlertTriangle className="h-6 w-6 text-bad" />
      <p className="text-sm font-medium">{e?.status === 403 ? 'You do not have access to this' : 'Something went wrong'}</p>
      <p className="max-w-md text-xs text-subtle">{e?.message ?? String(error)}</p>
      {onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function Empty({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-subtle">
      <Inbox className="h-6 w-6" />
      <p>{message}</p>
      {action}
    </div>
  );
}

export function PageHeader({ title: t, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-subtle">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="rounded-lg border border-border bg-panel p-4">
      <p className="text-xs font-medium text-subtle">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold tabular-nums', tone && { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' }[tone])}>{value}</p>
      {hint && <p className="mt-1 text-xs text-subtle">{hint}</p>}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
}

export function DataTable<T>({ rows, columns, onRowClick, rowKey }: { rows: T[]; columns: Column<T>[]; onRowClick?: (r: T) => void; rowKey: (r: T) => string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-subtle">
            {columns.map((c) => (
              <th key={c.key} className={cn('whitespace-nowrap px-3 py-2 font-medium', c.className)}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cn('border-b border-border/60 last:border-0', onRowClick && 'cursor-pointer hover:bg-muted/60')}>
              {columns.map((c) => (
                <td key={c.key} className={cn('px-3 py-2 align-middle', c.className)}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between pt-3 text-xs text-subtle">
      <span>{total} records</span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <span>Page {page} of {Math.max(totalPages, 1)}</span>
        <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}

export function Modal({ open, onClose, title: t, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh]" onMouseDown={onClose}>
      <div role="dialog" aria-modal aria-label={t} className={cn('w-full rounded-lg border border-border bg-panel shadow-xl', wide ? 'max-w-3xl' : 'max-w-lg')} onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{t}</h2>
          <button aria-label="Close" onClick={onClose} className="rounded p-1 hover:bg-muted"><X className="h-4 w-4" /></button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-border px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  const details = Array.isArray(e.details) ? (e.details as string[]) : null;
  return (
    <div role="alert" className="rounded-md border border-bad/30 bg-bad/5 p-3 text-xs text-bad">
      <p className="font-medium">{e.message}</p>
      {details && <ul className="mt-1 list-disc pl-4">{details.map((d) => <li key={String(d)}>{typeof d === 'string' ? d : JSON.stringify(d)}</li>)}</ul>}
    </div>
  );
}
