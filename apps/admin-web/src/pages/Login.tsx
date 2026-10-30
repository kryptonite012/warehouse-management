import { Activity } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Field, FormError, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { Me, useAuth } from '@/stores/auth';

export default function Login() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const { setTokens, setMe } = useAuth();
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await api('/auth/login', { method: 'POST', json: { identifier, password } });
      setTokens(t.accessToken, t.refreshToken);
      const me = await api<Me>('/auth/me');
      setMe(me);
      const isFieldRole = !me.isSuperAdmin && me.roles.every((r) => ['PICKER', 'PACKER', 'DELIVERY_PARTNER'].includes(r.code));
      navigate(isFieldRole ? (me.roles.some((r) => r.code === 'DELIVERY_PARTNER') ? '/rider' : '/ops/pick') : '/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-panel p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-brand text-brand-fg"><Activity className="h-4 w-4" /></div>
          <div>
            <h1 className="font-semibold">QuickStore Console</h1>
            <p className="text-xs text-subtle">Sign in with your work email or phone</p>
          </div>
        </div>
        <Field label="Email or phone">
          <Input autoFocus autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <FormError error={error} />
        <Button type="submit" className="w-full" loading={busy}>Sign in</Button>
      </form>
    </div>
  );
}
