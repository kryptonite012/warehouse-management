import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthContext, ActorKind } from './auth-context';
import { AuditService } from './audit.service';
import { ALLOWED_ACTORS, IS_PUBLIC, REQUIRED_PERMISSIONS } from './decorators';
import { Forbidden } from './errors';
import { PrismaService } from './prisma.service';
import { TokenService } from './token.service';

/**
 * Global guard: authenticates the bearer token, loads current permissions and
 * warehouse scope from the database (so revocations apply immediately), then
 * enforces @Actors and @RequirePermissions. Denials are audited.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');

    let claims;
    try {
      claims = this.tokens.verifyAccess(header.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const auth = await this.buildContext(claims.kind, claims.sub, claims.org, claims.sid);
    auth.ip = req.ip;
    req.auth = auth;

    const allowed = this.reflector.getAllAndOverride<ActorKind[]>(ALLOWED_ACTORS, targets) ?? ['employee'];
    if (!allowed.includes(auth.kind)) {
      await this.deny(auth, req, 'actor_kind_not_allowed');
      throw Forbidden('This endpoint is not available to your account type');
    }

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    const missing = required.filter((p) => !auth.isSuperAdmin && !auth.permissions.has(p));
    if (missing.length) {
      await this.deny(auth, req, `missing:${missing.join(',')}`);
      throw Forbidden(`Missing permission: ${missing.join(', ')}`);
    }
    return true;
  }

  private async buildContext(kind: ActorKind, id: string, org: string, sid?: string): Promise<AuthContext> {
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

  private deny(auth: AuthContext, req: any, reason: string) {
    return this.audit.record({
      actor: auth,
      action: `${req.method} ${req.route?.path ?? req.url}`,
      resourceType: 'endpoint',
      outcome: 'DENIED',
      after: { reason },
      requestId: req.requestId,
    });
  }
}
