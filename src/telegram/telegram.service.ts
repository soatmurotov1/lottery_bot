// src/telegram/telegram.service.ts

import { Injectable } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { PrismaService } from '../prisma/prisma.service';
import { GameStatus } from '@prisma/client';
import { config } from '../config/config';

// ─── Dynamic settings ─────────────────────────────────────────────────────────
export interface GameSettings {
  ticketPrice: number;
  cardNumber: string;
  cardHolder: string;
  deadlineMinutes: number;
}

let runtimeSettings: GameSettings = {
  ticketPrice: config.payment.ticketPrice,
  cardNumber: config.payment.cardNumber,
  cardHolder: config.payment.cardHolder,
  deadlineMinutes: config.payment.deadlineMinutes ?? 30,
};

export function getSettings(): GameSettings {
  return { ...runtimeSettings };
}

export function updateSettings(patch: Partial<GameSettings>): GameSettings {
  runtimeSettings = { ...runtimeSettings, ...patch };
  return { ...runtimeSettings };
}

@Injectable()
export class TelegramService {
  private readonly adminPaymentMessages = new Map<
    string,
    Array<{ chatId: string; messageId: number }>
  >();

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Asosiy menyu ─────────────────────────────────────────────────────────
  getMainMenu(isAdmin = false, hasActiveGame = true): any {
    const userButtons = hasActiveGame
      ? [
          [{ text: '🎟 Joyni Bron Qilish' }, { text: "👀 Joylarni Ko'rish" }],
          [{ text: "📞 Admin bilan Bog'lanish" }],
          [{ text: 'ℹ️ Bot Haqida' }],
        ]
      : [
          [{ text: "👀 Joylarni Ko'rish" }],
          [{ text: "📞 Admin bilan Bog'lanish" }],
          [{ text: 'ℹ️ Bot Haqida' }],
        ];

    const adminButtons = isAdmin
      ? [
          [{ text: "🎮 O'yinni Boshlash" }, { text: "🏁 O'yinni Tugatish" }],
          [{ text: '📢 Xabar Tarqatish' }, { text: '👥 Adminlar' }],
          [{ text: '⚙️ Sozlamalar' }, { text: "👤 Foydalanuvchi Ma'lumoti" }],
          [{ text: "📜 O'yin Tarixi" }],
        ]
      : [];

    return {
      keyboard: [...adminButtons, ...userButtons],
      resize_keyboard: true,
    };
  }

  getContactAdminButton(): any {
    return {
      inline_keyboard: [
        [
          {
            text: "📞 Admin bilan Bog'lanish",
            url: `https://t.me/${config.telegram.adminUsername}`,
          },
        ],
      ],
    };
  }

  getConfirmBroadcastKeyboard(): any {
    return {
      inline_keyboard: [
        [
          { text: '✅ Ha, Yuborish', callback_data: 'broadcast_confirm' },
          { text: '❌ Bekor Qilish', callback_data: 'broadcast_cancel' },
        ],
      ],
    };
  }

  // ─── Admin sozlamalar menyusi ─────────────────────────────────────────────
  getSettingsMenu(): any {
    return {
      inline_keyboard: [
        [
          {
            text: "💰 Bilet narxini o'zgartirish",
            callback_data: 'settings_price',
          },
        ],
        [
          {
            text: "💳 Karta raqamini o'zgartirish",
            callback_data: 'settings_card',
          },
        ],
        [
          {
            text: "👤 Karta egasini o'zgartirish",
            callback_data: 'settings_holder',
          },
        ],
        [
          {
            text: "⏰ To'lov vaqtini o'zgartirish",
            callback_data: 'settings_deadline',
          },
        ],
        [{ text: '🔙 Orqaga', callback_data: 'settings_back' }],
      ],
    };
  }

  getSettingsText(): string {
    const s = getSettings();
    return (
      `⚙️ <b>JORIY SOZLAMALAR</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 Bilet narxi: <b>${s.ticketPrice.toLocaleString()} so'm</b>\n` +
      `💳 Karta raqami: <code>${s.cardNumber}</code>\n` +
      `👤 Karta egasi: <b>${s.cardHolder}</b>\n` +
      `⏰ To'lov muddati: <b>${s.deadlineMinutes} daqiqa</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━`
    );
  }

  // ─── Adminlar menyusi ─────────────────────────────────────────────────────
  getAdminsMenu(): any {
    return {
      inline_keyboard: [
        [{ text: "➕ Admin qo'shish", callback_data: 'admin_add' }],
        [{ text: "➖ Admin o'chirish", callback_data: 'admin_remove' }],
        [{ text: '🔙 Orqaga', callback_data: 'admin_back' }],
      ],
    };
  }

  // ─── Barcha user telegramId larini olish ─────────────────────────────────
  async getAllUserTelegramIds(): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      select: { telegramId: true },
    });
    return users.map((u) => u.telegramId);
  }

  // ─── Broadcast ───────────────────────────────────────────────────────────
  async broadcastMessage(
    text: string,
  ): Promise<{ sent: number; failed: number }> {
    const telegramIds = await this.getAllUserTelegramIds();
    let sent = 0;
    let failed = 0;
    for (const id of telegramIds) {
      try {
        await this.bot.telegram.sendMessage(id, text, { parse_mode: 'HTML' });
        sent++;
      } catch {
        failed++;
      }
    }
    return { sent, failed };
  }

  // ─── O'yin boshlanganda barcha userlarga xabar ───────────────────────────
  async notifyGameStarted(totalSlots: number): Promise<void> {
    const telegramIds = await this.getAllUserTelegramIds();
    const s = getSettings();

    const message =
      `🎰 <b>YANGI LOTARIYA O'YIN BOSHLANDI!</b> 🎰\n\n` +
      `🎟 Jami joy: <b>${totalSlots} ta</b>\n` +
      `💰 Bilet narxi: <b>${s.ticketPrice.toLocaleString()} so'm</b>\n\n` +
      `⚡️ Tez bo'ling, joylar cheklangan!\n\n` +
      `👇 Ishtirok etish uchun quyidagi tugmani bosing:`;

    for (const id of telegramIds) {
      try {
        await this.bot.telegram.sendMessage(id, message, {
          parse_mode: 'HTML',
          reply_markup: {
            keyboard: [[{ text: '🎟 Joyni Bron Qilish' }]],
            resize_keyboard: true,
          },
        });
      } catch {
        /* user botni bloklagan */
      }
    }
  }

  // ─── O'yin tugaganda FAQAT userlarga (g'olib ko'rsatilmaydi) ─────────────
  async notifyGameFinished(): Promise<void> {
    const admins = await this.prisma.admin.findMany({
      select: { telegramId: true },
    });
    const adminIds = new Set(admins.map((a) => a.telegramId));
    adminIds.add(String(config.telegram.adminId));

    const allUsers = await this.prisma.user.findMany({
      select: { telegramId: true },
    });
    const userIds = allUsers
      .filter((u) => !adminIds.has(u.telegramId))
      .map((u) => u.telegramId);

    const message =
      `🏆 <b>O'YIN TUGADI!</b> 🏆\n\n` +
      `🎉 Ishtirok etganingiz uchun rahmat!\n\n` +
      `Keyingi o'yinni kuzatib boring! 🍀`;

    for (const id of userIds) {
      try {
        await this.bot.telegram.sendMessage(id, message, {
          parse_mode: 'HTML',
          reply_markup: this.getMainMenu(false, false),
        });
      } catch {
        /* ignore */
      }
    }
  }

  // ─── Bron yo'riqnomasi ────────────────────────────────────────────────────
  getBookingInstructionMessage(slotNumber: number): string {
    const s = getSettings();
    return (
      `✅ <b>${slotNumber}-joy muvaffaqiyatli bron qilindi!</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💳 <b>TO'LOV MA'LUMOTLARI</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `💳 Karta raqami: <code>${s.cardNumber}</code>\n` +
      `👤 Karta egasi: <b>${s.cardHolder}</b>\n` +
      `💰 To'lov summasi: <b>${s.ticketPrice.toLocaleString()} so'm</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `⏰ <b>MUHIM!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚠️ To'lovni <b>${s.deadlineMinutes} daqiqa</b> ichida amalga oshiring!\n\n` +
      `📸 To'lov chekini (screenshot) shu chatga yuboring.\n\n` +
      `❌ Agar <b>${s.deadlineMinutes} daqiqa</b> ichida chek yuborilmasa,\n` +
      `bron <b>avtomatik bekor qilinadi!</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `❓ Savollar bo'lsa admin bilan bog'laning 👇`
    );
  }

  // ─── Adminga to'lov cheki ─────────────────────────────────────────────────
  // ESLATMA: chek har doim BARCHA adminlarga yuboriladi (faqat asosiy adminga
  // emas) — shunda istalgan admin tasdiqlashi/rad etishi mumkin.
  async notifyAdminPayment(
    slotNumber: number,
    userFullName: string,
    userTelegramId: string,
    username: string | undefined,
    fileId: string,
    gameId: number,
  ): Promise<void> {
    const userLink = username
      ? `@${username}`
      : `<a href="tg://user?id=${userTelegramId}">${userFullName}</a>`;

    const caption =
      `💳 <b>YANGI TO'LOV CHEKI</b>\n\n` +
      `👤 Foydalanuvchi: ${userLink}\n` +
      `🆔 Telegram ID: <code>${userTelegramId}</code>\n` +
      `🎟 Joy raqami: <b>${slotNumber}</b>\n` +
      `💰 Summa: <b>${getSettings().ticketPrice.toLocaleString()} so'm</b>\n\n` +
      `✅ Tasdiqlash yoki ❌ Rad etish uchun tugmani bosing:`;

    const confirmKeyboard = {
      inline_keyboard: [
        [
          {
            text: '✅ Tasdiqlash',
            callback_data: `confirm_${slotNumber}_${userTelegramId}_${gameId}`,
          },
          {
            text: '❌ Rad etish',
            callback_data: `reject_${slotNumber}_${userTelegramId}_${gameId}`,
          },
        ],
      ],
    };

    const targetAdminIds = await this.getAllAdminTelegramIds();
    const paymentKey = `${gameId}:${slotNumber}:${userTelegramId}`;
    const sentMessages: Array<{ chatId: string; messageId: number }> = [];

    for (const adminTelegramId of targetAdminIds) {
      try {
        const message = await this.bot.telegram.sendPhoto(
          adminTelegramId,
          fileId,
          {
            caption,
            parse_mode: 'HTML',
            reply_markup: confirmKeyboard,
          },
        );
        sentMessages.push({
          chatId: adminTelegramId,
          messageId: message.message_id,
        });
      } catch {
        /* ignore — admin botni bloklagan bo'lishi mumkin */
      }
    }

    this.adminPaymentMessages.set(paymentKey, sentMessages);
  }

  async deleteAdminPaymentMessages(
    slotNumber: number,
    userTelegramId: string,
    gameId: number,
    exceptChatId?: string,
  ): Promise<void> {
    const paymentKey = `${gameId}:${slotNumber}:${userTelegramId}`;
    const sentMessages = this.adminPaymentMessages.get(paymentKey);
    if (!sentMessages?.length) return;

    await Promise.all(
      sentMessages
        .filter((message) => message.chatId !== exceptChatId)
        .map(async (message) => {
          try {
            await this.bot.telegram.deleteMessage(
              message.chatId,
              message.messageId,
            );
          } catch {
            /* ignore */
          }
        }),
    );

    this.adminPaymentMessages.delete(paymentKey);
  }

  // ─── Barcha admin telegramId larini olish (config + DB) ──────────────────
  async getAllAdminTelegramIds(): Promise<string[]> {
    const admins = await this.prisma.admin.findMany({
      select: { telegramId: true },
    });
    const ids = new Set(admins.map((a) => a.telegramId));
    ids.add(String(config.telegram.adminId));
    return Array.from(ids);
  }

  // ─── Foydalanuvchiga natija ───────────────────────────────────────────────
  async notifyUserPaymentResult(
    telegramId: string,
    slotNumber: number,
    approved: boolean,
    isAdmin: boolean,
  ): Promise<void> {
    const menu = this.getMainMenu(isAdmin, true);
    if (approved) {
      await this.bot.telegram.sendMessage(
        telegramId,
        `🎉 <b>To'lovingiz tasdiqlandi!</b>\n\n` +
          `✅ <b>${slotNumber}-joy</b> sizga rasman biriktirildi.\n` +
          `🍀 Omad tilaymiz! G'olib siz bo'lishingizni umid qilamiz! 🏆`,
        { parse_mode: 'HTML', reply_markup: menu },
      );
    } else {
      await this.bot.telegram.sendMessage(
        telegramId,
        `❌ <b>To'lovingiz rad etildi.</b>\n\n` +
          `😔 <b>${slotNumber}-joy</b> bo'shatildi.\n\n` +
          `❓ Savol bo'lsa admin bilan bog'laning 👇`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📞 Admin bilan Bog'lanish",
                  url: `https://t.me/${config.telegram.adminUsername}`,
                },
              ],
            ],
          },
        },
      );
    }
  }

  // ─── Slot egasi ma'lumotini SO'RAGAN ADMINGA yuborish ────────────────────
  // MUHIM TUZATISH: avval bu metod har doim config.telegram.adminId'ga
  // (asosiy adminga) yuborardi — shu sabab boshqa admin so'rasa ham,
  // javob faqat bitta odamga ketardi. Endi requestingAdminTelegramId
  // parametri orqali javob aynan so'ragan adminga yuboriladi.
  async sendSlotInfoToAdmin(
    slotNumber: number,
    gameId: number,
    requestingAdminTelegramId: string,
  ): Promise<void> {
    const slot = await this.prisma.slot.findFirst({
      where: {
        number: slotNumber,
        gameId,
        status: { in: ['CONFIRMED', 'PENDING'] },
      },
      include: { user: true },
    });

    if (!slot || !slot.user) {
      await this.bot.telegram.sendMessage(
        requestingAdminTelegramId,
        `⚠️ <b>${slotNumber}-joy</b> bo'sh yoki bunday joy topilmadi.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    const user = slot.user;
    const username = user.username ?? undefined;
    const statusEmoji =
      slot.status === 'CONFIRMED' ? '✅ Tasdiqlangan' : '⏳ Kutilmoqda';

    const userLink = username
      ? `@${username}`
      : `<a href="tg://user?id=${user.telegramId}">${user.fullName}</a>`;

    const text =
      `📋 <b>${slotNumber}-JOY MA'LUMOTLARI</b>\n\n` +
      `🎟 Joy raqami: <b>${slotNumber}</b>\n` +
      `📊 Holati: <b>${statusEmoji}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 Ism: <b>${user.fullName}</b>\n` +
      `🔗 Profil: ${userLink}\n` +
      `🆔 Telegram ID: <code>${user.telegramId}</code>\n` +
      (username ? `📎 Username: @${username}\n` : '');

    await this.bot.telegram.sendMessage(requestingAdminTelegramId, text, {
      parse_mode: 'HTML',
    });
  }

  // ─── O'yin tugaganda admin keyboard ──────────────────────────────────────
  getGameFinishedAdminKeyboard(gameId: number): any {
    return {
      inline_keyboard: [
        [
          {
            text: "👤 Foydalanuvchi Ma'lumoti",
            callback_data: `ask_slot_info_${gameId}`,
          },
        ],
      ],
    };
  }

  // ─── O'YIN TARIXI ─────────────────────────────────────────────────────────

  // Tugagan o'yinlar ro'yxati (eng so'nggisidan boshlab)
  async getFinishedGamesList(limit = 10) {
    return this.prisma.game.findMany({
      where: { status: GameStatus.FINISHED },
      orderBy: { finishedAt: 'desc' },
      take: limit,
    });
  }

  // O'yin tarixi ro'yxati uchun inline keyboard (har bir o'yin alohida tugma)
  getGameHistoryKeyboard(
    games: { id: number; finishedAt: Date | null }[],
  ): any {
    if (!games.length) {
      return {
        inline_keyboard: [
          [{ text: '🔙 Orqaga', callback_data: 'history_back' }],
        ],
      };
    }

    const rows = games.map((g) => {
      const dateStr = g.finishedAt
        ? new Date(g.finishedAt).toLocaleDateString('uz-UZ', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
          })
        : 'N/A';
      return [
        {
          text: `🎮 #${g.id} | ${dateStr}`,
          callback_data: `history_view_${g.id}`,
        },
      ];
    });

    rows.push([{ text: '🔙 Orqaga', callback_data: 'history_back' }]);

    return { inline_keyboard: rows };
  }

  // Bitta o'yin ichidagi band joylar va ularni ko'rsatish uchun keyboard
  async getGameHistoryDetail(
    gameId: number,
  ): Promise<{ text: string; keyboard: any }> {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      return {
        text: "❌ O'yin topilmadi.",
        keyboard: {
          inline_keyboard: [
            [{ text: '🔙 Orqaga', callback_data: 'history_back' }],
          ],
        },
      };
    }

    const slots = await this.prisma.slot.findMany({
      where: { gameId, status: 'CONFIRMED' },
      include: { user: true },
      orderBy: { number: 'asc' },
    });

    const startedStr = game.startedAt
      ? new Date(game.startedAt).toLocaleString('uz-UZ')
      : '—';
    const finishedStr = game.finishedAt
      ? new Date(game.finishedAt).toLocaleString('uz-UZ')
      : '—';

    let text =
      `📜 <b>O'YIN #${game.id} TARIXI</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🕐 Boshlangan: <b>${startedStr}</b>\n` +
      `🏁 Tugagan: <b>${finishedStr}</b>\n` +
      `👥 Band joylar: <b>${slots.length} ta</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (!slots.length) {
      text += 'Tasdiqlangan joylar topilmadi.';
      return {
        text,
        keyboard: {
          inline_keyboard: [
            [{ text: '🔙 Orqaga', callback_data: 'history_back' }],
          ],
        },
      };
    }

    text += `<b>BAND JOYLAR:</b>\n\nQuyidagi joylardan birini tanlang:`;

    const rows: { text: string; callback_data: string }[][] = [];
    for (let i = 0; i < slots.length; i += 5) {
      rows.push(
        slots.slice(i, i + 5).map((slot) => ({
          text: `🎟 ${slot.number}`,
          callback_data: `history_slot_${game.id}_${slot.number}`,
        })),
      );
    }

    rows.push([{ text: '🔙 Orqaga', callback_data: 'history_back' }]);

    return {
      text,
      keyboard: { inline_keyboard: rows },
    };
  }

  // Bitta joyni kim band qilgani haqida ma'lumot
  async getGameHistorySlotDetail(
    gameId: number,
    slotNumber: number,
  ): Promise<string> {
    const slot = await this.prisma.slot.findFirst({
      where: {
        gameId,
        number: slotNumber,
        status: 'CONFIRMED',
      },
      include: { user: true },
    });

    if (!slot || !slot.user) {
      return `⚠️ <b>${slotNumber}-joy</b> bo'sh yoki ma'lumot topilmadi.`;
    }

    const user = slot.user;
    const profileLink = user.username
      ? `@${user.username}`
      : `<a href="tg://user?id=${user.telegramId}">${user.fullName}</a>`;

    return (
      `👤 <b>${slotNumber}-JOY EGASI</b>\n\n` +
      `🎟 Joy raqami: <b>${slotNumber}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 Ism: <b>${user.fullName}</b>\n` +
      `🔗 Profil: ${profileLink}\n` +
      `🆔 Telegram ID: <code>${user.telegramId}</code>` +
      (user.username ? `\n📎 Username: @${user.username}` : '')
    );
  }
}
