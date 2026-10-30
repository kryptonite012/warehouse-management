import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthContext } from './auth-context';
import { PrismaService, Tx } from './prisma.service';

export interface AuditEntry {
  actor: AuthContext;
  action: string;
  resourceType: string;
  resourceId?: string;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILED';
  before?: unknown;
  after?: unknown;
  requestId?: string;
}

const json = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue));

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly prisma: PrismaService) {}

  /** Write an audit row. Pass tx to make it part of the business transaction. */
  async record(entry: AuditEntry, tx?: Tx) {
    const client = tx ?? this.prisma;
    try {
      await client.auditLog.create({
        data: {
          organizationId: entry.actor.organizationId,
          actorType: entry.actor.kind,
          actorId: entry.actor.kind === 'system' ? null : entry.actor.id,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          outcome: entry.outcome ?? 'SUCCESS',
          before: json(entry.before),
          after: json(entry.after),
          ipAddress: entry.actor.ip,
          requestId: entry.requestId,
        },
      });
    } catch (err) {
      if (tx) throw err;
      this.logger.error(`failed to write audit log: ${(err as Error).message}`);
    }
  }
}
