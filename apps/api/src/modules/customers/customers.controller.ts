import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { AuthContext } from '../../common/auth-context';
import { Actors, CurrentActor, Public, RequirePermissions } from '../../common/decorators';
import { pageArgs, PageQuery, toPage } from '../../common/pagination';
import { PERMISSIONS as P } from '../../common/permissions';
import { PrismaService } from '../../common/prisma.service';
import { AddressDto, CustomerLoginDto, RegisterCustomerDto, UpdateProfileDto } from './customers.dto';
import { CustomersService } from './customers.service';

const AUTH_LIMIT = Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE ?? 10);

@ApiTags('customers')
@Controller('customers')
export class CustomersController {
  constructor(private readonly svc: CustomersService, private readonly prisma: PrismaService) {}

  @Public() @Throttle({ default: { limit: AUTH_LIMIT, ttl: 60_000 } }) @Post('register')
  register(@Body() dto: RegisterCustomerDto) { return this.svc.register(dto); }

  @Public() @Throttle({ default: { limit: AUTH_LIMIT, ttl: 60_000 } }) @Post('login') @HttpCode(200)
  login(@Body() dto: CustomerLoginDto) { return this.svc.login(dto); }

  @ApiBearerAuth() @Actors('customer') @Get('profile')
  profile(@CurrentActor() a: AuthContext) { return this.svc.profile(a); }

  @ApiBearerAuth() @Actors('customer') @Patch('profile')
  update(@CurrentActor() a: AuthContext, @Body() dto: UpdateProfileDto) { return this.svc.updateProfile(a, dto); }

  @ApiBearerAuth() @Actors('customer') @Post('addresses')
  addAddress(@CurrentActor() a: AuthContext, @Body() dto: AddressDto) { return this.svc.addAddress(a, dto); }

  @ApiBearerAuth() @Actors('customer') @Put('addresses/:id')
  updateAddress(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddressDto) { return this.svc.updateAddress(a, id, dto); }

  @ApiBearerAuth() @Actors('customer') @Delete('addresses/:id') @HttpCode(204)
  deleteAddress(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.deleteAddress(a, id); }

  /** Staff view (customer support). Password hashes are never selected. */
  @ApiBearerAuth() @RequirePermissions(P.CUSTOMERS_READ) @Get()
  async list(@CurrentActor() a: AuthContext, @Query() q: PageQuery) {
    const where: Prisma.CustomerWhereInput = {
      organizationId: a.organizationId,
      OR: q.search ? [{ fullName: { contains: q.search, mode: 'insensitive' } }, { phone: { contains: q.search } }, { email: { contains: q.search, mode: 'insensitive' } }] : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({
        where, select: { id: true, fullName: true, phone: true, email: true, status: true, createdAt: true, _count: { select: { orders: true } } },
        ...pageArgs(q, ['createdAt', 'fullName'], 'createdAt'),
      }),
      this.prisma.customer.count({ where }),
    ]);
    return toPage(rows, total, q);
  }
}
