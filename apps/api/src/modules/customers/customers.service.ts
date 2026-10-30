import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthContext } from '../../common/auth-context';
import { DomainError, NotFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { TokenService } from '../../common/token.service';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../auth/password';
import { AddressDto, CustomerLoginDto, RegisterCustomerDto, UpdateProfileDto } from './customers.dto';

const PROFILE = { id: true, fullName: true, phone: true, email: true, status: true, createdAt: true } as const;

@Injectable()
export class CustomersService {
  private readonly maxFailed = Number(process.env.LOGIN_MAX_FAILED_ATTEMPTS ?? 5);
  private readonly lockMinutes = Number(process.env.LOGIN_LOCKOUT_MINUTES ?? 15);

  constructor(private readonly prisma: PrismaService, private readonly tokens: TokenService) {}

  async resolveOrg(code?: string) {
    const orgCode = code ?? process.env.STOREFRONT_ORG_CODE;
    const org = orgCode
      ? await this.prisma.organization.findUnique({ where: { code: orgCode } })
      : await this.prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!org) throw new DomainError('UNKNOWN_ORGANIZATION', 'Storefront organization not found', 404);
    return org;
  }

  async register(dto: RegisterCustomerDto) {
    const org = await this.resolveOrg(dto.organizationCode);
    const c = await this.prisma.customer.create({
      data: { organizationId: org.id, fullName: dto.fullName, phone: dto.phone, email: dto.email?.toLowerCase(), passwordHash: await hashPassword(dto.password) },
      select: PROFILE,
    });
    return { customer: c, ...this.token(c.id, org.id) };
  }

  async login(dto: CustomerLoginDto) {
    const org = await this.resolveOrg(dto.organizationCode);
    const id = dto.identifier.trim();
    const c = await this.prisma.customer.findFirst({ where: { organizationId: org.id, OR: [{ phone: id }, { email: id.toLowerCase() }] } });
    if (!c) {
      await burnPasswordCheck(dto.password);
      throw new UnauthorizedException('Invalid credentials');
    }
    if (c.lockedUntil && c.lockedUntil > new Date()) throw new DomainError('ACCOUNT_LOCKED', 'Too many failed attempts; try again later', 423);
    if (!(await verifyPassword(dto.password, c.passwordHash)) || c.status !== 'ACTIVE') {
      const failed = c.failedLoginCount + 1;
      await this.prisma.customer.update({
        where: { id: c.id },
        data: failed >= this.maxFailed ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + this.lockMinutes * 60_000) } : { failedLoginCount: failed },
      });
      throw new UnauthorizedException('Invalid credentials');
    }
    await this.prisma.customer.update({ where: { id: c.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    return this.token(c.id, org.id);
  }

  profile(actor: AuthContext) {
    return this.prisma.customer.findUniqueOrThrow({ where: { id: actor.id }, select: { ...PROFILE, addresses: { orderBy: { createdAt: 'asc' } } } });
  }

  updateProfile(actor: AuthContext, dto: UpdateProfileDto) {
    return this.prisma.customer.update({ where: { id: actor.id }, data: { ...dto, email: dto.email?.toLowerCase() }, select: PROFILE });
  }

  async addAddress(actor: AuthContext, dto: AddressDto) {
    return this.prisma.$transaction(async (tx) => {
      const count = await tx.customerAddress.count({ where: { customerId: actor.id } });
      if (count >= 20) throw new DomainError('ADDRESS_LIMIT', 'At most 20 saved addresses', 400);
      const makeDefault = dto.isDefault || count === 0;
      if (makeDefault) await tx.customerAddress.updateMany({ where: { customerId: actor.id }, data: { isDefault: false } });
      return tx.customerAddress.create({ data: { ...dto, customerId: actor.id, isDefault: makeDefault } });
    });
  }

  async updateAddress(actor: AuthContext, id: string, dto: AddressDto) {
    await this.address(actor, id);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await tx.customerAddress.updateMany({ where: { customerId: actor.id }, data: { isDefault: false } });
      return tx.customerAddress.update({ where: { id }, data: dto });
    });
  }

  async deleteAddress(actor: AuthContext, id: string) {
    await this.address(actor, id);
    await this.prisma.customerAddress.delete({ where: { id } });
  }

  async address(actor: AuthContext, id: string) {
    const a = await this.prisma.customerAddress.findFirst({ where: { id, customerId: actor.id } });
    if (!a) throw NotFound('Address', id);
    return a;
  }

  /**
   * Privacy retention: customers with no account or order activity for the organization's
   * `privacy.customer_retention_days` are anonymised. Orders keep their own address snapshot.
   */
  async anonymiseInactive() {
    const settings = await this.prisma.systemSetting.findMany({ where: { key: 'privacy.customer_retention_days' } });
    let anonymised = 0;
    for (const s of settings) {
      const cutoff = new Date(Date.now() - Number(s.value) * 86_400_000);
      const stale = await this.prisma.customer.findMany({
        where: {
          organizationId: s.organizationId!, status: { not: 'ANONYMISED' }, updatedAt: { lt: cutoff },
          orders: { none: { placedAt: { gte: cutoff } } },
        },
        select: { id: true },
        take: 500,
      });
      for (const c of stale) {
        await this.prisma.$transaction([
          this.prisma.customerAddress.deleteMany({ where: { customerId: c.id } }),
          this.prisma.cart.deleteMany({ where: { customerId: c.id } }),
          this.prisma.customer.update({
            where: { id: c.id },
            data: { fullName: 'Anonymised customer', email: null, phone: `anon-${c.id}`, passwordHash: '!', status: 'ANONYMISED' },
          }),
        ]);
        anonymised++;
      }
    }
    return { anonymised };
  }

  private token(customerId: string, organizationId: string) {
    return {
      accessToken: this.tokens.signAccess({ sub: customerId, org: organizationId, kind: 'customer' }),
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtl,
    };
  }
}
