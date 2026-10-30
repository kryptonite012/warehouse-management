import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthContext } from '../../common/auth-context';
import { CurrentActor, Public } from '../../common/decorators';
import { PrismaService } from '../../common/prisma.service';
import { ForgotPasswordDto, LoginDto, RefreshDto, ResetPasswordDto } from './auth.dto';
import { AuthService } from './auth.service';

const client = (req: Request) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly prisma: PrismaService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto.identifier, dto.password, client(req));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, client(req));
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentActor() actor: AuthContext) {
    await this.auth.logout(actor.sessionId, actor.id);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(202)
  forgot(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.identifier);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('reset-password')
  @HttpCode(200)
  reset(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.newPassword);
  }

  @ApiBearerAuth()
  @Get('me')
  async me(@CurrentActor() actor: AuthContext) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: actor.id },
      select: { id: true, email: true, phone: true, fullName: true, organizationId: true, isSuperAdmin: true, roles: { select: { role: { select: { code: true, name: true } } } } },
    });
    return {
      ...user,
      roles: user.roles.map((r) => r.role),
      permissions: [...actor.permissions].sort(),
      warehouseIds: actor.warehouseIds,
    };
  }

  @ApiBearerAuth()
  @Get('sessions')
  sessions(@CurrentActor() actor: AuthContext) {
    return this.auth.listSessions(actor.id);
  }

  @ApiBearerAuth()
  @Delete('sessions/:id')
  @HttpCode(204)
  async revoke(@CurrentActor() actor: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.auth.revokeSession(actor.id, id);
  }
}
