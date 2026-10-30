import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../common/audit.service';
import { DomainError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { TokenService } from '../../common/token.service';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password';

interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');
  private readonly maxFailed = Number(process.env.LOGIN_MAX_FAILED_ATTEMPTS ?? 5);
  private readonly lockMinutes = Number(process.env.LOGIN_LOCKOUT_MINUTES ?? 15);
  private readonly refreshDays = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 14);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async login(identifier: string, password: string, client: ClientInfo) {
    const id = identifier.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: id }, { phone: identifier.trim() }], deletedAt: null },
    });

    if (!user) {
      await burnPasswordCheck(password);
      await this.recordAttempt(id, null, false, 'unknown_identifier', client);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.recordAttempt(id, user.id, false, 'locked', client);
      throw new DomainError('ACCOUNT_LOCKED', 'Account is temporarily locked after repeated failed logins', 423, {
        lockedUntil: user.lockedUntil,
      });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok || user.status !== 'ACTIVE') {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= this.maxFailed;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + this.lockMinutes * 60_000) : undefined,
        },
      });
      await this.recordAttempt(id, user.id, false, ok ? 'inactive' : 'bad_password', client);
      if (lock) {
        await this.prisma.securityEvent.create({
          data: { eventType: 'ACCOUNT_LOCKED', severity: 'MEDIUM', userId: user.id, details: { failed }, ipAddress: client.ip },
        });
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.recordAttempt(id, user.id, true, null, client);

    return this.issueTokens(user.id, user.organizationId ?? '', randomUUID(), client);
  }

  /**
   * Refresh-token rotation. Each refresh token is single-use. Presenting an
   * already-rotated token means it was stolen or replayed: the whole token family
   * is revoked and a security event is raised.
   */
  async refresh(refreshToken: string, client: ClientInfo) {
    const hash = TokenService.hash(refreshToken);
    const session = await this.prisma.userSession.findUnique({ where: { refreshTokenHash: hash } });
    if (!session) throw new UnauthorizedException('Invalid refresh token');

    if (session.rotatedAt || session.revokedAt) {
      await this.prisma.userSession.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.prisma.securityEvent.create({
        data: {
          eventType: 'REFRESH_TOKEN_REUSE',
          severity: 'HIGH',
          userId: session.userId,
          details: { familyId: session.familyId },
          ipAddress: client.ip,
        },
      });
      throw new UnauthorizedException('Refresh token has already been used; all sessions in this chain were revoked');
    }
    if (session.expiresAt < new Date()) throw new UnauthorizedException('Refresh token expired');

    // Mark rotated atomically; if a concurrent refresh already rotated it, count = 0.
    const { count } = await this.prisma.userSession.updateMany({
      where: { id: session.id, rotatedAt: null, revokedAt: null },
      data: { rotatedAt: new Date(), revokedAt: new Date() },
    });
    if (count === 0) throw new UnauthorizedException('Refresh token already used');

    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Account is not active');
    return this.issueTokens(user.id, user.organizationId ?? '', session.familyId, client);
  }

  async logout(sessionId: string | undefined, userId: string) {
    if (!sessionId) return;
    await this.prisma.userSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  listSessions(userId: string) {
    return this.prisma.userSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeSession(userId: string, sessionId: string) {
    await this.prisma.userSession.updateMany({ where: { id: sessionId, userId }, data: { revokedAt: new Date() } });
  }

  /**
   * Always responds the same way. The reset token is delivered via the
   * notification module; in development it is returned when
   * EXPOSE_RESET_TOKEN=true so the flow can be exercised without SMTP.
   */
  async forgotPassword(identifier: string) {
    const id = identifier.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({ where: { OR: [{ email: id }, { phone: identifier.trim() }] } });
    if (!user) return { accepted: true };
    const { token, hash } = this.tokens.newOpaqueToken();
    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + 30 * 60_000) },
    });
    if (user.organizationId) {
      await this.prisma.notification.create({
        data: {
          organizationId: user.organizationId,
          recipientType: 'USER',
          recipientId: user.id,
          category: 'SECURITY',
          title: 'Password reset requested',
          body: 'A password reset was requested for your account. The link expires in 30 minutes.',
        },
      });
    }
    return process.env.EXPOSE_RESET_TOKEN === 'true' ? { accepted: true, devToken: token } : { accepted: true };
  }

  async resetPassword(token: string, newPassword: string) {
    const rec = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: TokenService.hash(token) } });
    if (!rec || rec.usedAt || rec.expiresAt < new Date()) {
      throw new DomainError('INVALID_RESET_TOKEN', 'Reset token is invalid or expired', 400);
    }
    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({
        where: { id: rec.userId },
        data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
      }),
      // Changing password ends every existing session.
      this.prisma.userSession.updateMany({ where: { userId: rec.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return { reset: true };
  }

  private async issueTokens(userId: string, organizationId: string, familyId: string, client: ClientInfo) {
    const { token: refreshToken, hash } = this.tokens.newOpaqueToken();
    const session = await this.prisma.userSession.create({
      data: {
        userId,
        familyId,
        refreshTokenHash: hash,
        userAgent: client.userAgent?.slice(0, 255),
        ipAddress: client.ip,
        expiresAt: new Date(Date.now() + this.refreshDays * 86_400_000),
      },
    });
    const accessToken = this.tokens.signAccess({ sub: userId, org: organizationId, kind: 'employee', sid: session.id });
    return { accessToken, refreshToken, expiresIn: this.tokens.accessTtl, tokenType: 'Bearer' };
  }

  private recordAttempt(identifier: string, userId: string | null, success: boolean, reason: string | null, client: ClientInfo) {
    return this.prisma.loginAttempt.create({
      data: { identifier, userId, success, reason, ipAddress: client.ip },
    });
  }
}
