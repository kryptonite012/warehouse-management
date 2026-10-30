import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { AuthContext, canAccessWarehouse } from '../../common/auth-context';
import { Conflict, DomainError, Forbidden, NotFound } from '../../common/errors';
import { pageArgs, toPage } from '../../common/pagination';
import { ALL_PERMISSIONS } from '../../common/permissions';
import { PrismaService } from '../../common/prisma.service';
import { hashPassword } from '../auth/password';
import { CreateUserDto, ScopeDto, UpdateUserDto, UpsertRoleDto, UserListQuery } from './users.dto';

const PUBLIC_USER = {
  id: true, email: true, phone: true, fullName: true, status: true, isSuperAdmin: true, lastLoginAt: true,
  version: true, createdAt: true, updatedAt: true,
  roles: { select: { role: { select: { code: true, name: true } } } },
  scopes: { select: { scopeType: true, scopeId: true } },
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(actor: AuthContext, q: UserListQuery) {
    const where: Prisma.UserWhereInput = {
      organizationId: actor.organizationId,
      deletedAt: null,
      status: q.status as any,
      roles: q.role ? { some: { role: { code: q.role } } } : undefined,
      scopes: q.warehouseId ? { some: { scopeType: 'WAREHOUSE', scopeId: q.warehouseId } } : undefined,
      OR: q.search
        ? [
            { fullName: { contains: q.search, mode: 'insensitive' } },
            { email: { contains: q.search, mode: 'insensitive' } },
            { phone: { contains: q.search } },
          ]
        : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({ where, select: PUBLIC_USER, ...pageArgs(q, ['fullName', 'createdAt', 'lastLoginAt'], 'createdAt') }),
      this.prisma.user.count({ where }),
    ]);
    return toPage(rows.map(this.shape), total, q);
  }

  async get(actor: AuthContext, id: string) {
    const u = await this.prisma.user.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null }, select: PUBLIC_USER });
    if (!u) throw NotFound('User', id);
    return this.shape(u);
  }

  async create(actor: AuthContext, dto: CreateUserDto) {
    if (!dto.email && !dto.phone) throw new DomainError('VALIDATION_FAILED', 'Either email or phone is required', 400);
    const roles = await this.resolveRoles(actor, dto.roles);
    this.assertScopesGrantable(actor, dto.scopes);
    const passwordHash = await hashPassword(dto.password);

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          organizationId: actor.organizationId,
          fullName: dto.fullName,
          email: dto.email?.toLowerCase(),
          phone: dto.phone,
          passwordHash,
          roles: { create: roles.map((r) => ({ roleId: r.id })) },
          scopes: { create: (dto.scopes ?? []).map((s) => ({ scopeType: s.scopeType, scopeId: s.scopeId })) },
        },
        select: PUBLIC_USER,
      });
      await this.audit.record({ actor, action: 'user.create', resourceType: 'user', resourceId: user.id, after: { roles: dto.roles, scopes: dto.scopes } }, tx);
      return this.shape(user);
    });
  }

  async update(actor: AuthContext, id: string, dto: UpdateUserDto) {
    const existing = await this.get(actor, id);
    if (id === actor.id && dto.status && dto.status !== 'ACTIVE') throw Forbidden('You cannot deactivate your own account');
    const roles = dto.roles ? await this.resolveRoles(actor, dto.roles) : undefined;
    this.assertScopesGrantable(actor, dto.scopes);

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: { id, version: dto.version },
        data: { fullName: dto.fullName, phone: dto.phone, status: dto.status, version: { increment: 1 } },
      });
      if (count === 0) {
        throw Conflict('STALE_VERSION', 'User was modified by someone else. Reload and retry.', { currentVersion: existing.version });
      }
      if (roles) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id })) });
      }
      if (dto.scopes) {
        await tx.userScope.deleteMany({ where: { userId: id } });
        await tx.userScope.createMany({ data: dto.scopes.map((s) => ({ userId: id, ...s })) });
      }
      if (dto.status && dto.status !== 'ACTIVE') {
        await tx.userSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await this.audit.record({ actor, action: 'user.update', resourceType: 'user', resourceId: id, before: existing, after: dto }, tx);
      const updated = await tx.user.findUniqueOrThrow({ where: { id }, select: PUBLIC_USER });
      return this.shape(updated);
    });
  }

  /** Soft delete: user rows are referenced by audit and inventory history. */
  async remove(actor: AuthContext, id: string) {
    if (id === actor.id) throw Forbidden('You cannot delete your own account');
    await this.get(actor, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { deletedAt: new Date(), status: 'DISABLED', email: null, phone: null } });
      await tx.userSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record({ actor, action: 'user.delete', resourceType: 'user', resourceId: id }, tx);
    });
  }

  // ---- roles ----

  listRoles(actor: AuthContext) {
    return this.prisma.role
      .findMany({
        where: { OR: [{ organizationId: actor.organizationId }, { organizationId: null }] },
        include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
        orderBy: { name: 'asc' },
      })
      .then((roles) =>
        roles.map((r) => ({
          id: r.id, code: r.code, name: r.name, description: r.description, isSystem: r.isSystem,
          userCount: r._count.users, permissions: r.permissions.map((p) => p.permission.code).sort(),
        })),
      );
  }

  listPermissions() {
    return this.prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { code: 'asc' }] });
  }

  async upsertRole(actor: AuthContext, dto: UpsertRoleDto) {
    const unknown = dto.permissions.filter((p) => !(ALL_PERMISSIONS as string[]).includes(p));
    if (unknown.length) throw new DomainError('UNKNOWN_PERMISSION', `Unknown permissions: ${unknown.join(', ')}`, 400);
    // Nobody can grant permissions they do not hold themselves.
    const escalation = dto.permissions.filter((p) => !actor.isSuperAdmin && !actor.permissions.has(p));
    if (escalation.length) throw Forbidden(`Cannot grant permissions you do not hold: ${escalation.join(', ')}`);

    const perms = await this.prisma.permission.findMany({ where: { code: { in: dto.permissions } } });
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.upsert({
        where: { organizationId_code: { organizationId: actor.organizationId, code: dto.code } },
        create: { organizationId: actor.organizationId, code: dto.code, name: dto.name, description: dto.description },
        update: { name: dto.name, description: dto.description },
      });
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
      await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
      await this.audit.record({ actor, action: 'role.upsert', resourceType: 'role', resourceId: role.id, after: dto }, tx);
      return { ...role, permissions: dto.permissions };
    });
  }

  private async resolveRoles(actor: AuthContext, codes: string[]) {
    const roles = await this.prisma.role.findMany({
      where: { code: { in: codes }, organizationId: actor.organizationId },
      include: { permissions: { include: { permission: true } } },
    });
    const missing = codes.filter((c) => !roles.some((r) => r.code === c));
    if (missing.length) throw new DomainError('UNKNOWN_ROLE', `Unknown roles: ${missing.join(', ')}`, 400);
    for (const r of roles) {
      const over = r.permissions.map((p) => p.permission.code).filter((p) => !actor.isSuperAdmin && !actor.permissions.has(p));
      if (over.length) throw Forbidden(`Role ${r.code} grants permissions you do not hold`);
    }
    return roles;
  }

  private assertScopesGrantable(actor: AuthContext, scopes?: ScopeDto[]) {
    if (!scopes || actor.isSuperAdmin || actor.warehouseIds === null) return;
    for (const s of scopes) {
      if (s.scopeType !== 'WAREHOUSE' || !canAccessWarehouse(actor, s.scopeId)) {
        throw Forbidden('You can only assign users to warehouses within your own scope');
      }
    }
  }

  private shape = (u: any) => ({ ...u, roles: u.roles.map((r: any) => r.role) });
}
