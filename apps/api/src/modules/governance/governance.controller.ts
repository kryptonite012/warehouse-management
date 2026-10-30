import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsDefined, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { AuditService } from '../../common/audit.service';
import { AuthContext } from '../../common/auth-context';
import { CurrentActor, RequirePermissions } from '../../common/decorators';
import { DomainError } from '../../common/errors';
import { pageArgs, PageQuery, toPage } from '../../common/pagination';
import { PERMISSIONS as P } from '../../common/permissions';
import { PrismaService } from '../../common/prisma.service';

/** Settings that may be changed through the API, with a validator each. */
export const SETTING_KEYS: Record<string, (v: any) => boolean> = {
  'procurement.approval_limits': (v) => typeof v === 'object' && v !== null && Object.values(v).every((n) => typeof n === 'number' && n >= 0),
  'fulfillment.require_barcode_scan': (v) => typeof v === 'boolean',
  'fulfillment.allocation': (v) => typeof v === 'object' && v !== null && (v.preferDistance === undefined || typeof v.preferDistance === 'boolean'),
  'inventory.low_stock_alerts': (v) => typeof v === 'boolean',
  'privacy.customer_retention_days': (v) => Number.isInteger(v) && v >= 30,
};

class SettingDto {
  @IsIn(Object.keys(SETTING_KEYS)) key: string;
  @IsDefined() value: unknown;
}

class AuditQuery extends PageQuery {
  @IsOptional() @IsString() resourceType?: string;
  @IsOptional() @IsString() resourceId?: string;
  @IsOptional() @IsUUID() actorId?: string;
  @IsOptional() @IsIn(['SUCCESS', 'DENIED', 'FAILED']) outcome?: string;
}

@ApiTags('governance')
@ApiBearerAuth()
@Controller()
export class GovernanceController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get('audit-logs') @RequirePermissions(P.AUDIT_READ)
  async auditLogs(@CurrentActor() a: AuthContext, @Query() q: AuditQuery) {
    const where: Prisma.AuditLogWhereInput = {
      organizationId: a.organizationId,
      resourceType: q.resourceType, resourceId: q.resourceId, actorId: q.actorId, outcome: q.outcome,
      action: q.search ? { contains: q.search, mode: 'insensitive' } : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, ...pageArgs(q, ['createdAt'], 'createdAt') }),
      this.prisma.auditLog.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  @Get('security-events') @RequirePermissions(P.AUDIT_READ)
  security(@CurrentActor() a: AuthContext) {
    // Security events are platform-level; scope to users of this organization plus unattributed events.
    return this.prisma.$queryRaw`
      SELECT e.* FROM security_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.user_id IS NULL OR u.organization_id = ${a.organizationId}::uuid
      ORDER BY e.created_at DESC LIMIT 200`;
  }

  @Get('settings') @RequirePermissions(P.SETTINGS_MANAGE)
  async settings(@CurrentActor() a: AuthContext) {
    const rows = await this.prisma.systemSetting.findMany({ where: { organizationId: a.organizationId } });
    return { editable: Object.keys(SETTING_KEYS), values: Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  }

  @Put('settings') @RequirePermissions(P.SETTINGS_MANAGE)
  async setSetting(@CurrentActor() a: AuthContext, @Body() dto: SettingDto) {
    if (!SETTING_KEYS[dto.key](dto.value)) throw new DomainError('INVALID_SETTING', `Invalid value for ${dto.key}`, 400);
    const before = await this.prisma.systemSetting.findFirst({ where: { organizationId: a.organizationId, key: dto.key } });
    const row = before
      ? await this.prisma.systemSetting.update({ where: { id: before.id }, data: { value: dto.value as any, updatedById: a.id } })
      : await this.prisma.systemSetting.create({ data: { organizationId: a.organizationId, key: dto.key, value: dto.value as any, updatedById: a.id } });
    await this.audit.record({ actor: a, action: 'settings.update', resourceType: 'system_setting', resourceId: dto.key, before: before?.value, after: dto.value });
    return row;
  }

  /** Notifications addressed to the user directly or to any of their roles. */
  @Get('notifications')
  async notifications(@CurrentActor() a: AuthContext, @Query('unread') unread?: string) {
    const roles = await this.prisma.userRole.findMany({ where: { userId: a.id }, include: { role: true } });
    return this.prisma.notification.findMany({
      where: {
        organizationId: a.organizationId,
        readAt: unread === 'true' ? null : undefined,
        OR: [
          { recipientType: 'USER', recipientId: a.id },
          { recipientType: 'ROLE', recipientId: { in: roles.map((r) => r.role.code) }, ...(a.warehouseIds ? { OR: [{ warehouseId: null }, { warehouseId: { in: a.warehouseIds } }] } : {}) },
          ...(a.isSuperAdmin ? [{ recipientType: 'ROLE' }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Post('notifications/:id/read') @HttpCode(204)
  async markRead(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.notification.updateMany({ where: { id, organizationId: a.organizationId, readAt: null }, data: { readAt: new Date() } });
  }
}
