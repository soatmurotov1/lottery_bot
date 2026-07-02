// src/lottery/lottery.module.ts

import { Module } from '@nestjs/common';
import { LotteryService } from './lottery.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [LotteryService],
  exports: [LotteryService],
})
export class LotteryModule {}