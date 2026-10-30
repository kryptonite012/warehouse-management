import { Forbidden } from './errors';

export type ActorKind = 'employee' | 'customer' | 'edge-device' | 'system';

export interface AuthContext {
  kind: ActorKind;
  id: string;
  organizationId: string;
  isSuperAdmin: boolean;
  permissions: Set<string>;
  /** null = every warehouse in the organization; otherwise the explicit allow-list. */
  warehouseIds: string[] | null;
  sessionId?: string;
  ip?: string;
}

export function hasPermission(ctx: AuthContext, code: string): boolean {
  return ctx.isSuperAdmin || ctx.permissions.has(code);
}

export function canAccessWarehouse(ctx: AuthContext, warehouseId: string): boolean {
  return ctx.isSuperAdmin || ctx.warehouseIds === null || ctx.warehouseIds.includes(warehouseId);
}

export function assertWarehouseAccess(ctx: AuthContext, warehouseId: string) {
  if (!canAccessWarehouse(ctx, warehouseId)) {
    throw Forbidden('You are not assigned to this warehouse or store');
  }
}

/** Prisma `where` fragment restricting a warehouse_id column to the caller's scope. */
export function warehouseScopeFilter(ctx: AuthContext, field = 'warehouseId'): Record<string, unknown> {
  if (ctx.isSuperAdmin || ctx.warehouseIds === null) return {};
  return { [field]: { in: ctx.warehouseIds } };
}

export const SYSTEM_ACTOR = (organizationId: string): AuthContext => ({
  kind: 'system',
  id: '00000000-0000-0000-0000-000000000000',
  organizationId,
  isSuperAdmin: true,
  permissions: new Set(),
  warehouseIds: null,
});
