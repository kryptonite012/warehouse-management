import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthContext } from '../../common/auth-context';
import { CurrentActor, RequirePermissions } from '../../common/decorators';
import { Forbidden } from '../../common/errors';
import { PERMISSIONS as P } from '../../common/permissions';
import { AssignDto, CreateRiderDto, DeliveryStatusDto, ProofDto, RiderAvailabilityDto, ShiftDto } from './delivery.dto';
import { DeliveryService } from './delivery.service';

const canDeliver = (a: AuthContext) =>
  a.isSuperAdmin || a.permissions.has(P.DELIVERY_PERFORM) || a.permissions.has(P.DELIVERY_MANAGE) || a.permissions.has(P.DISPATCH);

@ApiTags('delivery')
@ApiBearerAuth()
@Controller()
export class DeliveryController {
  constructor(private readonly svc: DeliveryService) {}

  @Get('delivery-partners') @RequirePermissions(P.DELIVERY_MANAGE)
  riders(@CurrentActor() a: AuthContext, @Query('storeId') storeId?: string, @Query('status') status?: string) { return this.svc.listRiders(a, storeId, status); }

  @Post('delivery-partners') @RequirePermissions(P.DELIVERY_MANAGE)
  createRider(@CurrentActor() a: AuthContext, @Body() dto: CreateRiderDto) { return this.svc.createRider(a, dto); }

  @Patch('delivery-partners/:id/availability') @RequirePermissions(P.DELIVERY_MANAGE)
  availability(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RiderAvailabilityDto) { return this.svc.setAvailability(a, id, dto.status); }

  @Post('delivery-partners/:id/shifts') @RequirePermissions(P.DELIVERY_MANAGE)
  shift(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ShiftDto) { return this.svc.addShift(a, id, dto); }

  @Get('delivery-partners/:id/performance') @RequirePermissions(P.DELIVERY_MANAGE)
  perf(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.riderPerformance(a, id); }

  @Post('deliveries/assign') @RequirePermissions(P.DISPATCH)
  assign(@CurrentActor() a: AuthContext, @Body() dto: AssignDto) { return this.svc.assign(a, dto); }

  @Get('deliveries')
  list(@CurrentActor() a: AuthContext, @Query('status') status?: string, @Query('storeId') storeId?: string) {
    if (!canDeliver(a)) throw Forbidden();
    return this.svc.list(a, status, storeId);
  }

  @Get('deliveries/:id')
  get(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    if (!canDeliver(a)) throw Forbidden();
    return this.svc.get(a, id);
  }

  @Post('deliveries/:id/status')
  status(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeliveryStatusDto) {
    if (!canDeliver(a)) throw Forbidden();
    return this.svc.updateStatus(a, id, dto);
  }

  @Post('deliveries/:id/proof-of-delivery')
  proof(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProofDto) {
    if (!canDeliver(a)) throw Forbidden();
    return this.svc.proofOfDelivery(a, id, dto);
  }
}
