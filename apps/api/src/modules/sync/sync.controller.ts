import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthContext } from '../../common/auth-context';
import { CurrentActor, Public, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import { PushDto, RegisterDeviceDto, ResolveConflictDto } from './sync.dto';
import { SyncService } from './sync.service';

@ApiTags('sync')
@Controller('sync')
export class SyncController {
  constructor(private readonly svc: SyncService) {}

  @ApiBearerAuth() @RequirePermissions(P.SYNC_MANAGE) @Post('devices')
  register(@CurrentActor() a: AuthContext, @Body() dto: RegisterDeviceDto) { return this.svc.registerDevice(a, dto); }

  @ApiBearerAuth() @RequirePermissions(P.SYNC_MANAGE) @Delete('devices/:id') @HttpCode(204)
  revoke(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.revokeDevice(a, id); }

  @ApiHeader({ name: 'x-device-token', required: true })
  @Public() @Throttle({ default: { limit: 120, ttl: 60_000 } }) @Get('snapshot')
  snapshot(@Headers('x-device-token') token?: string) { return this.svc.snapshot(token); }

  @ApiHeader({ name: 'x-device-token', required: true })
  @Public() @Throttle({ default: { limit: 120, ttl: 60_000 } }) @Post('push') @HttpCode(200)
  push(@Headers('x-device-token') token: string | undefined, @Body() dto: PushDto) { return this.svc.push(token, dto); }

  @ApiBearerAuth() @RequirePermissions(P.SYNC_MANAGE) @Get('status')
  status(@CurrentActor() a: AuthContext) { return this.svc.status(a); }

  @ApiBearerAuth() @RequirePermissions(P.SYNC_MANAGE) @Get('conflicts')
  conflicts(@CurrentActor() a: AuthContext, @Query('warehouseId') wid?: string, @Query('status') status?: string) { return this.svc.listConflicts(a, wid, status); }

  @ApiBearerAuth() @RequirePermissions(P.SYNC_MANAGE) @Post('conflicts/:id/resolve')
  resolve(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveConflictDto) { return this.svc.resolveConflict(a, id, dto); }
}
