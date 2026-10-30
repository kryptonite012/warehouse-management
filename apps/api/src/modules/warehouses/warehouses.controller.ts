import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthContext } from '../../common/auth-context';
import { code128Svg, qrSvg } from '../../common/barcode';
import { CurrentActor, Public, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import {
  AssignSkuLocationDto, BulkLayoutDto, CreateLocationDto, CreateWarehouseDto, UpdateLocationDto, UpdateWarehouseDto, WarehouseListQuery,
} from './warehouses.dto';
import { WarehousesService } from './warehouses.service';
import { StorePerformanceService } from './store-performance.service';

@ApiTags('warehouses')
@ApiBearerAuth()
@Controller()
export class WarehousesController {
  constructor(private readonly svc: WarehousesService, private readonly perf: StorePerformanceService) {}

  @Get('warehouses') @RequirePermissions(P.WAREHOUSES_READ)
  list(@CurrentActor() a: AuthContext, @Query() q: WarehouseListQuery) {
    return this.svc.list(a, q);
  }

  @Post('warehouses') @RequirePermissions(P.WAREHOUSES_MANAGE)
  create(@CurrentActor() a: AuthContext, @Body() dto: CreateWarehouseDto) {
    return this.svc.create(a, dto);
  }

  @Get('warehouses/:id') @RequirePermissions(P.WAREHOUSES_READ)
  get(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(a, id);
  }

  @Patch('warehouses/:id') @RequirePermissions(P.WAREHOUSES_MANAGE)
  update(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWarehouseDto) {
    return this.svc.update(a, id, dto);
  }

  @Get('warehouses/:id/layout') @RequirePermissions(P.WAREHOUSES_READ)
  layout(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.layout(a, id);
  }

  @Post('warehouses/:id/locations') @RequirePermissions(P.LAYOUT_MANAGE)
  createLocation(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateLocationDto) {
    return this.svc.createLocation(a, id, dto);
  }

  @Post('warehouses/:id/layout/generate') @RequirePermissions(P.LAYOUT_MANAGE)
  generate(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BulkLayoutDto) {
    return this.svc.bulkLayout(a, id, dto);
  }

  @Patch('warehouses/:id/locations/:locationId') @RequirePermissions(P.LAYOUT_MANAGE)
  updateLocation(
    @CurrentActor() a: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Body() dto: UpdateLocationDto,
  ) {
    return this.svc.updateLocation(a, id, locationId, dto);
  }

  @Post('warehouses/:id/sku-locations') @RequirePermissions(P.LAYOUT_MANAGE)
  assign(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignSkuLocationDto) {
    return this.svc.assignSku(a, id, dto);
  }

  @Get('locations/by-barcode/:barcode') @RequirePermissions(P.WAREHOUSES_READ)
  byBarcode(@CurrentActor() a: AuthContext, @Param('barcode') barcode: string) {
    return this.svc.findByBarcode(a, barcode);
  }

  @Get('labels/barcode.svg') @Public() @Header('Content-Type', 'image/svg+xml')
  barcode(@Query('text') text: string) {
    return code128Svg(text);
  }

  @Get('labels/qr.svg') @Public() @Header('Content-Type', 'image/svg+xml')
  qr(@Query('text') text: string) {
    return qrSvg(String(text).slice(0, 512));
  }

  // ---------------------------------------------------------- dark stores

  @Get('dark-stores') @RequirePermissions(P.DARK_STORES_READ)
  listStores(@CurrentActor() a: AuthContext, @Query() q: WarehouseListQuery) {
    return this.svc.list(a, q, 'DARK_STORE');
  }

  @Post('dark-stores') @RequirePermissions(P.DARK_STORES_MANAGE)
  createStore(@CurrentActor() a: AuthContext, @Body() dto: CreateWarehouseDto) {
    return this.svc.create(a, { ...dto, type: 'DARK_STORE' });
  }

  @Get('dark-stores/:id') @RequirePermissions(P.DARK_STORES_READ)
  getStore(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(a, id);
  }

  @Patch('dark-stores/:id') @RequirePermissions(P.DARK_STORES_MANAGE)
  updateStore(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWarehouseDto) {
    return this.svc.update(a, id, dto);
  }

  @Get('dark-stores/:id/performance') @RequirePermissions(P.DARK_STORES_READ)
  async performance(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query('days') days?: string) {
    await this.svc.get(a, id);
    return this.perf.forStore(id, Math.min(Math.max(Number(days) || 7, 1), 90));
  }
}
