import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Run fn in a transaction, retrying on serialization failures / deadlocks
   * (SQLSTATE 40001 / 40P01) which are expected under heavy concurrent writes.
   */
  async withRetry<T>(
    fn: (tx: Tx) => Promise<T>,
    opts: { isolationLevel?: Prisma.TransactionIsolationLevel; retries?: number } = {},
  ): Promise<T> {
    const retries = opts.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.$transaction(fn, {
          isolationLevel: opts.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: 15000,
          maxWait: 5000,
        });
      } catch (err: any) {
        const code = err?.code ?? err?.meta?.code;
        const retryable = code === 'P2034' || code === '40001' || code === '40P01';
        if (!retryable || attempt >= retries) throw err;
        await new Promise((r) => setTimeout(r, 20 * 2 ** attempt + Math.random() * 20));
      }
    }
  }
}
