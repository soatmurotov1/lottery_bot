import * as dotenv from 'dotenv';
dotenv.config(); 
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config'; 
import { Pool } from 'pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private pool: Pool;

  constructor(private configService: ConfigService) {
    const connectionString = configService.get<string>('DATABASE_URL');

    const pool = new Pool({ connectionString });
    const adapter = new PrismaPg(pool);

    super({ adapter });
    this.pool = pool;
  }

  async onModuleInit() {
    await this.$connect();
    console.log("prisma connect");
  }

  async onModuleDestroy() {
    await this.$disconnect()
    console.log("Prisma connnect error")
    await this.pool.end();
  }
}