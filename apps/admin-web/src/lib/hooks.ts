import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, Page, qs } from './api';

/** Paginated list with search + filters, kept in component state. */
export function useList<T>(path: string, initial: Record<string, unknown> = {}, enabled = true) {
  const [params, setParams] = useState<Record<string, unknown>>({ page: 1, pageSize: 25, ...initial });
  const query = useQuery({
    queryKey: [path, params],
    queryFn: () => api<Page<T>>(`${path}${qs(params)}`),
    placeholderData: keepPreviousData,
    enabled,
  });
  const set = (patch: Record<string, unknown>) => setParams((p) => ({ ...p, page: 1, ...patch }));
  return { ...query, params, set, setPage: (page: number) => setParams((p) => ({ ...p, page })) };
}

export function useGet<T>(key: unknown[], path: string | null) {
  return useQuery({ queryKey: key, queryFn: () => api<T>(path!), enabled: !!path });
}

/** Mutation that invalidates the given query prefixes on success. */
export function useAction<TBody = unknown, TRes = any>(fn: (body: TBody) => Promise<TRes>, invalidate: string[] = [], onSuccess?: (r: TRes) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      invalidate.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      onSuccess?.(r);
    },
  });
}

export function useSites(type?: string) {
  return useQuery({
    queryKey: ['/warehouses', 'all', type],
    queryFn: () => api<Page<any>>(`/warehouses${qs({ pageSize: 200, type })}`),
    staleTime: 60_000,
  });
}
