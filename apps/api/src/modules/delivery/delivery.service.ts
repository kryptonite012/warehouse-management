import { Injectable } from '@nestjs/common';
import { DeliveryStatus } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { assertWarehouseAccess, AuthContext, hasPermission, warehouseScopeFilter } from '../../common/auth-context';
import { Conflict, DomainError, Forbidden, NotFound } from '../../common/errors';
import { PERMISSIONS } from '../../common/permissions';
import { PrismaService } from '../../common/prisma.service';
import { OrderStateService } from '../orders/order-state.service';
import { PaymentsService } from '../payments/payments.service';
import { AssignDto, CreateRiderDto, DeliveryStatusDto, ProofDto, ShiftDto } from './delivery.dto';

const RIDER_FLOW: Record<string, DeliveryStatus[]> = {
  ACCEPTED: ['ASSIGNED'],
  PICKED_UP: ['ACCEPTED'],
  OUT_FOR_DELIVERY: ['PICKED_UP'],
  FAILED: ['ACCEPTED', 'PICKED_UP', 'OUT_FOR_DELIVERY'],
};

@Injectable()
export class DeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: OrderStateService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ riders

  listRiders(actor: AuthContext, storeId?: string, status?: string) {
    if (storeId) assertWarehouseAccess(actor, storeId);
    return this.prisma.deliveryPartner.findMany({
      where: { organizationId: actor.organizationId, homeStoreId: storeId, status, ...warehouseScopeFilter(actor, 'homeStoreId') },
      include: { _count: { select: { assignments: true } } },
      orderBy: { fullName: 'asc' },
    });
  }

  async createRider(actor: AuthContext, dto: CreateRiderDto) {
    assertWarehouseAccess(actor, dto.homeStoreId);
    const r = await this.prisma.deliveryPartner.create({ data: { ...dto, organizationId: actor.organizationId } });
    await this.audit.record({ actor, action: 'rider.create', resourceType: 'delivery_partner', resourceId: r.id, after: dto });
    return r;
  }

  async setAvailability(actor: AuthContext, riderId: string, status: string) {
    const rider = await this.rider(actor, riderId);
    if (rider.status === 'ON_DELIVERY' && status !== 'SUSPENDED') throw Conflict('RIDER_BUSY', 'Rider is on a delivery');
    return this.prisma.deliveryPartner.update({ where: { id: riderId }, data: { status } });
  }

  async addShift(actor: AuthContext, riderId: string, dto: ShiftDto) {
    await this.rider(actor, riderId);
    if (new Date(dto.endsAt) <= new Date(dto.startsAt)) throw new DomainError('INVALID_SHIFT', 'Shift must end after it starts', 400);
    return this.prisma.riderShift.create({ data: { riderId, startsAt: new Date(dto.startsAt), endsAt: new Date(dto.endsAt) } });
  }

  async riderPerformance(actor: AuthContext, riderId: string) {
    await this.rider(actor, riderId);
    const [row] = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int AS assignments,
             COUNT(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered,
             COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
             AVG(EXTRACT(EPOCH FROM (delivered_at - picked_up_at)) / 60) FILTER (WHERE delivered_at IS NOT NULL)::float AS "avgRideMinutes"
      FROM delivery_assignments WHERE rider_id = ${riderId}::uuid`;
    return row;
  }

  // -------------------------------------------------------------- assignment

  async assign(actor: AuthContext, dto: AssignDto) {
    const order = await this.prisma.order.findFirst({ where: { id: dto.orderId, organizationId: actor.organizationId } });
    if (!order) throw NotFound('Order', dto.orderId);
    assertWarehouseAccess(actor, order.darkStoreId);
    if (order.status !== 'READY_FOR_DISPATCH') throw Conflict('ORDER_NOT_READY', `Order is ${order.status}`);

    return this.prisma.withRetry(async (tx) => {
      let riderId = dto.riderId;
      if (!riderId) {
        // Least deliveries today among available riders on shift at this store.
        const [pick] = await tx.$queryRaw<{ id: string }[]>`
          SELECT r.id FROM delivery_partners r
          LEFT JOIN delivery_assignments a ON a.rider_id = r.id AND a.assigned_at >= date_trunc('day', now())
          WHERE r.home_store_id = ${order.darkStoreId}::uuid AND r.status = 'AVAILABLE'
          GROUP BY r.id ORDER BY COUNT(a.id), r.id LIMIT 1`;
        if (!pick) throw new DomainError('NO_RIDER_AVAILABLE', 'No rider is available at this store', 409);
        riderId = pick.id;
      }
      // Claim the rider atomically so two dispatchers cannot double-book them.
      const claimed = await tx.deliveryPartner.updateMany({
        where: { id: riderId, organizationId: actor.organizationId, homeStoreId: order.darkStoreId, status: 'AVAILABLE' },
        data: { status: 'ON_DELIVERY' },
      });
      if (!claimed.count) throw Conflict('RIDER_UNAVAILABLE', 'Rider is not available at this store');
      const a = await tx.deliveryAssignment.create({
        data: { organizationId: actor.organizationId, orderId: order.id, riderId, darkStoreId: order.darkStoreId, events: { create: { status: 'ASSIGNED', actorId: actor.id } } },
      });
      await this.state.transition(tx, order.id, 'RIDER_ASSIGNED', actor, 'delivery.assigned');
      await this.audit.record({ actor, action: 'delivery.assign', resourceType: 'delivery_assignment', resourceId: a.id, after: { orderId: order.id, riderId } }, tx);
      return a;
    });
  }

  async list(actor: AuthContext, status?: string, storeId?: string) {
    const riderScope = await this.riderScope(actor);
    if (storeId) assertWarehouseAccess(actor, storeId);
    return this.prisma.deliveryAssignment.findMany({
      where: {
        organizationId: actor.organizationId, status: status as any, darkStoreId: storeId,
        ...(riderScope ? { riderId: riderScope } : warehouseScopeFilter(actor, 'darkStoreId')),
      },
      include: { rider: { select: { fullName: true, phone: true } }, proof: true },
      orderBy: { assignedAt: 'desc' },
      take: 200,
    });
  }

  async get(actor: AuthContext, id: string) {
    const a = await this.prisma.deliveryAssignment.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: { rider: true, events: { orderBy: { createdAt: 'asc' } }, proof: true },
    });
    if (!a) throw NotFound('Delivery', id);
    const riderScope = await this.riderScope(actor);
    if (riderScope && a.riderId !== riderScope) throw NotFound('Delivery', id);
    if (!riderScope) assertWarehouseAccess(actor, a.darkStoreId);
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: a.orderId },
      select: { orderNumber: true, addressSnapshot: true, paymentMethod: true, total: true, status: true },
    });
    return { ...a, order };
  }

  async updateStatus(actor: AuthContext, id: string, dto: DeliveryStatusDto) {
    const a = await this.get(actor, id);
    await this.assertRiderOrDispatcher(actor, a.riderId);
    if (!RIDER_FLOW[dto.status].includes(a.status)) throw Conflict('INVALID_DELIVERY_TRANSITION', `Cannot go from ${a.status} to ${dto.status}`);
    if (dto.status === 'FAILED' && !dto.note) throw new DomainError('REASON_REQUIRED', 'A failure reason is required', 400);

    return this.prisma.withRetry(async (tx) => {
      const { count } = await tx.deliveryAssignment.updateMany({
        where: { id, status: a.status, version: a.version },
        data: {
          status: dto.status, version: { increment: 1 },
          pickedUpAt: dto.status === 'PICKED_UP' ? new Date() : undefined,
          failureReason: dto.status === 'FAILED' ? dto.note : undefined,
        },
      });
      if (!count) throw Conflict('CONCURRENT_UPDATE', 'Delivery changed concurrently; reload');
      await tx.deliveryEvent.create({ data: { assignmentId: id, status: dto.status, latitude: dto.latitude, longitude: dto.longitude, note: dto.note, actorId: actor.id } });
      if (dto.status === 'PICKED_UP') await this.state.transition(tx, a.orderId, 'OUT_FOR_DELIVERY', actor, 'delivery.picked_up');
      if (dto.status === 'FAILED') {
        // Parcel returns to the store's dispatch queue for another attempt.
        const order = await tx.order.findUniqueOrThrow({ where: { id: a.orderId } });
        await this.state.transition(tx, a.orderId, 'READY_FOR_DISPATCH', actor, 'delivery.failed', dto.note, [order.status]);
        await tx.deliveryPartner.update({ where: { id: a.riderId }, data: { status: 'AVAILABLE' } });
      }
      return tx.deliveryAssignment.findUniqueOrThrow({ where: { id }, include: { events: true } });
    });
  }

  /** Delivery completes only with proof. OTP proof checks the code the customer holds. */
  async proofOfDelivery(actor: AuthContext, id: string, dto: ProofDto) {
    const a = await this.get(actor, id);
    await this.assertRiderOrDispatcher(actor, a.riderId);
    if (!['PICKED_UP', 'OUT_FOR_DELIVERY'].includes(a.status)) throw Conflict('INVALID_DELIVERY_TRANSITION', `Delivery is ${a.status}`);
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: a.orderId } });
    if (dto.method === 'OTP') {
      if (!dto.otp || dto.otp !== order.deliveryOtp) {
        await this.audit.record({ actor, action: 'delivery.otp_mismatch', resourceType: 'delivery_assignment', resourceId: id, outcome: 'FAILED' });
        throw new DomainError('OTP_MISMATCH', 'Delivery code does not match', 422);
      }
    } else if (dto.method === 'PHOTO' && !dto.photoKey) {
      throw new DomainError('PHOTO_REQUIRED', 'Upload the delivery photo first', 400);
    } else if (dto.method === 'SIGNATURE' && !dto.receiverName) {
      throw new DomainError('RECEIVER_REQUIRED', 'Receiver name is required', 400);
    }

    return this.prisma.withRetry(async (tx) => {
      const { count } = await tx.deliveryAssignment.updateMany({
        where: { id, status: { in: ['PICKED_UP', 'OUT_FOR_DELIVERY'] } },
        data: { status: 'DELIVERED', deliveredAt: new Date(), version: { increment: 1 } },
      });
      if (!count) throw Conflict('ALREADY_COMPLETED', 'Delivery already completed');
      await tx.proofOfDelivery.create({
        data: { assignmentId: id, method: dto.method, otpVerified: dto.method === 'OTP', photoKey: dto.photoKey, receiverName: dto.receiverName },
      });
      await tx.deliveryEvent.create({ data: { assignmentId: id, status: 'DELIVERED', latitude: dto.latitude, longitude: dto.longitude, actorId: actor.id } });
      await this.state.transition(tx, a.orderId, 'DELIVERED', actor, 'delivery.completed');
      await this.payments.markCodCollected(tx, a.orderId);
      await tx.deliveryPartner.update({ where: { id: a.riderId }, data: { status: 'AVAILABLE' } });
      await tx.order.update({ where: { id: a.orderId }, data: { deliveryOtp: null } });
      return { deliveryId: id, status: 'DELIVERED' };
    });
  }

  private async rider(actor: AuthContext, id: string) {
    const r = await this.prisma.deliveryPartner.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!r) throw NotFound('Rider', id);
    assertWarehouseAccess(actor, r.homeStoreId);
    return r;
  }

  /** Riders (no delivery.manage) only see their own assignments. */
  private async riderScope(actor: AuthContext): Promise<string | null> {
    if (hasPermission(actor, PERMISSIONS.DELIVERY_MANAGE) || hasPermission(actor, PERMISSIONS.DISPATCH)) return null;
    const r = await this.prisma.deliveryPartner.findUnique({ where: { userId: actor.id } });
    if (!r) throw Forbidden('Your account is not linked to a delivery partner profile');
    return r.id;
  }

  private async assertRiderOrDispatcher(actor: AuthContext, riderId: string) {
    const scope = await this.riderScope(actor);
    if (scope && scope !== riderId) throw Forbidden('This delivery is assigned to another rider');
  }
}
