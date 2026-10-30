import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { AuthContext } from '../../common/auth-context';
import { CurrentActor, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import { IntelligenceService } from './intelligence.service';

class RunForecastDto {
  @IsUUID() warehouseId: string;
  @IsOptional() @IsInt() @Min(1) @Max(28) horizonDays?: number;
}

class SiteDto {
  @IsUUID() warehouseId: string;
}

class AcceptDto {
  @IsArray() @ArrayMinSize(1) @IsUUID('all', { each: true }) ids: string[];
}

@ApiTags('intelligence')
@ApiBearerAuth()
@Controller('intelligence')
export class IntelligenceController {
  constructor(private readonly svc: IntelligenceService) {}

  @Get('status') @RequirePermissions(P.AI_READ)
  status() { return this.svc.engineStatus(); }

  @Post('forecasts/run') @RequirePermissions(P.AI_READ)
  run(@CurrentActor() a: AuthContext, @Body() dto: RunForecastDto) { return this.svc.runForecast(a, dto.warehouseId, dto.horizonDays ?? 7); }

  @Get('forecasts') @RequirePermissions(P.AI_READ)
  forecasts(@CurrentActor() a: AuthContext, @Query('warehouseId', ParseUUIDPipe) wid: string) { return this.svc.latestForecasts(a, wid); }

  @Post('replenishment/run') @RequirePermissions(P.INVENTORY_TRANSFER)
  replenish(@CurrentActor() a: AuthContext, @Body() dto: SiteDto) { return this.svc.runReplenishment(a, dto.warehouseId); }

  @Get('replenishment') @RequirePermissions(P.INVENTORY_READ)
  recs(@CurrentActor() a: AuthContext, @Query('warehouseId') wid?: string) { return this.svc.listRecommendations(a, wid); }

  @Post('replenishment/accept') @RequirePermissions(P.INVENTORY_TRANSFER)
  accept(@CurrentActor() a: AuthContext, @Body() dto: AcceptDto) { return this.svc.acceptRecommendations(a, dto.ids); }

  @Get('anomalies/:warehouseId') @RequirePermissions(P.AI_READ)
  anomalies(@CurrentActor() a: AuthContext, @Param('warehouseId', ParseUUIDPipe) wid: string) { return this.svc.anomalies(a, wid); }
}
