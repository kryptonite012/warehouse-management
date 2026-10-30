import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { IsString, Length } from 'class-validator';
import { AuthContext } from '../../common/auth-context';
import { CurrentActor, Public, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import { PaymentGateway } from './gateway';
import { PaymentsService } from './payments.service';

class CompleteRefundDto {
  @IsString() @Length(3, 120) reference: string;
}

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly svc: PaymentsService, private readonly gateway: PaymentGateway) {}

  @Public() @Get('config')
  config() { return this.gateway.status(); }

  /** Body is accepted as-is; the signature is verified against the raw bytes. */
  @Public() @SkipThrottle() @Post('webhooks/:provider') @HttpCode(200)
  webhook(@Param('provider') provider: string, @Req() req: any, @Headers('x-signature') signature: string | undefined, @Body() body: any) {
    return this.svc.handleWebhook(provider, req.rawBody, signature, body);
  }

  @ApiBearerAuth() @RequirePermissions(P.PAYMENTS_READ) @Get()
  list(@CurrentActor() a: AuthContext, @Query('status') status?: string) { return this.svc.list(a, status); }

  @ApiBearerAuth() @RequirePermissions(P.PAYMENTS_READ) @Get('reconciliation')
  reconciliation(@CurrentActor() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 86_400_000);
    return this.svc.reconciliation(a, start, end);
  }

  @ApiBearerAuth() @RequirePermissions(P.REFUNDS_MANAGE) @Post('refunds/:id/complete')
  completeRefund(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CompleteRefundDto) {
    return this.svc.completeRefund(a, id, dto.reference);
  }
}
