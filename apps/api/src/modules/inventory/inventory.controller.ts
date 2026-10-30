import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, DefaultValuePipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { AuthContext } from '../../common/auth-context';
import { CurrentActor, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import {
  CreateAdjustmentDto, CreateCountDto, CreateReservationDto, CreateTransferDto, DecisionDto, InventoryQuery, MovementQuery,
  ReceiveTransferDto, StatusChangeDto, SubmitCountDto,
} from './inventory.dto';
import { InventoryService } from './inventory.service';

class ReleaseDto {
  @IsString() @Length(3, 200) reason: string;
}

@ApiTags('inventory')
@ApiBearerAuth()
@Controller('inventory')
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  @Get() @RequirePermissions(P.INVENTORY_READ)
  summary(@CurrentActor() a: AuthContext, @Query() q: InventoryQuery) {
    return this.svc.summary(a, q);
  }

  @Get('movements') @RequirePermissions(P.INVENTORY_READ)
  movements(@CurrentActor() a: AuthContext, @Query() q: MovementQuery) {
    return this.svc.movements(a, q);
  }

  @Get('low-stock') @RequirePermissions(P.INVENTORY_READ)
  lowStock(@CurrentActor() a: AuthContext, @Query('warehouseId') warehouseId?: string) {
    return this.svc.lowStock(a, warehouseId);
  }

  @Get('expiring') @RequirePermissions(P.INVENTORY_READ)
  expiring(
    @CurrentActor() a: AuthContext,
    @Query('days', new DefaultValuePipe(7), ParseIntPipe) days: number,
    @Query('warehouseId') warehouseId?: string,
  ) {
    return this.svc.expiring(a, Math.min(days, 365), warehouseId);
  }

  @Post('reservations') @RequirePermissions(P.INVENTORY_RESERVE)
  reserve(@CurrentActor() a: AuthContext, @Body() dto: CreateReservationDto) {
    return this.svc.createReservation(a, dto);
  }

  @Post('reservations/:id/release') @RequirePermissions(P.INVENTORY_RESERVE)
  release(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReleaseDto) {
    return this.svc.releaseReservation(a, id, dto.reason);
  }

  @Get('adjustments') @RequirePermissions(P.INVENTORY_READ)
  adjustments(@CurrentActor() a: AuthContext, @Query('status') status?: string, @Query('warehouseId') warehouseId?: string) {
    return this.svc.listAdjustments(a, status, warehouseId);
  }

  @Post('adjustments') @RequirePermissions(P.INVENTORY_ADJUST_REQUEST)
  adjust(@CurrentActor() a: AuthContext, @Body() dto: CreateAdjustmentDto) {
    return this.svc.requestAdjustment(a, dto);
  }

  @Post('adjustments/:id/decision') @RequirePermissions(P.INVENTORY_ADJUST_APPROVE)
  decide(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) {
    return this.svc.decideAdjustment(a, id, dto);
  }

  @Post('warehouses/:warehouseId/status-changes') @RequirePermissions(P.INVENTORY_QUALITY)
  status(@CurrentActor() a: AuthContext, @Param('warehouseId', ParseUUIDPipe) wid: string, @Body() dto: StatusChangeDto) {
    return this.svc.changeStatus(a, wid, dto);
  }

  @Get('counts') @RequirePermissions(P.INVENTORY_COUNT)
  counts(@CurrentActor() a: AuthContext, @Query('warehouseId') warehouseId?: string) {
    return this.svc.listCounts(a, warehouseId);
  }

  @Post('counts') @RequirePermissions(P.INVENTORY_COUNT)
  createCount(@CurrentActor() a: AuthContext, @Body() dto: CreateCountDto) {
    return this.svc.createCount(a, dto);
  }

  @Get('counts/:id') @RequirePermissions(P.INVENTORY_COUNT)
  getCount(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getCount(a, id);
  }

  @Post('counts/:id/submit') @RequirePermissions(P.INVENTORY_COUNT)
  submit(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmitCountDto) {
    return this.svc.submitCount(a, id, dto);
  }

  @Post('counts/:id/reconcile') @RequirePermissions(P.INVENTORY_COUNT_RECONCILE)
  reconcile(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.reconcileCount(a, id);
  }

  @Get('transfers') @RequirePermissions(P.INVENTORY_READ)
  transfers(@CurrentActor() a: AuthContext, @Query('status') status?: string) {
    return this.svc.listTransfers(a, status);
  }

  @Post('transfers') @RequirePermissions(P.INVENTORY_TRANSFER)
  transfer(@CurrentActor() a: AuthContext, @Body() dto: CreateTransferDto) {
    return this.svc.createTransfer(a, dto);
  }

  @Post('transfers/:id/dispatch') @RequirePermissions(P.INVENTORY_TRANSFER)
  dispatch(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.dispatchTransfer(a, id);
  }

  @Post('transfers/:id/receive') @RequirePermissions(P.INVENTORY_TRANSFER)
  receive(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceiveTransferDto) {
    return this.svc.receiveTransfer(a, id, dto);
  }

  @Get(':skuId') @RequirePermissions(P.INVENTORY_READ)
  sku(@CurrentActor() a: AuthContext, @Param('skuId', ParseUUIDPipe) skuId: string, @Query('warehouseId') warehouseId?: string) {
    return this.svc.skuDetail(a, skuId, warehouseId);
  }
}
