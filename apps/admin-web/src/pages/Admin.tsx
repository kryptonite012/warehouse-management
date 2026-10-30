import { useState } from 'react';
import { Badge, Button, Card, DataTable, Empty, ErrorState, Field, FormError, Input, Modal, PageHeader, Pager, Select, Spinner, StatusBadge } from '@/components/ui';
import { api } from '@/lib/api';
import { dt, title } from '@/lib/format';
import { useAction, useGet, useList, useSites } from '@/lib/hooks';
import { useCan } from '@/stores/auth';

export function Employees() {
  const can = useCan();
  const list = useList<any>('/users');
  const roles = useGet<any[]>(['/roles'], '/roles');
  const [edit, setEdit] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Employees & roles" subtitle="Roles are configurable; users can be scoped to regions or specific sites"
        actions={can('users.manage') && <Button onClick={() => setCreating(true)}>Add employee</Button>} />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <div className="mb-3 flex gap-2">
            <Input placeholder="Search name, email, phone" className="max-w-xs" onChange={(e) => list.set({ search: e.target.value })} />
            <Select onChange={(e) => list.set({ role: e.target.value || undefined })} aria-label="Role"><option value="">All roles</option>{roles.data?.map((r) => <option key={r.id} value={r.code}>{r.name}</option>)}</Select>
          </div>
          {list.isLoading ? <Spinner /> : list.error ? <ErrorState error={list.error} /> : !list.data?.data.length ? <Empty message="No employees." /> : (
            <>
              <DataTable rows={list.data.data} rowKey={(u) => u.id} onRowClick={can('users.manage') ? setEdit : undefined} columns={[
                { key: 'n', header: 'Name', render: (u) => <div><p>{u.fullName}</p><p className="text-xs text-subtle">{u.email ?? u.phone}</p></div> },
                { key: 'r', header: 'Roles', render: (u) => u.roles.map((r: any) => <Badge key={r.code}>{r.name}</Badge>) },
                { key: 's', header: 'Scope', render: (u) => (u.scopes.length ? `${u.scopes.length} site/region` : 'Organization') },
                { key: 'l', header: 'Last login', render: (u) => dt(u.lastLoginAt) },
                { key: 'st', header: 'Status', render: (u) => <StatusBadge status={u.status} /> },
              ]} />
              <Pager {...list.data.meta} onPage={list.setPage} />
            </>
          )}
        </Card>
        <Card title="Roles">
          {roles.data?.map((r) => (
            <details key={r.id} className="border-b border-border py-2 last:border-0">
              <summary className="cursor-pointer text-sm">{r.name} <span className="text-xs text-subtle">· {r.userCount} users · {r.permissions.length} permissions</span></summary>
              <div className="mt-2 flex flex-wrap gap-1">{r.permissions.map((p: string) => <Badge key={p}>{p}</Badge>)}</div>
            </details>
          ))}
        </Card>
      </div>
      {(creating || edit) && <UserModal user={edit} roles={roles.data ?? []} onClose={() => { setCreating(false); setEdit(null); }} />}
    </>
  );
}

function UserModal({ user, roles, onClose }: { user: any; roles: any[]; onClose: () => void }) {
  const sites = useSites();
  const [f, setF] = useState<any>(user ? { fullName: user.fullName, status: user.status, roles: user.roles.map((r: any) => r.code), sites: user.scopes.filter((s: any) => s.scopeType === 'WAREHOUSE').map((s: any) => s.scopeId) } : { roles: [], sites: [] });
  const save = useAction(() => {
    const scopes = f.sites.map((id: string) => ({ scopeType: 'WAREHOUSE', scopeId: id }));
    return user
      ? api(`/users/${user.id}`, { method: 'PATCH', json: { version: user.version, fullName: f.fullName, status: f.status, roles: f.roles, scopes } })
      : api('/users', { method: 'POST', json: { fullName: f.fullName, email: f.email || undefined, phone: f.phone || undefined, password: f.password, roles: f.roles, scopes } });
  }, ['/users', '/roles'], onClose);
  const toggle = (k: 'roles' | 'sites', v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x: string) => x !== v) : [...f[k], v] });
  return (
    <Modal open onClose={onClose} wide title={user ? `Edit ${user.fullName}` : 'Add employee'} footer={<Button loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name"><Input value={f.fullName ?? ''} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
        {user ? (
          <Field label="Status"><Select className="w-full" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{['ACTIVE', 'SUSPENDED', 'DISABLED'].map((s) => <option key={s}>{s}</option>)}</Select></Field>
        ) : (
          <>
            <Field label="Email"><Input type="email" onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Phone"><Input onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
            <Field label="Initial password" hint="10+ chars, upper, lower and a digit"><Input type="password" onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          </>
        )}
      </div>
      <p className="mb-1 mt-4 text-xs font-medium text-subtle">Roles</p>
      <div className="flex flex-wrap gap-2">{roles.map((r) => <label key={r.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.roles.includes(r.code)} onChange={() => toggle('roles', r.code)} />{r.name}</label>)}</div>
      <p className="mb-1 mt-4 text-xs font-medium text-subtle">Restrict to sites (none = whole organization)</p>
      <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">{sites.data?.data.map((s: any) => <label key={s.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.sites.includes(s.id)} onChange={() => toggle('sites', s.id)} />{s.code}</label>)}</div>
      <div className="mt-3"><FormError error={save.error} /></div>
    </Modal>
  );
}

export function Notifications() {
  const q = useGet<any[]>(['/notifications'], '/notifications');
  const read = useAction((id: string) => api(`/notifications/${id}/read`, { method: 'POST' }), ['/notifications']);
  return (
    <>
      <PageHeader title="Notifications" />
      <Card>
        {q.isLoading ? <Spinner /> : !q.data?.length ? <Empty message="You're all caught up." /> : (
          <ul className="divide-y divide-border">
            {q.data.map((n) => (
              <li key={n.id} className="flex items-start justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium">{!n.readAt && <span className="mr-2 inline-block h-2 w-2 rounded-full bg-brand" />}{n.title}</p>
                  <p className="text-xs text-subtle">{n.body} · {dt(n.createdAt)}</p>
                </div>
                <div className="flex items-center gap-2"><Badge>{title(n.category)}</Badge>{!n.readAt && <Button size="sm" variant="ghost" onClick={() => read.mutate(n.id)}>Mark read</Button>}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

export function AuditLogs() {
  const list = useList<any>('/audit-logs', { pageSize: 50 });
  const sec = useGet<any[]>(['/security-events'], '/security-events');
  return (
    <>
      <PageHeader title="Audit & security" subtitle="Append-only: audit rows cannot be edited or deleted, even by database administrators using the app role" />
      <Card title="Audit trail">
        <div className="mb-3 flex gap-2">
          <Input placeholder="Search action (e.g. inventory.)" className="max-w-xs" onChange={(e) => list.set({ search: e.target.value })} />
          <Select onChange={(e) => list.set({ outcome: e.target.value || undefined })} aria-label="Outcome"><option value="">All outcomes</option><option>SUCCESS</option><option>DENIED</option><option>FAILED</option></Select>
        </div>
        {list.isLoading ? <Spinner /> : !list.data?.data.length ? <Empty message="No entries." /> : (
          <>
            <DataTable rows={list.data.data} rowKey={(a) => a.id} columns={[
              { key: 't', header: 'Time', render: (a) => dt(a.createdAt) },
              { key: 'a', header: 'Action', render: (a) => <span className="font-mono text-xs">{a.action}</span> },
              { key: 'r', header: 'Resource', render: (a) => <span className="text-xs">{a.resourceType} {a.resourceId?.slice(0, 8)}</span> },
              { key: 'ac', header: 'Actor', render: (a) => <span className="text-xs">{a.actorType} {a.actorId?.slice(0, 8)}</span> },
              { key: 'o', header: 'Outcome', render: (a) => <StatusBadge status={a.outcome} /> },
              { key: 'ip', header: 'IP', render: (a) => <span className="text-xs text-subtle">{a.ipAddress}</span> },
            ]} />
            <Pager {...list.data.meta} onPage={list.setPage} />
          </>
        )}
      </Card>
      <Card title="Security events" className="mt-4">
        {!sec.data?.length ? <Empty message="No security events." /> : (
          <DataTable rows={sec.data} rowKey={(e) => e.id} columns={[
            { key: 't', header: 'Time', render: (e) => dt(e.created_at) },
            { key: 'e', header: 'Event', render: (e) => e.event_type },
            { key: 's', header: 'Severity', render: (e) => <Badge tone={e.severity === 'HIGH' ? 'bad' : 'warn'}>{e.severity}</Badge> },
            { key: 'd', header: 'Details', render: (e) => <span className="font-mono text-xs">{JSON.stringify(e.details)}</span> },
          ]} />
        )}
      </Card>
    </>
  );
}

export function Settings() {
  const q = useGet<any>(['/settings'], '/settings');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const save = useAction(() => api('/settings', { method: 'PUT', json: { key, value: JSON.parse(value) } }), ['/settings'], () => setValue(''));
  return (
    <>
      <PageHeader title="System settings" subtitle="Validated keys only; every change is audited with before/after values" />
      <Card>
        {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} /> : (
          <>
            <DataTable rows={q.data.editable.map((k: string) => ({ k, v: q.data.values[k] }))} rowKey={(r: any) => r.k} onRowClick={(r: any) => { setKey(r.k); setValue(r.v === undefined ? '' : JSON.stringify(r.v)); }} columns={[
              { key: 'k', header: 'Key', render: (r: any) => <span className="font-mono text-xs">{r.k}</span> },
              { key: 'v', header: 'Value', render: (r: any) => (r.v === undefined ? <span className="text-subtle">default</span> : <span className="font-mono text-xs">{JSON.stringify(r.v)}</span>) },
            ]} />
            {key && (
              <div className="mt-4 flex flex-wrap items-end gap-2">
                <Field label={`New JSON value for ${key}`}><Input className="w-96 font-mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder='e.g. {"PROCUREMENT_MANAGER": 200000}' /></Field>
                <Button loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>
              </div>
            )}
            <div className="mt-3"><FormError error={save.error} /></div>
          </>
        )}
      </Card>
    </>
  );
}

export function SyncStatus() {
  const status = useGet<any[]>(['/sync/status'], '/sync/status');
  const conflicts = useGet<any[]>(['/sync/conflicts'], '/sync/conflicts');
  const [device, setDevice] = useState<any>(null);
  const resolve = useAction(({ id, action }: { id: string; action: string }) => api(`/sync/conflicts/${id}/resolve`, { method: 'POST', json: { action, note: action === 'DISMISS' ? 'central state accepted' : 'retried by reviewer' } }), ['/sync/conflicts', '/sync/status']);
  return (
    <>
      <PageHeader title="Store sync" subtitle="Edge agents submit intents, not quantities; rejected intents land here for manual reconciliation" actions={<Button onClick={() => setDevice({})}>Register edge device</Button>} />
      <Card title="Dark store connectivity">
        {status.isLoading ? <Spinner /> : !status.data?.length ? <Empty message="No dark stores." /> : (
          <DataTable rows={status.data} rowKey={(s) => s.id} columns={[
            { key: 'c', header: 'Store', render: (s) => `${s.code} · ${s.name}` },
            { key: 'l', header: 'Last sync', render: (s) => dt(s.lastSyncAt) },
            { key: 'd', header: 'Devices', render: (s) => s.devices },
            { key: 'seen', header: 'Device seen', render: (s) => {
              const mins = s.lastDeviceSeenAt ? (Date.now() - new Date(s.lastDeviceSeenAt).getTime()) / 60000 : null;
              return mins === null ? <Badge>never</Badge> : mins < 2 ? <Badge tone="ok">online</Badge> : <Badge tone="warn">{Math.round(mins)} min ago</Badge>;
            } },
            { key: 'o', header: 'Ops 24h', render: (s) => s.opsLast24h, className: 'text-right' },
            { key: 'x', header: 'Open conflicts', render: (s) => (s.openConflicts ? <Badge tone="bad">{s.openConflicts}</Badge> : '0'), className: 'text-right' },
          ]} />
        )}
      </Card>
      <Card title="Conflicts awaiting review" className="mt-4">
        <FormError error={resolve.error} />
        {!conflicts.data?.length ? <Empty message="No open conflicts." /> : (
          <DataTable rows={conflicts.data} rowKey={(c) => c.id} columns={[
            { key: 't', header: 'Detected', render: (c) => dt(c.createdAt) },
            { key: 'ty', header: 'Type', render: (c) => <Badge tone="bad">{c.conflictType}</Badge> },
            { key: 'op', header: 'Operation', render: (c) => c.details.opType },
            { key: 'e', header: 'Reason', render: (c) => <span className="text-xs">{c.details.error}</span> },
            { key: 'x', header: '', render: (c) => (
              <div className="flex gap-1">
                <Button size="sm" variant="secondary" onClick={() => resolve.mutate({ id: c.id, action: 'RETRY' })}>Retry</Button>
                <Button size="sm" variant="ghost" onClick={() => resolve.mutate({ id: c.id, action: 'DISMISS' })}>Dismiss</Button>
              </div>
            ) },
          ]} />
        )}
      </Card>
      {device && <DeviceModal onClose={() => setDevice(null)} />}
    </>
  );
}

function DeviceModal({ onClose }: { onClose: () => void }) {
  const sites = useSites('DARK_STORE');
  const [f, setF] = useState<any>({ allowedOps: ['PICK_SCAN', 'DAMAGE_REPORT'] });
  const [token, setToken] = useState<string | null>(null);
  const go = useAction(() => api('/sync/devices', { method: 'POST', json: f }), ['/sync/status'], (r: any) => setToken(r.token));
  return (
    <Modal open onClose={onClose} title="Register edge device" footer={!token && <Button loading={go.isPending} onClick={() => go.mutate(undefined)}>Register</Button>}>
      {token ? (
        <div>
          <p className="mb-2 text-sm">Copy this token into the store agent's <code>EDGE_DEVICE_TOKEN</code>. It will not be shown again.</p>
          <code className="block break-all rounded bg-muted p-2 text-xs">{token}</code>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Store"><Select className="w-full" defaultValue="" onChange={(e) => setF({ ...f, warehouseId: e.target.value })}><option value="" disabled>Select…</option>{sites.data?.data.map((s: any) => <option key={s.id} value={s.id}>{s.code}</option>)}</Select></Field>
          <Field label="Device name"><Input onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <p className="text-xs font-medium text-subtle">Operations allowed while offline</p>
          {['PICK_SCAN', 'DAMAGE_REPORT', 'COUNT_SUBMIT', 'TRANSFER_RECEIVE'].map((op) => (
            <label key={op} className="mr-3 inline-flex items-center gap-1 text-sm"><input type="checkbox" checked={f.allowedOps.includes(op)} onChange={() => setF({ ...f, allowedOps: f.allowedOps.includes(op) ? f.allowedOps.filter((x: string) => x !== op) : [...f.allowedOps, op] })} />{title(op)}</label>
          ))}
          <FormError error={go.error} />
        </div>
      )}
    </Modal>
  );
}
