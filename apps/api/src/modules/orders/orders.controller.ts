import { Body, Controller, DefaultValuePipe, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AuthContext } from '../../common/auth-context';
import { Forbidden } from '../../common/errors';
import { Actors, CurrentActor, Public, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import { CustomersService } from '../customers/customers.service';
import { CancelOrderDto, CartItemDto, OrderListQuery, PlaceOrderDto, ReceiveReturnDto, ReturnRequestDto } from './orders.dto';
import { OrdersService } from './orders.service';
import { StorefrontService } from './storefront.service';

@ApiTags('storefront')
@Controller('storefront')
export class StorefrontController {
  constructor(private readonly svc: StorefrontService, private readonly customers: CustomersService) {}

  @Public() @Get('serviceability')
  async serviceability(@Query('postalCode') postalCode: string, @Query('lat') lat?: string, @Query('lng') lng?: string, @Query('org') org?: string) {
    const o = await this.customers.resolveOrg(org);
    return this.svc.serviceability(o.id, String(postalCode ?? ''), lat ? Number(lat) : undefined, lng ? Number(lng) : undefined);
  }

  @Public() @Get('categories')
  async categories(@Query('org') org?: string) {
    return this.svc.categories((await this.customers.resolveOrg(org)).id);
  }

  @Public() @Get('stores/:storeId/products')
  async products(
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query('categoryId') categoryId?: string,
    @Query('search') search?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('pageSize', new DefaultValuePipe(24), ParseIntPipe) pageSize = 24,
    @Query('org') org?: string,
  ) {
    const o = await this.customers.resolveOrg(org);
    return this.svc.products(o.id, storeId, { categoryId, search: search?.slice(0, 100), page: Math.max(page, 1), pageSize: Math.min(Math.max(pageSize, 1), 60) });
  }

  @Public() @Get('stores/:storeId/products/:productId')
  async product(@Param('storeId', ParseUUIDPipe) storeId: string, @Param('productId', ParseUUIDPipe) productId: string, @Query('org') org?: string) {
    return this.svc.product((await this.customers.resolveOrg(org)).id, storeId, productId);
  }

  @ApiBearerAuth() @Actors('customer') @Get('cart')
  cart(@CurrentActor() a: AuthContext, @Query('storeId') storeId?: string) { return this.svc.cart(a, storeId); }

  @ApiBearerAuth() @Actors('customer') @Put('cart/items')
  setItem(@CurrentActor() a: AuthContext, @Body() dto: CartItemDto) { return this.svc.setCartItem(a, dto.skuId, dto.quantity); }

  @ApiBearerAuth() @Actors('customer') @Delete('cart') @HttpCode(204)
  clear(@CurrentActor() a: AuthContext) { return this.svc.clearCart(a); }
}

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly svc: OrdersService) {}

  @Actors('customer') @Post()
  async place(@CurrentActor() a: AuthContext, @Body() dto: PlaceOrderDto, @Res({ passthrough: true }) res: Response) {
    const { order, replayed } = await this.svc.place(a, dto);
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return order;
  }

  @Actors('customer', 'employee') @Get()
  list(@CurrentActor() a: AuthContext, @Query() q: OrderListQuery) {
    this.assertStaffRead(a);
    return this.svc.list(a, q);
  }

  @Actors('customer', 'employee') @Get(':id')
  get(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    this.assertStaffRead(a);
    return this.svc.get(a, id);
  }

  @Actors('customer', 'employee') @Get(':id/history')
  history(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    this.assertStaffRead(a);
    return this.svc.history(a, id);
  }

  @Actors('customer', 'employee') @Post(':id/cancel')
  cancel(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelOrderDto) {
    return this.svc.cancel(a, id, dto.reason);
  }

  @Actors('customer') @Post(':id/return-request')
  requestReturn(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReturnRequestDto) {
    return this.svc.requestReturn(a, id, dto.reason);
  }

  @RequirePermissions(P.ORDERS_MANAGE) @Post(':id/returns/receive')
  receiveReturn(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceiveReturnDto) {
    return this.svc.receiveReturn(a, id, dto);
  }

  private assertStaffRead(a: AuthContext) {
    if (a.kind === 'employee' && !a.isSuperAdmin && !a.permissions.has(P.ORDERS_READ)) {
      throw Forbidden('Missing permission: orders.read');
    }
  }
}
