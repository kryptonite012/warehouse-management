import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { PrismaService } from './prisma.service';
import { TokenService } from './token.service';
import { StorageService } from './storage.service';

@Global()
@Module({
  providers: [PrismaService, AuditService, TokenService, StorageService],
  exports: [PrismaService, AuditService, TokenService, StorageService],
})
export class CommonModule {}
