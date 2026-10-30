import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ActorKind, AuthContext } from './auth-context';
import { AuditService } from './audit.service';
import { ALLOWED_ACTORS, IS_PUBLIC, REQUIRED_PERMISSIONS } from './decorators';
import { Forbidden } from './errors';
import { ActorService } from './actor.service';
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
    private readonly actors: ActorService,
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

    const auth = await this.actors.load(claims.kind, claims.sub, claims.org, claims.sid);
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
