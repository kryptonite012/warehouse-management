import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ActorKind, AuthContext } from './auth-context';
import { PrismaService } from './prisma.service';

/** Resolves the live permissions and warehouse scope of an actor from the database. */
@Injectable()
export class ActorService {
  constructor(private readonly prisma: PrismaService) {}

  async load(kind: ActorKind, id: string, org: string, sid?: string): Promise<AuthContext> {
    if (kind === 'customer') {
      const c = await this.prisma.customer.findUnique({ where: { id }, select: { status: true } });
      if (!c || c.status !== 'ACTIVE') throw new UnauthorizedException('Account is not active');
      return { kind, id, organizationId: org, isSuperAdmin: false, permissions: new Set(), warehouseIds: [] };
    }

    if (sid) {
      const session = await this.prisma.userSession.findUnique({ where: { id: sid }, select: { revokedAt: true } });
      if (!session || session.revokedAt) throw new UnauthorizedException('Session has been revoked');
    }

    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
        scopes: true,
      },
    });
    if (!user || user.status !== 'ACTIVE' || user.deletedAt) throw new UnauthorizedException('Account is not active');

    const permissions = new Set<string>();
    for (const ur of user.roles) for (const rp of ur.role.permissions) permissions.add(rp.permission.code);

    let warehouseIds: string[] | null = null;
    if (!user.isSuperAdmin && user.scopes.length && !user.scopes.some((s) => s.scopeType === 'ORGANIZATION')) {
      const direct = user.scopes.filter((s) => s.scopeType === 'WAREHOUSE').map((s) => s.scopeId);
      const regionIds = user.scopes.filter((s) => s.scopeType === 'REGION').map((s) => s.scopeId);
      const inRegions = regionIds.length
        ? await this.prisma.warehouse.findMany({ where: { regionId: { in: regionIds } }, select: { id: true } })
        : [];
      warehouseIds = [...new Set([...direct, ...inRegions.map((w) => w.id)])];
    }

    return {
      kind: 'employee',
      id: user.id,
      organizationId: user.organizationId ?? org,
      isSuperAdmin: user.isSuperAdmin,
      permissions,
      warehouseIds,
      sessionId: sid,
    };
  }

}
