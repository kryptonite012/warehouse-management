import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';
import { AuditService } from '../../common/audit.service';
import { AuthContext } from '../../common/auth-context';
import { CurrentActor, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import { PrismaService } from '../../common/prisma.service';

class CreateUnitDto {
  @Matches(/^[A-Z0-9-]{2,20}$/) code: string;
  @IsString() @Length(2, 120) name: string;
}

@ApiTags('organization')
@ApiBearerAuth()
@Controller('organization')
export class OrganizationController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get()
  get(@CurrentActor() a: AuthContext) {
    return this.prisma.organization.findUniqueOrThrow({
      where: { id: a.organizationId },
      include: { businessUnits: true, regions: true },
    });
  }

  @Post('regions') @RequirePermissions(P.ORG_MANAGE)
  async createRegion(@CurrentActor() a: AuthContext, @Body() dto: CreateUnitDto) {
    const r = await this.prisma.region.create({ data: { organizationId: a.organizationId, ...dto } });
    await this.audit.record({ actor: a, action: 'region.create', resourceType: 'region', resourceId: r.id, after: dto });
    return r;
  }

  @Post('business-units') @RequirePermissions(P.ORG_MANAGE)
  async createUnit(@CurrentActor() a: AuthContext, @Body() dto: CreateUnitDto) {
    const r = await this.prisma.businessUnit.create({ data: { organizationId: a.organizationId, ...dto } });
    await this.audit.record({ actor: a, action: 'business_unit.create', resourceType: 'business_unit', resourceId: r.id, after: dto });
    return r;
  }
}
