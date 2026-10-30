import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthContext } from '../../common/auth-context';
import { CurrentActor, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import { CompletePackDto, CompletePickDto, CreatePickingTaskDto, CreateWaveDto, ScanDto, TaskQuery } from './fulfillment.dto';
import { FulfillmentService } from './fulfillment.service';

@ApiTags('fulfillment')
@ApiBearerAuth()
@Controller()
export class FulfillmentController {
  constructor(private readonly svc: FulfillmentService) {}

  @Post('picking-tasks') @RequirePermissions(P.PICKING)
  create(@CurrentActor() a: AuthContext, @Body() dto: CreatePickingTaskDto) { return this.svc.createPickingTask(a, dto.orderId); }

  @Post('picking-waves') @RequirePermissions(P.DISPATCH)
  wave(@CurrentActor() a: AuthContext, @Body() dto: CreateWaveDto) { return this.svc.createWave(a, dto); }

  @Get('picking-waves/:id/route') @RequirePermissions(P.PICKING)
  route(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.waveRoute(a, id); }

  @Get('picking-tasks') @RequirePermissions(P.PICKING)
  list(@CurrentActor() a: AuthContext, @Query() q: TaskQuery) { return this.svc.listTasks(a, q); }

  @Get('picking-tasks/:id') @RequirePermissions(P.PICKING)
  get(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.getTask(a, id); }

  @Post('picking-tasks/:id/claim') @RequirePermissions(P.PICKING)
  claim(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.claim(a, id); }

  @Post('picking-tasks/:id/scan') @RequirePermissions(P.PICKING)
  scan(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ScanDto) { return this.svc.scan(a, id, dto); }

  @Post('picking-tasks/:id/complete') @RequirePermissions(P.PICKING)
  complete(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CompletePickDto) { return this.svc.completePicking(a, id, dto); }

  @Get('packing-tasks') @RequirePermissions(P.PACKING)
  packing(@CurrentActor() a: AuthContext, @Query() q: TaskQuery) { return this.svc.listPacking(a, q); }

  @Post('packing-tasks') @RequirePermissions(P.PACKING)
  createPacking(@CurrentActor() a: AuthContext, @Body() dto: CreatePickingTaskDto) { return this.svc.createPacking(a, dto.orderId); }

  @Post('packing-tasks/:id/complete') @RequirePermissions(P.PACKING)
  pack(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CompletePackDto) { return this.svc.completePacking(a, id, dto); }

  @Get('packing-tasks/:id/label') @RequirePermissions(P.PACKING)
  label(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.packingLabel(a, id); }
}
