import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Me {
  id: string;
  fullName: string;
  email: string | null;
  isSuperAdmin: boolean;
  roles: { code: string; name: string }[];
  permissions: string[];
  warehouseIds: string[] | null;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  me: Me | null;
  setTokens: (a: string, r: string) => void;
  setMe: (m: Me) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      me: null,
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
      setMe: (me) => set({ me }),
      logout: () => set({ accessToken: null, refreshToken: null, me: null }),
    }),
    // Session storage: tokens do not outlive the browser tab.
    { name: 'qs-auth', storage: { getItem: (k) => JSON.parse(sessionStorage.getItem(k) ?? 'null'), setItem: (k, v) => sessionStorage.setItem(k, JSON.stringify(v)), removeItem: (k) => sessionStorage.removeItem(k) } },
  ),
);

export function useCan() {
  const me = useAuth((s) => s.me);
  return (...perms: string[]) => !!me && (me.isSuperAdmin || perms.every((p) => me.permissions.includes(p)));
}
