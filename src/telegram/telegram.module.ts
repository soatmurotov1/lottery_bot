import { Module } from '@nestjs/common';
import { TelegrafModule } from 'nestjs-telegraf';
import { TelegramService } from './telegram.service';
import { TelegramUpdate } from './telegram.update';
import { LotteryModule } from '../lottery/lottery.module';
import { config } from '../config/config';

import LocalSession from 'telegraf-session-local';
const localSession = new LocalSession({ database: 'session_db.json' });

@Module({
  imports: [
    TelegrafModule.forRoot({
      token: config.telegram.token,
      middlewares: [localSession.middleware()],
    }),
    LotteryModule,
  ],
  providers: [TelegramService, TelegramUpdate],
})
export class TelegramModule {}



