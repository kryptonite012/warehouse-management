import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { PrismaService } from './prisma.service';
import { TokenService } from './token.service';
import { StorageService } from './storage.service';
import { ActorService } from './actor.service';

@Global()
@Module({
  providers: [PrismaService, AuditService, TokenService, StorageService, ActorService],
  exports: [PrismaService, AuditService, TokenService, StorageService, ActorService],
})
export class CommonModule {}
