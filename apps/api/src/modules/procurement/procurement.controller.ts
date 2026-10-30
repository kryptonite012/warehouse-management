import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthContext } from '../../common/auth-context';
import { CurrentActor, RequirePermissions } from '../../common/decorators';
import { PageQuery } from '../../common/pagination';
import { PERMISSIONS as P } from '../../common/permissions';
import {
  CreateGoodsReceiptDto, CreatePurchaseOrderDto, CreateSupplierDto, InspectDto, PoListQuery, SupplierPriceDto, UpdateSupplierDto,
} from './procurement.dto';
import { ProcurementService } from './procurement.service';

@ApiTags('procurement')
@ApiBearerAuth()
@Controller()
export class ProcurementController {
  constructor(private readonly svc: ProcurementService) {}

  @Get('suppliers') @RequirePermissions(P.SUPPLIERS_READ)
  suppliers(@CurrentActor() a: AuthContext, @Query() q: PageQuery) { return this.svc.listSuppliers(a, q); }

  @Post('suppliers') @RequirePermissions(P.SUPPLIERS_MANAGE)
  createSupplier(@CurrentActor() a: AuthContext, @Body() dto: CreateSupplierDto) { return this.svc.createSupplier(a, dto); }

  @Get('suppliers/:id') @RequirePermissions(P.SUPPLIERS_READ)
  supplier(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.getSupplier(a, id); }

  @Patch('suppliers/:id') @RequirePermissions(P.SUPPLIERS_MANAGE)
  updateSupplier(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto) { return this.svc.updateSupplier(a, id, dto); }

  @Post('suppliers/:id/prices') @RequirePermissions(P.SUPPLIERS_MANAGE)
  price(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SupplierPriceDto) { return this.svc.addSupplierPrice(a, id, dto); }

  @Get('purchase-orders') @RequirePermissions(P.PO_READ)
  pos(@CurrentActor() a: AuthContext, @Query() q: PoListQuery) { return this.svc.listPurchaseOrders(a, q); }

  @Post('purchase-orders') @RequirePermissions(P.PO_CREATE)
  createPo(@CurrentActor() a: AuthContext, @Body() dto: CreatePurchaseOrderDto) { return this.svc.createPurchaseOrder(a, dto); }

  @Get('purchase-orders/:id') @RequirePermissions(P.PO_READ)
  po(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.getPurchaseOrder(a, id); }

  @Get('purchase-orders/:id/document') @RequirePermissions(P.PO_READ) @Header('Content-Type', 'text/html; charset=utf-8')
  poDoc(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.purchaseOrderHtml(a, id); }

  @Post('purchase-orders/:id/submit') @RequirePermissions(P.PO_CREATE)
  submit(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.submitPurchaseOrder(a, id); }

  @Post('purchase-orders/:id/approve') @RequirePermissions(P.PO_APPROVE)
  approve(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.approvePurchaseOrder(a, id); }

  @Post('purchase-orders/:id/send') @RequirePermissions(P.PO_CREATE)
  send(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.markSent(a, id); }

  @Post('purchase-orders/:id/confirm') @RequirePermissions(P.PO_CREATE)
  confirm(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.markConfirmed(a, id); }

  @Post('purchase-orders/:id/cancel') @RequirePermissions(P.PO_APPROVE)
  cancel(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.cancelPurchaseOrder(a, id); }

  @Post('purchase-orders/:id/close') @RequirePermissions(P.PO_APPROVE)
  close(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.closePurchaseOrder(a, id); }

  @Get('goods-receipts') @RequirePermissions(P.RECEIVING)
  grns(@CurrentActor() a: AuthContext, @Query('status') status?: string) { return this.svc.listGoodsReceipts(a, status); }

  @Post('goods-receipts') @RequirePermissions(P.RECEIVING)
  receive(@CurrentActor() a: AuthContext, @Body() dto: CreateGoodsReceiptDto) { return this.svc.createGoodsReceipt(a, dto); }

  @Get('goods-receipts/:id') @RequirePermissions(P.RECEIVING)
  grn(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.getGoodsReceipt(a, id); }

  @Post('goods-receipts/:id/inspect') @RequirePermissions(P.QC_INSPECT)
  inspect(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: InspectDto) { return this.svc.inspect(a, id, dto); }

  @Post('goods-receipts/:id/complete') @RequirePermissions(P.RECEIVING)
  complete(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.complete(a, id); }
}
