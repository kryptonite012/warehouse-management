import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

export interface WebhookEvent {
  eventId: string;
  type: 'payment.captured' | 'payment.failed' | 'refund.processed';
  paymentId: string; // our payment id, echoed back by the gateway as merchant reference
  providerPaymentId?: string;
  amount: number;
  currency?: string;
  failureReason?: string;
}

/**
 * Payment provider abstraction. Concrete gateways (Razorpay, Cashfree, PayU, ...) implement
 * signature verification and payload normalisation. Card data never touches this system:
 * the client SDK talks to the gateway; we only receive references and signed callbacks.
 */
export interface PaymentProvider {
  readonly name: string;
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean;
  parseEvent(body: any): WebhookEvent;
}

/**
 * Gateway-agnostic adapter: the callback body must be signed with
 * HMAC-SHA256(PAYMENT_WEBHOOK_SECRET, rawBody) in the `x-signature` header (hex).
 */
export class GenericHmacProvider implements PaymentProvider {
  readonly name = 'generic-hmac';
  constructor(private readonly secret: string) {}

  verifySignature(rawBody: Buffer, signature?: string) {
    if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
    const expected = createHmac('sha256', this.secret).update(rawBody).digest();
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  }

  parseEvent(body: any): WebhookEvent {
    return {
      eventId: String(body.eventId),
      type: body.type,
      paymentId: String(body.paymentId),
      providerPaymentId: body.providerPaymentId ? String(body.providerPaymentId) : undefined,
      amount: Number(body.amount),
      currency: body.currency,
      failureReason: body.failureReason,
    };
  }
}

@Injectable()
export class PaymentGateway {
  readonly provider: PaymentProvider | null;
  readonly codEnabled = process.env.COD_ENABLED !== 'false';

  constructor() {
    const name = process.env.PAYMENT_PROVIDER;
    const secret = process.env.PAYMENT_WEBHOOK_SECRET;
    this.provider = name === 'generic-hmac' && secret ? new GenericHmacProvider(secret) : null;
  }

  status() {
    return {
      onlinePayments: this.provider ? { status: 'CONFIGURED', provider: this.provider.name } : { status: 'NOT_CONFIGURED' },
      cashOnDelivery: this.codEnabled ? 'ENABLED' : 'DISABLED',
    };
  }
}
