import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { assertWarehouseAccess, AuthContext } from '../../common/auth-context';
import { CurrentActor, RequirePermissions } from '../../common/decorators';
import { DomainError } from '../../common/errors';
import { PERMISSIONS as P } from '../../common/permissions';
import { Range, ReportsService } from './reports.service';

function range(a: AuthContext, from?: string, to?: string, warehouseId?: string, defaultDays = 7): Range {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - defaultDays * 86_400_000);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end) throw new DomainError('INVALID_RANGE', 'from must be before to', 400);
  if (end.getTime() - start.getTime() > 366 * 86_400_000) throw new DomainError('RANGE_TOO_LARGE', 'Maximum range is one year', 400);
  if (warehouseId) assertWarehouseAccess(a, warehouseId);
  return { from: start, to: end, warehouseId };
}

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get('overview') @RequirePermissions(P.REPORTS_READ)
  overview(@CurrentActor() a: AuthContext, @Query('warehouseId') warehouseId?: string) {
    if (warehouseId) assertWarehouseAccess(a, warehouseId);
    return this.svc.overview(a, warehouseId);
  }

  @Get('sales') @RequirePermissions(P.REPORTS_READ)
  sales(@CurrentActor() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string, @Query('warehouseId') wid?: string, @Query('granularity') g?: string) {
    return this.svc.sales(a, range(a, from, to, wid), g === 'hour' ? 'hour' : 'day');
  }

  @Get('inventory') @RequirePermissions(P.REPORTS_READ)
  inventory(@CurrentActor() a: AuthContext, @Query('warehouseId') warehouseId?: string) {
    if (warehouseId) assertWarehouseAccess(a, warehouseId);
    return this.svc.inventory(a, warehouseId);
  }

  @Get('warehouse') @RequirePermissions(P.REPORTS_READ)
  warehouse(@CurrentActor() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string, @Query('warehouseId') wid?: string) {
    return this.svc.warehouse(a, range(a, from, to, wid));
  }

  @Get('procurement') @RequirePermissions(P.REPORTS_READ)
  procurement(@CurrentActor() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.procurement(a, range(a, from, to, undefined, 30));
  }

  @Get('fulfillment') @RequirePermissions(P.REPORTS_READ)
  fulfillment(@CurrentActor() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string, @Query('warehouseId') wid?: string) {
    return this.svc.fulfillment(a, range(a, from, to, wid));
  }
}
