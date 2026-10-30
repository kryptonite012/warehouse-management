import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  theme: 'light' | 'dark';
  siteId: string | null; // currently selected warehouse / store context
  toggleTheme: () => void;
  setSite: (id: string | null) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      theme: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      siteId: null,
      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
      setSite: (siteId) => set({ siteId }),
    }),
    { name: 'qs-ui' },
  ),
);
