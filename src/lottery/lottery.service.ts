// src/lottery/lottery.service.ts

import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SlotStatus, PaymentStatus, GameStatus } from '@prisma/client';
import { config } from '../config/config';
import { BookSlotDto, ConfirmPaymentDto } from './dto/intex';

@Injectable()
export class LotteryService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Admin boshqaruvi ─────────────────────────────────────────────────────

  async isAdmin(telegramId: string): Promise<boolean> {
    // Config'dagi asosiy admin ham admin hisoblanadi
    if (parseInt(telegramId) === config.telegram.adminId) return true;
    const admin = await this.prisma.admin.findUnique({ where: { telegramId } });
    return !!admin;
  }

  async getAllAdmins() {
    return this.prisma.admin.findMany({ orderBy: { addedAt: 'asc' } });
  }

  async addAdmin(telegramId: string) {
    return this.prisma.admin.create({ data: { telegramId } });
  }

  async removeAdmin(telegramId: string) {
    await this.prisma.admin.delete({ where: { telegramId } });
  }

  // ─── O'yin boshqaruvi ─────────────────────────────────────────────────────

  async getActiveGame() {
    return this.prisma.game.findFirst({
      where: { status: { in: [GameStatus.WAITING, GameStatus.ACTIVE] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Oxirgi yaratilgan o'yin (faol yoki tugagan) — "Foydalanuvchi Ma'lumoti" uchun
  async getLastGame() {
    return this.prisma.game.findFirst({
      orderBy: { createdAt: 'desc' },
    });
  }

  async createGame() {
    // Avvalgi faol o'yin bormi tekshirish
    const existing = await this.getActiveGame();
    if (existing) throw new BadRequestException('Faol o\'yin allaqachon mavjud!');

    // Slotlarni yaratish
    const game = await this.prisma.game.create({
      data: { status: GameStatus.ACTIVE, startedAt: new Date() },
    });

    // Barcha slotlarni bo'sh holda yaratish
    const slotData = Array.from({ length: config.game.totalSlots }, (_, i) => ({
      number: i + 1,
      gameId: game.id,
      status: SlotStatus.AVAILABLE,
    }));

    await this.prisma.slot.createMany({ data: slotData });

    return game;
  }

  async finishGame(gameId: number): Promise<{
    winnerSlot: number;
    winnerUser: any;
    allParticipants: any[];
  }> {
    const game = await this.prisma.game.findUnique({ where: { id: gameId } });
    if (!game) throw new BadRequestException('O\'yin topilmadi!');
    if (game.status === GameStatus.FINISHED) {
      throw new BadRequestException('Bu o\'yin allaqachon tugagan!');
    }

    const confirmedSlots = await this.prisma.slot.findMany({
      where: { gameId, status: SlotStatus.CONFIRMED },
      include: { user: true },
    });

    if (!confirmedSlots.length) {
      throw new BadRequestException('Hech qanday tasdiqlangan joy yo\'q!');
    }

    // Random g'olib tanlash
    const winner = confirmedSlots[Math.floor(Math.random() * confirmedSlots.length)];

    // O'yinni tugatish
    await this.prisma.game.update({
      where: { id: gameId },
      data: {
        status: GameStatus.FINISHED,
        winnerSlot: winner.number,
        finishedAt: new Date(),
      },
    });

    return {
      winnerSlot: winner.number,
      winnerUser: winner.user,
      allParticipants: confirmedSlots,
    };
  }

  async areAllSlotsFull(gameId: number): Promise<boolean> {
    const confirmedCount = await this.prisma.slot.count({
      where: { gameId, status: SlotStatus.CONFIRMED },
    });
    return confirmedCount >= config.game.totalSlots;
  }

  // ─── Joylar ───────────────────────────────────────────────────────────────

  async getAllSlots(gameId: number) {
    return this.prisma.slot.findMany({
      where: { gameId },
      orderBy: { number: 'asc' },
      include: { user: true, payment: true },
    });
  }

  async getAvailableSlots(gameId: number): Promise<number[]> {
    const slots = await this.prisma.slot.findMany({
      where: { gameId, status: SlotStatus.AVAILABLE },
      select: { number: true },
      orderBy: { number: 'asc' },
    });
    return slots.map((s) => s.number);
  }

  async getSlotsMap(gameId: number): Promise<string> {
    const slots = await this.getAllSlots(gameId);
    const total = config.game.totalSlots;
    const slotMap = new Map(slots.map((s) => [s.number, s.status]));

    let map = `🎰 <b>LOTARIYA O'YIN JOYLAR</b> 🎰\n\n`;
    map += `Jami: ${total} ta joy | Narxi: ${config.payment.ticketPrice.toLocaleString()} so'm\n\n`;

    const rows: string[] = [];
    let row: string[] = [];

    for (let i = 1; i <= total; i++) {
      const status = slotMap.get(i);
      if (status === SlotStatus.CONFIRMED) row.push(`✅${i}`);
      else if (status === SlotStatus.PENDING) row.push(`⏳${i}`);
      else row.push(`⬜${i}`);

      if (row.length === 5) {
        rows.push(row.join(' | '));
        row = [];
      }
    }
    if (row.length) rows.push(row.join(' | '));

    map += rows.join('\n');
    map += '\n\n✅ Tasdiqlangan  ⏳ Kutilmoqda  ⬜ Bo\'sh';

    // FIX: avval "free = total - slots.length" edi — bu noto'g'ri edi,
    // chunki slots ro'yxatida AVAILABLE statusdagi slotlar ham bor edi
    // (ular gameId bo'yicha DB'da allaqachon mavjud), shuning uchun
    // "total - slots.length" har doim 0 yoki manfiy chiqishi mumkin edi.
    // To'g'ri usul — slots ichidan status bo'yicha sanash:
    const confirmed = slots.filter((s) => s.status === SlotStatus.CONFIRMED).length;
    const pending = slots.filter((s) => s.status === SlotStatus.PENDING).length;
    const free = slots.filter((s) => s.status === SlotStatus.AVAILABLE).length;

    map += `\n\n✅ Tasdiqlangan: ${confirmed}\n⏳ Kutilmoqda: ${pending}\n⬜ Bo\'sh: ${free}`;
    return map;
  }

  // ─── Foydalanuvchi ────────────────────────────────────────────────────────

  async upsertUser(telegramId: string, username: string | undefined, fullName: string) {
    return this.prisma.user.upsert({
      where: { telegramId },
      update: { username, fullName },
      create: { telegramId, username, fullName },
    });
  }

  // ─── Bron qilish ─────────────────────────────────────────────────────────

  async bookSlot(dto: BookSlotDto & { gameId: number }): Promise<{ slot: any; user: any }> {
    const { slotNumber, telegramId, username, fullName, gameId } = dto;

    const user = await this.upsertUser(telegramId, username, fullName);

    // Joy mavjudligini tekshirish (shu o'yin ichida)
    const existing = await this.prisma.slot.findUnique({
      where: { number_gameId: { number: slotNumber, gameId } },
    });

    if (!existing) throw new BadRequestException('Joy topilmadi!');
    if (existing.status !== SlotStatus.AVAILABLE) {
      throw new BadRequestException('Bu joy allaqachon band!');
    }

    const slot = await this.prisma.slot.update({
      where: { number_gameId: { number: slotNumber, gameId } },
      data: {
        status: SlotStatus.PENDING,
        userId: user.id,
        bookedAt: new Date(),
      },
    });

    return { slot, user };
  }

  // ─── Bronni bekor qilish (timeout yoki foydalanuvchi) ────────────────────

  async cancelSlot(slotNumber: number, telegramId: string, gameId: number): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) return;

    const slot = await this.prisma.slot.findUnique({
      where: { number_gameId: { number: slotNumber, gameId } },
    });

    if (!slot || slot.userId !== user.id || slot.status !== SlotStatus.PENDING) return;

    // Pending to'lovni ham o'chirish (agar yuborilgan bo'lsa)
    await this.prisma.payment
      .deleteMany({ where: { slotId: slot.id, status: PaymentStatus.PENDING } })
      .catch(() => {});

    await this.prisma.slot.update({
      where: { number_gameId: { number: slotNumber, gameId } },
      data: { status: SlotStatus.AVAILABLE, userId: null, bookedAt: null },
    });
  }

  // ─── Slot hali PENDING holatida ekanligini tekshirish (timeout uchun) ────
  // Bron qilingach setTimeout orqali avtomatik bekor qilish ishga tushadi.
  // Lekin agar shu vaqt ichida admin to'lovni tasdiqlasa (CONFIRMED bo'lsa),
  // setTimeout baribir "bekor qilindi" deb yuborib yuborardi.
  // Shu metod orqali timeout ishga tushganda holat haqiqatda PENDING
  // ekanligi tekshiriladi, aks holda hech narsa qilinmaydi.
  async isSlotStillPending(slotNumber: number, telegramId: string, gameId: number): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) return false;

    const slot = await this.prisma.slot.findUnique({
      where: { number_gameId: { number: slotNumber, gameId } },
    });

    return !!slot && slot.userId === user.id && slot.status === SlotStatus.PENDING;
  }

  // ─── Chekni saqlash ───────────────────────────────────────────────────────

  async savePaymentReceipt(slotNumber: number, telegramId: string, fileId: string) {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) throw new BadRequestException('Foydalanuvchi topilmadi');

    const game = await this.getActiveGame();
    if (!game) throw new BadRequestException('Faol o\'yin topilmadi');

    const slot = await this.prisma.slot.findUnique({
      where: { number_gameId: { number: slotNumber, gameId: game.id } },
    });
    if (!slot) throw new BadRequestException('Joy topilmadi');
    if (slot.userId !== user.id) throw new BadRequestException('Bu joy sizniki emas!');

    const payment = await this.prisma.payment.upsert({
      where: { slotId: slot.id },
      update: { fileId, status: PaymentStatus.PENDING },
      create: {
        userId: user.id,
        slotId: slot.id,
        gameId: game.id,
        fileId,
        amount: config.payment.ticketPrice,
        status: PaymentStatus.PENDING,
      },
    });

    return { payment, slot, user, game };
  }

  // ─── Admin: tasdiqlash/rad etish ─────────────────────────────────────────

  async confirmPayment(dto: ConfirmPaymentDto & { gameId: number }): Promise<{
    slot: any;
    user: any;
    allFull: boolean;
  }> {
    const { slotNumber, userId, gameId, approved } = dto;

    const slot = await this.prisma.slot.findUnique({
      where: { number_gameId: { number: slotNumber, gameId } },
      include: { user: true, payment: true },
    });
    if (!slot) throw new BadRequestException('Joy topilmadi');

    // userId mosligini tekshirish
    if (slot.user?.telegramId !== userId.toString() && slot.userId !== userId) {
      // userId int yoki string kelishi mumkin, ikkalasini ham qabul qilamiz
    }

    if (approved) {
      await this.prisma.slot.update({
        where: { number_gameId: { number: slotNumber, gameId } },
        data: { status: SlotStatus.CONFIRMED },
      });
      if (slot.payment) {
        await this.prisma.payment.update({
          where: { slotId: slot.id },
          data: { status: PaymentStatus.APPROVED },
        });
      }
    } else {
      if (slot.payment) {
        await this.prisma.payment.update({
          where: { slotId: slot.id },
          data: { status: PaymentStatus.REJECTED },
        });
      }
      await this.prisma.slot.update({
        where: { number_gameId: { number: slotNumber, gameId } },
        data: { status: SlotStatus.AVAILABLE, userId: null, bookedAt: null },
      });
    }

    const allFull = await this.areAllSlotsFull(gameId);

    return { slot, user: slot.user, allFull };
  }

  // ─── Statistika ───────────────────────────────────────────────────────────

  async getStats(gameId?: number) {
    const whereGame = gameId ? { gameId } : {};

    const [confirmed, pending, available, lastGame] = await Promise.all([
      this.prisma.slot.count({ where: { ...whereGame, status: SlotStatus.CONFIRMED } }),
      this.prisma.slot.count({ where: { ...whereGame, status: SlotStatus.PENDING } }),
      this.prisma.slot.count({ where: { ...whereGame, status: SlotStatus.AVAILABLE } }),
      this.prisma.game.findFirst({
        where: { status: GameStatus.FINISHED },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      confirmed,
      pending,
      available,
      lastGame,
      ticketPrice: config.payment.ticketPrice,
    };
  }

  // ─── Reset (joriy o'yinni tozalash) ──────────────────────────────────────

  async resetGame() {
    const game = await this.getActiveGame();
    if (!game) return;

    // Faqat joriy o'yin slotlari va to'lovlarini o'chirish
    // Payment arxivi saqlanadi (boshqa o'yinlar uchun)
    await this.prisma.payment.deleteMany({ where: { gameId: game.id } });
    await this.prisma.slot.deleteMany({ where: { gameId: game.id } });
    await this.prisma.game.delete({ where: { id: game.id } });
  }
}