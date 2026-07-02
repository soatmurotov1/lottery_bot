// src/app.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramModule } from './telegram/telegram.module';
import { LotteryModule } from './lottery/lottery.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    LotteryModule,
    TelegramModule,
  ],
})
export class AppModule {}