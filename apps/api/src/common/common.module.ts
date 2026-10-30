import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { PrismaService } from './prisma.service';
import { TokenService } from './token.service';

@Global()
@Module({
  providers: [PrismaService, AuditService, TokenService],
  exports: [PrismaService, AuditService, TokenService],
})
export class CommonModule {}
