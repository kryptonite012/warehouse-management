import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { ActorKind, AuthContext } from './auth-context';
import { PermissionCode } from './permissions';

export const IS_PUBLIC = 'qs:isPublic';
export const REQUIRED_PERMISSIONS = 'qs:permissions';
export const ALLOWED_ACTORS = 'qs:actors';

/** Route needs no authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Caller must hold every listed permission. Employees only unless @Actors widens it. */
export const RequirePermissions = (...codes: PermissionCode[]) => SetMetadata(REQUIRED_PERMISSIONS, codes);

/** Which actor kinds may call the route. Defaults to ['employee']. */
export const Actors = (...kinds: ActorKind[]) => SetMetadata(ALLOWED_ACTORS, kinds);

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  return ctx.switchToHttp().getRequest().auth;
});
