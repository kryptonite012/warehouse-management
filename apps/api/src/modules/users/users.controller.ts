import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthContext } from '../../common/auth-context';
import { CurrentActor, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import { CreateUserDto, UpdateUserDto, UpsertRoleDto, UserListQuery } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users') @RequirePermissions(P.USERS_READ)
  list(@CurrentActor() a: AuthContext, @Query() q: UserListQuery) {
    return this.users.list(a, q);
  }

  @Post('users') @RequirePermissions(P.USERS_MANAGE)
  create(@CurrentActor() a: AuthContext, @Body() dto: CreateUserDto) {
    return this.users.create(a, dto);
  }

  @Get('users/:id') @RequirePermissions(P.USERS_READ)
  get(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(a, id);
  }

  @Patch('users/:id') @RequirePermissions(P.USERS_MANAGE)
  update(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(a, id, dto);
  }

  @Delete('users/:id') @RequirePermissions(P.USERS_MANAGE) @HttpCode(204)
  remove(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.remove(a, id);
  }

  @Get('roles') @RequirePermissions(P.USERS_READ)
  roles(@CurrentActor() a: AuthContext) {
    return this.users.listRoles(a);
  }

  @Get('permissions') @RequirePermissions(P.USERS_READ)
  permissions() {
    return this.users.listPermissions();
  }

  @Put('roles') @RequirePermissions(P.ROLES_MANAGE)
  upsertRole(@CurrentActor() a: AuthContext, @Body() dto: UpsertRoleDto) {
    return this.users.upsertRole(a, dto);
  }
}
