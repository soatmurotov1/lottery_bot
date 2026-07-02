// src/telegram/telegram.update.ts

import { Update, Start, Hears, On, Action } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { LotteryService } from '../lottery/lottery.service';
import {
  TelegramService,
  updateSettings,
  getSettings,
} from './telegram.service';
import { config } from '../config/config';

// ─── In-memory holat (har biri userId bo'yicha alohida — adminlar orasida
// aralashib ketmasligi uchun MUHIM: har doim ctx.from!.id ishlatiladi,
// hech qachon config.telegram.adminId yoki boshqa qattiq ID emas) ────────────
const broadcastPending = new Map<number, string>(); // adminId -> xabar matni
const waitingForBroadcast = new Set<number>();
const waitingForSettings = new Map<number, string>(); // adminId -> field nomi
const waitingForSlotInfo = new Map<number, number>(); // adminId -> gameId
const waitingForAdminAdd = new Set<number>();
const waitingForAdminRemove = new Set<number>();

const MENU_BUTTON_TEXTS = new Set([
  "🎮 O'yinni Boshlash",
  "🏁 O'yinni Tugatish",
  '📢 Xabar Tarqatish',
  '👥 Adminlar',
  '⚙️ Sozlamalar',
  "👤 Foydalanuvchi Ma'lumoti",
  "📜 O'yin Tarixi",
  '🎟 Joyni Bron Qilish',
  "👀 Joylarni Ko'rish",
  "📞 Admin bilan Bog'lanish",
  'ℹ️ Bot Haqida',
  '🔙 Orqaga',
]);

function clearAllWaitingStates(userId: number): void {
  waitingForSlotInfo.delete(userId);
  waitingForSettings.delete(userId);
  waitingForBroadcast.delete(userId);
  waitingForAdminAdd.delete(userId);
  waitingForAdminRemove.delete(userId);
  broadcastPending.delete(userId);
}

@Update()
export class TelegramUpdate {
  constructor(
    private readonly lotteryService: LotteryService,
    private readonly telegramService: TelegramService,
  ) {}

  // ─── /start ───────────────────────────────────────────────────────────────

  @Start()
  async onStart(ctx: Context) {
    const userId = ctx.from!.id;
    clearAllWaitingStates(userId);

    const telegramId = userId.toString();
    const username = ctx.from!.username;
    const fullName = [ctx.from!.first_name, ctx.from!.last_name]
      .filter(Boolean)
      .join(' ');

    await this.lotteryService.upsertUser(telegramId, username, fullName);

    const isAdmin = await this.lotteryService.isAdmin(telegramId);
    const activeGame = await this.lotteryService.getActiveGame();
    const s = getSettings();

    const welcomeText =
      `🎰 <b>Lotariya Botga Xush Kelibsiz!</b>\n\n` +
      `👋 Salom, <b>${fullName}</b>!\n\n` +
      (activeGame
        ? `✅ Hozir faol o'yin mavjud!\n💰 Bilet narxi: <b>${s.ticketPrice.toLocaleString()} so'm</b>`
        : `⏳ Hozircha faol o'yin yo'q. Kuting...`);

    await ctx.reply(welcomeText, {
      parse_mode: 'HTML',
      reply_markup: this.telegramService.getMainMenu(isAdmin, !!activeGame),
    });
  }

  // ─── Matn xabarlari ───────────────────────────────────────────────────────

  @On('text')
  async onText(ctx: Context) {
    const text = (ctx.message as any)?.text as string;
    const telegramId = ctx.from!.id.toString();
    const userId = ctx.from!.id; // MUHIM: har bir holat shu aniq userId bo'yicha saqlanadi
    const isAdmin = await this.lotteryService.isAdmin(telegramId);

    if (MENU_BUTTON_TEXTS.has(text)) {
      clearAllWaitingStates(userId);
    } else {
      // ── 1a. Joy raqami so'rash (Admin ID tanlangandan keyingi qadam) ─────────
      if (waitingForSlotInfo.has(userId)) {
        const gameId = waitingForSlotInfo.get(userId)!;
        const slotNumber = parseInt(text.trim(), 10);

        if (isNaN(slotNumber) || slotNumber < 1) {
          await ctx.reply(
            "❌ Noto'g'ri raqam. Iltimos, to'g'ri joy raqamini kiriting:",
          );
          return;
        }

        // Javob FAQAT shu so'ragan adminning o'ziga yuboriladi (telegramId)
        await this.telegramService.sendSlotInfoToAdmin(
          slotNumber,
          gameId,
          telegramId,
        );

        await ctx.reply(
          `✅ ${slotNumber}-joy ma'lumoti yuborildi.\n\nBoshqa joy raqamini kiriting yoki /start bosing:`,
          { reply_markup: { remove_keyboard: true } },
        );
        return;
      }

      // ── 2. Sozlama qiymati kutilmoqda ────────────────────────────────────────
      if (waitingForSettings.has(userId)) {
        const field = waitingForSettings.get(userId)!;
        waitingForSettings.delete(userId);
        await this.handleSettingsInput(ctx, field, text);
        return;
      }

      // ── 3. Broadcast matni kutilmoqda ─────────────────────────────────────────
      if (waitingForBroadcast.has(userId)) {
        waitingForBroadcast.delete(userId);
        broadcastPending.set(userId, text);
        await ctx.reply(
          `📢 <b>Xabarni tasdiqlang:</b>\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n${text}\n━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Ushbu xabar <b>barcha foydalanuvchilarga</b> yuboriladi. Tasdiqlaysizmi?`,
          {
            parse_mode: 'HTML',
            reply_markup: this.telegramService.getConfirmBroadcastKeyboard(),
          },
        );
        return;
      }

      // ── 4. Admin qo'shish ─────────────────────────────────────────────────────
      if (waitingForAdminAdd.has(userId)) {
        waitingForAdminAdd.delete(userId);
        const newId = text.trim();
        try {
          await this.lotteryService.addAdmin(newId);
          await ctx.reply(
            `✅ <code>${newId}</code> admin sifatida qo'shildi!`,
            {
              parse_mode: 'HTML',
              reply_markup: this.telegramService.getMainMenu(true, true),
            },
          );
        } catch {
          await ctx.reply(
            '❌ Bu foydalanuvchi allaqachon admin yoki xatolik yuz berdi.',
          );
        }
        await this.showAdminsList(ctx);
        return;
      }

      // ── 5. Admin o'chirish ────────────────────────────────────────────────────
      if (waitingForAdminRemove.has(userId)) {
        waitingForAdminRemove.delete(userId);
        const removeId = text.trim();
        try {
          await this.lotteryService.removeAdmin(removeId);
          await ctx.reply(
            `✅ <code>${removeId}</code> adminlikdan olib tashlandi!`,
            {
              parse_mode: 'HTML',
              reply_markup: this.telegramService.getMainMenu(true, true),
            },
          );
        } catch {
          await ctx.reply('❌ Bunday admin topilmadi yoki xatolik yuz berdi.');
        }
        await this.showAdminsList(ctx);
        return;
      }
    }

    // ── 6. Admin tugmalari ────────────────────────────────────────────────────
    if (isAdmin) {
      // O'yinni Boshlash
      if (text === "🎮 O'yinni Boshlash") {
        const existing = await this.lotteryService.getActiveGame();
        if (existing) {
          await ctx.reply("⚠️ Allaqachon faol o'yin mavjud!", {
            reply_markup: this.telegramService.getMainMenu(true, true),
          });
          return;
        }
        const game = await this.lotteryService.createGame();
        const s = getSettings();
        await ctx.reply(
          `✅ <b>O'yin muvaffaqiyatli boshlandi!</b>\n\n` +
            `🎮 O'yin ID: <b>${game.id}</b>\n` +
            `🎟 Jami joy: <b>${config.game.totalSlots} ta</b>\n` +
            `💰 Bilet narxi: <b>${s.ticketPrice.toLocaleString()} so'm</b>`,
          {
            parse_mode: 'HTML',
            reply_markup: this.telegramService.getMainMenu(true, true),
          },
        );
        await this.telegramService.notifyGameStarted(config.game.totalSlots);
        return;
      }

      // O'yinni Tugatish
      if (text === "🏁 O'yinni Tugatish") {
        const game = await this.lotteryService.getActiveGame();
        if (!game) {
          await ctx.reply("⚠️ Faol o'yin topilmadi!", {
            reply_markup: this.telegramService.getMainMenu(true, false),
          });
          return;
        }
        try {
          const result = await this.lotteryService.finishGame(game.id);

          await ctx.reply(
            `🏆 <b>O'YIN TUGADI!</b>\n\n` +
              `🎟 G'olib joyi: <b>${result.winnerSlot}-joy</b>\n` +
              `👥 Ishtirokchilar: <b>${result.allParticipants.length} ta</b>\n\n` +
              `G'olib yoki boshqa foydalanuvchi ma'lumotini olish uchun:`,
            {
              parse_mode: 'HTML',
              reply_markup: this.telegramService.getGameFinishedAdminKeyboard(
                game.id,
              ),
            },
          );

          await ctx.reply('🏠 Admin menyusi', {
            reply_markup: this.telegramService.getMainMenu(true, false),
          });

          await this.telegramService.notifyGameFinished();
        } catch (e: any) {
          await ctx.reply(`❌ Xatolik: ${e.message}`, {
            reply_markup: this.telegramService.getMainMenu(true, true),
          });
        }
        return;
      }

      // Xabar Tarqatish
      if (text === '📢 Xabar Tarqatish') {
        waitingForBroadcast.add(userId);
        await ctx.reply(
          `📢 <b>Xabar Tarqatish</b>\n\nBarcha foydalanuvchilarga yubormoqchi bo'lgan xabaringizni yozing:`,
          { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } },
        );
        return;
      }

      // Adminlar ro'yxati
      if (text === '👥 Adminlar') {
        await this.showAdminsList(ctx);
        return;
      }

      // Sozlamalar
      if (text === '⚙️ Sozlamalar') {
        await ctx.reply(this.telegramService.getSettingsText(), {
          parse_mode: 'HTML',
          reply_markup: this.telegramService.getSettingsMenu(),
        });
        return;
      }

      // Foydalanuvchi Ma'lumoti — to'g'ridan-to'g'ri joriy faol o'yin bo'yicha
      if (text === "👤 Foydalanuvchi Ma'lumoti") {
        const game = await this.lotteryService.getActiveGame();
        const lastGame = game ?? (await this.lotteryService.getLastGame());
        if (!lastGame) {
          await ctx.reply("❌ Hech qanday o'yin topilmadi.");
          return;
        }
        waitingForSlotInfo.set(userId, lastGame.id);
        await ctx.reply(
          `🔢 <b>Joy raqamini kiriting:</b>\n\nKimning ma'lumotini olmoqchisiz? Joy raqamini yozing:\n\n` +
            `Masalan: <code>4</code> — yozsangiz, 4-joyni bron qilgan shaxs ma'lumoti yuboriladi.`,
          { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } },
        );
        return;
      }

      // O'yin Tarixi — tugagan o'yinlar ro'yxatini ko'rsatish
      if (text === "📜 O'yin Tarixi") {
        const games = await this.telegramService.getFinishedGamesList(15);
        if (!games.length) {
          await ctx.reply("📭 Hozircha tugagan o'yinlar yo'q.", {
            reply_markup: this.telegramService.getMainMenu(true, true),
          });
          return;
        }
        await ctx.reply(
          `📜 <b>O'YIN TARIXI</b>\n\nKo'rmoqchi bo'lgan o'yinni tanlang:`,
          {
            parse_mode: 'HTML',
            reply_markup: this.telegramService.getGameHistoryKeyboard(games),
          },
        );
        return;
      }
    }

    // ── 7. User tugmalari ─────────────────────────────────────────────────────

    // Joyni Bron Qilish
    if (text === '🎟 Joyni Bron Qilish') {
      const game = await this.lotteryService.getActiveGame();
      if (!game) {
        await ctx.reply("⏳ Hozirda faol o'yin yo'q. Keyingi o'yinni kuting!", {
          reply_markup: this.telegramService.getMainMenu(isAdmin, false),
        });
        return;
      }
      const available = await this.lotteryService.getAvailableSlots(game.id);
      if (!available.length) {
        await ctx.reply("😔 Barcha joylar band! Keyingi o'yinni kuting.", {
          reply_markup: this.telegramService.getMainMenu(isAdmin, true),
        });
        return;
      }

      const rows: any[][] = [];
      for (let i = 0; i < available.length; i += 5) {
        rows.push(available.slice(i, i + 5).map((n) => ({ text: `⬜ ${n}` })));
      }
      rows.push([{ text: '🔙 Orqaga' }]);

      const s = getSettings();
      await ctx.reply(
        `🎟 <b>Joy tanlang</b>\n\n` +
          `Bo'sh joylar: <b>${available.length} ta</b>\n` +
          `💰 Narxi: <b>${s.ticketPrice.toLocaleString()} so'm</b>\n\n` +
          `Quyidagi raqamlardan birini tanlang:`,
        {
          parse_mode: 'HTML',
          reply_markup: { keyboard: rows, resize_keyboard: true },
        },
      );
      return;
    }

    // Joylarni Ko'rish
    if (text === "👀 Joylarni Ko'rish") {
      const game = await this.lotteryService.getActiveGame();
      if (!game) {
        await ctx.reply("⏳ Faol o'yin yo'q.", {
          reply_markup: this.telegramService.getMainMenu(isAdmin, false),
        });
        return;
      }
      const slotsMap = await this.lotteryService.getSlotsMap(game.id);
      await ctx.reply(slotsMap, {
        parse_mode: 'HTML',
        reply_markup: this.telegramService.getMainMenu(isAdmin, true),
      });
      return;
    }

    // Admin bilan Bog'lanish
    if (text === "📞 Admin bilan Bog'lanish") {
      await ctx.reply(
        `📞 <b>Admin bilan bog'lanish</b>\n\nSavol yoki muammo bo'lsa, quyidagi tugma orqali admin bilan bog'laning:`,
        {
          parse_mode: 'HTML',
          reply_markup: this.telegramService.getContactAdminButton(),
        },
      );
      return;
    }

    // Bot Haqida
    if (text === 'ℹ️ Bot Haqida') {
      const s = getSettings();
      await ctx.reply(
        `ℹ️ <b>BOT HAQIDA</b>\n\n` +
          `🎰 Bu bot lotariya o'yinini boshqarish uchun yaratilgan.\n\n` +
          `📋 <b>Qanday ishlaydi?</b>\n` +
          `1️⃣ Joy bron qiling\n` +
          `2️⃣ To'lovni amalga oshiring\n` +
          `3️⃣ Chekni yuboring\n` +
          `4️⃣ Admin tasdiqlaydi\n` +
          `5️⃣ G'olib e'lon qilinadi\n\n` +
          `💰 Bilet narxi: <b>${s.ticketPrice.toLocaleString()} so'm</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: this.telegramService.getMainMenu(isAdmin, true),
        },
      );
      return;
    }

    // Orqaga
    if (text === '🔙 Orqaga') {
      clearAllWaitingStates(userId);
      const activeGame = await this.lotteryService.getActiveGame();
      await ctx.reply('🏠 Bosh menyu', {
        reply_markup: this.telegramService.getMainMenu(isAdmin, !!activeGame),
      });
      return;
    }

    // ── 8. Joy raqami tanlash (⬜ N formatida) ────────────────────────────────
    const slotMatch = text.match(/^⬜\s*(\d+)$/);
    if (slotMatch) {
      await this.handleSlotBooking(
        ctx,
        parseInt(slotMatch[1]),
        telegramId,
        isAdmin,
      );
      return;
    }
  }

  // ─── Joy bron qilish (alohida metod) ─────────────────────────────────────

  private async handleSlotBooking(
    ctx: Context,
    slotNumber: number,
    telegramId: string,
    isAdmin: boolean,
  ): Promise<void> {
    const username = ctx.from!.username;
    const fullName = [ctx.from!.first_name, ctx.from!.last_name]
      .filter(Boolean)
      .join(' ');
    const game = await this.lotteryService.getActiveGame();

    if (!game) {
      await ctx.reply("⏳ Faol o'yin topilmadi.", {
        reply_markup: this.telegramService.getMainMenu(isAdmin, false),
      });
      return;
    }

    try {
      await this.lotteryService.bookSlot({
        slotNumber,
        telegramId,
        username,
        fullName,
        gameId: game.id,
      });
    } catch (e: any) {
      await ctx.reply(`❌ ${e.message}`, {
        reply_markup: this.telegramService.getMainMenu(isAdmin, true),
      });
      return;
    }

    const instruction =
      this.telegramService.getBookingInstructionMessage(slotNumber);
    await ctx.reply(instruction, {
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
    });

    await ctx.reply('👇 Chekni shu chatga yuboring:', {
      reply_markup: this.telegramService.getMainMenu(isAdmin, true),
    });

    const s = getSettings();
    const deadlineMs = s.deadlineMinutes * 60 * 1000;
    const gameId = game.id;

    setTimeout(async () => {
      const stillPending = await this.lotteryService.isSlotStillPending(
        slotNumber,
        telegramId,
        gameId,
      );
      if (!stillPending) return;

      await this.lotteryService.cancelSlot(slotNumber, telegramId, gameId);
      try {
        await this.telegramService['bot'].telegram.sendMessage(
          telegramId,
          `⏰ <b>Vaqt tugadi!</b>\n\n` +
            `😔 <b>${slotNumber}-joy</b> broningiz avtomatik bekor qilindi.\n` +
            `Iltimos, qayta bron qiling va to'lovni o'z vaqtida amalga oshiring.`,
          {
            parse_mode: 'HTML',
            reply_markup: this.telegramService.getMainMenu(isAdmin, true),
          },
        );
      } catch {
        /* ignore */
      }
    }, deadlineMs);
  }

  // ─── Adminlar ro'yxatini ko'rsatish ──────────────────────────────────────

  private async showAdminsList(ctx: Context): Promise<void> {
    const admins = await this.lotteryService.getAllAdmins();
    const list = admins.length
      ? admins
          .map((a, i) => `${i + 1}. <code>${a.telegramId}</code>`)
          .join('\n')
      : "Qo'shimcha adminlar yo'q";

    await ctx.reply(`👥 <b>ADMINLAR RO'YXATI</b>\n\n${list}`, {
      parse_mode: 'HTML',
      reply_markup: this.telegramService.getAdminsMenu(),
    });
  }

  // ─── Sozlama qiymatini qayta ishlash ──────────────────────────────────────

  private async handleSettingsInput(
    ctx: Context,
    field: string,
    value: string,
  ): Promise<void> {
    switch (field) {
      case 'price': {
        const price = parseInt(value.replace(/\D/g, ''), 10);
        if (isNaN(price) || price <= 0) {
          await ctx.reply(
            "❌ Noto'g'ri format. Faqat musbat raqam kiriting.\nMasalan: <code>50000</code>",
            { parse_mode: 'HTML' },
          );
          return;
        }
        updateSettings({ ticketPrice: price });
        await ctx.reply(
          `✅ Bilet narxi yangilandi: <b>${price.toLocaleString()} so'm</b>`,
          { parse_mode: 'HTML' },
        );
        break;
      }
      case 'card': {
        updateSettings({ cardNumber: value });
        await ctx.reply(`✅ Karta raqami yangilandi: <code>${value}</code>`, {
          parse_mode: 'HTML',
        });
        break;
      }
      case 'holder': {
        updateSettings({ cardHolder: value });
        await ctx.reply(`✅ Karta egasi yangilandi: <b>${value}</b>`, {
          parse_mode: 'HTML',
        });
        break;
      }
      case 'deadline': {
        const minutes = parseInt(value, 10);
        if (isNaN(minutes) || minutes <= 0) {
          await ctx.reply("❌ Noto'g'ri format. Masalan: <code>30</code>", {
            parse_mode: 'HTML',
          });
          return;
        }
        updateSettings({ deadlineMinutes: minutes });
        await ctx.reply(
          `✅ To'lov muddati yangilandi: <b>${minutes} daqiqa</b>`,
          { parse_mode: 'HTML' },
        );
        break;
      }
    }

    await ctx.reply(this.telegramService.getSettingsText(), {
      parse_mode: 'HTML',
      reply_markup: this.telegramService.getSettingsMenu(),
    });
  }

  // ─── Rasm (chek) yuborilganda ─────────────────────────────────────────────

  @On('photo')
  async onPhoto(ctx: Context) {
    const telegramId = ctx.from!.id.toString();
    const username = ctx.from!.username;
    const fullName = [ctx.from!.first_name, ctx.from!.last_name]
      .filter(Boolean)
      .join(' ');

    const photos = (ctx.message as any)?.photo;
    if (!photos?.length) return;
    const fileId = photos[photos.length - 1].file_id;

    const game = await this.lotteryService.getActiveGame();
    if (!game) {
      await ctx.reply("⏳ Faol o'yin topilmadi.");
      return;
    }

    const user = await this.lotteryService['prisma'].user.findUnique({
      where: { telegramId },
    });
    if (!user) {
      await ctx.reply('❌ Avval joy bron qiling!');
      return;
    }

    const pendingSlot = await this.lotteryService['prisma'].slot.findFirst({
      where: { gameId: game.id, userId: user.id, status: 'PENDING' },
    });

    if (!pendingSlot) {
      await ctx.reply(
        "❌ Sizda kutilayotgan bron topilmadi!\nAvval joy bron qiling, so'ng chekni yuboring.",
      );
      return;
    }

    try {
      await this.lotteryService.savePaymentReceipt(
        pendingSlot.number,
        telegramId,
        fileId,
      );
      await ctx.reply(
        `✅ <b>Chek qabul qilindi!</b>\n\n🎟 Joy: <b>${pendingSlot.number}</b>\n⏳ Admin tekshirmoqda, biroz kuting...`,
        { parse_mode: 'HTML' },
      );
      await this.telegramService.notifyAdminPayment(
        pendingSlot.number,
        fullName,
        telegramId,
        username,
        fileId,
        game.id,
      );
    } catch (e: any) {
      await ctx.reply(`❌ ${e.message}`);
    }
  }

  // ─── Inline callback tugmalari ────────────────────────────────────────────

  @Action(/^confirm_(\d+)_(\d+)_(\d+)$/)
  async onConfirmPayment(ctx: Context) {
    await ctx.answerCbQuery();
    const match = (ctx as any).match;
    const slotNumber = parseInt(match[1]);
    const userTelegramId = match[2];
    const gameId = parseInt(match[3]);

    try {
      const result = await this.lotteryService.confirmPayment({
        slotNumber,
        userId: userTelegramId,
        gameId,
        approved: true,
      });

      await ctx.editMessageCaption(
        `✅ <b>TASDIQLANDI</b>\n\n🎟 Joy: <b>${slotNumber}</b>\n👤 Foydalanuvchi: <b>${result.user?.fullName ?? userTelegramId}</b>`,
        { parse_mode: 'HTML' },
      );

      await this.telegramService.deleteAdminPaymentMessages(
        slotNumber,
        userTelegramId,
        gameId,
        String(ctx.chat?.id ?? ctx.from!.id),
      );

      const isAdminUser = await this.lotteryService.isAdmin(userTelegramId);
      await this.telegramService.notifyUserPaymentResult(
        userTelegramId,
        slotNumber,
        true,
        isAdminUser,
      );

      if (result.allFull) {
        // Barcha adminlarga xabar berish (faqat asosiy adminga emas)
        const adminIds = await this.telegramService.getAllAdminTelegramIds();
        for (const adminId of adminIds) {
          try {
            await this.telegramService['bot'].telegram.sendMessage(
              adminId,
              `🎰 <b>BARCHA JOYLAR TO'LDI!</b>\n\nO'yinni tugatishingiz mumkin.`,
              { parse_mode: 'HTML' },
            );
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e: any) {
      await ctx.reply(`❌ Xatolik: ${e.message}`);
    }
  }

  @Action(/^reject_(\d+)_(\d+)_(\d+)$/)
  async onRejectPayment(ctx: Context) {
    await ctx.answerCbQuery();
    const match = (ctx as any).match;
    const slotNumber = parseInt(match[1]);
    const userTelegramId = match[2];
    const gameId = parseInt(match[3]);

    try {
      await this.lotteryService.confirmPayment({
        slotNumber,
        userId: userTelegramId,
        gameId,
        approved: false,
      });
      await ctx.editMessageCaption(
        `❌ <b>RAD ETILDI</b>\n\n🎟 Joy: <b>${slotNumber}</b>\n👤 Foydalanuvchi: <b>${userTelegramId}</b>`,
        { parse_mode: 'HTML' },
      );

      await this.telegramService.deleteAdminPaymentMessages(
        slotNumber,
        userTelegramId,
        gameId,
        String(ctx.chat?.id ?? ctx.from!.id),
      );

      const isAdminUser = await this.lotteryService.isAdmin(userTelegramId);
      await this.telegramService.notifyUserPaymentResult(
        userTelegramId,
        slotNumber,
        false,
        isAdminUser,
      );
    } catch (e: any) {
      await ctx.reply(`❌ Xatolik: ${e.message}`);
    }
  }

  // O'yin tugagandan keyin "Foydalanuvchi Ma'lumoti" inline tugmasi
  @Action(/^ask_slot_info_(\d+)$/)
  async onAskSlotInfo(ctx: Context) {
    await ctx.answerCbQuery();
    const match = (ctx as any).match;
    const gameId = parseInt(match[1]);
    const userId = ctx.from!.id;

    waitingForSlotInfo.set(userId, gameId);
    await ctx.reply(
      `🔢 <b>Joy raqamini kiriting:</b>\n\nKimning ma'lumotini olmoqchisiz? Joy raqamini yozing:`,
      { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } },
    );
  }

  // ─── Adminlar menyusi ─────────────────────────────────────────────────────

  @Action('admin_add')
  async onAdminAdd(ctx: Context) {
    await ctx.answerCbQuery();
    waitingForAdminAdd.add(ctx.from!.id);
    await ctx.reply(
      `➕ <b>Admin qo'shish</b>\n\nYangi adminning Telegram ID sini kiriting:\nMasalan: <code>123456789</code>`,
      { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } },
    );
  }

  @Action('admin_remove')
  async onAdminRemove(ctx: Context) {
    await ctx.answerCbQuery();
    const admins = await this.lotteryService.getAllAdmins();
    if (!admins.length) {
      await ctx.reply("❌ O'chirish uchun adminlar yo'q.");
      return;
    }
    waitingForAdminRemove.add(ctx.from!.id);
    const list = admins
      .map((a, i) => `${i + 1}. <code>${a.telegramId}</code>`)
      .join('\n');
    await ctx.reply(
      `➖ <b>Admin o'chirish</b>\n\nMavjud adminlar:\n${list}\n\nO'chirmoqchi bo'lgan adminning Telegram ID sini kiriting:`,
      { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } },
    );
  }

  @Action('admin_back')
  async onAdminBack(ctx: Context) {
    await ctx.answerCbQuery();
    try {
      await ctx.deleteMessage();
    } catch {
      /* ignore */
    }
    await ctx.reply('🏠 Bosh menyu', {
      reply_markup: this.telegramService.getMainMenu(true, true),
    });
  }

  // ─── Sozlamalar ───────────────────────────────────────────────────────────

  @Action('settings_view')
  async onSettingsView(ctx: Context) {
    await ctx.answerCbQuery();
    await ctx.editMessageText(this.telegramService.getSettingsText(), {
      parse_mode: 'HTML',
      reply_markup: this.telegramService.getSettingsMenu(),
    });
  }

  @Action('settings_price')
  async onSettingsPrice(ctx: Context) {
    await ctx.answerCbQuery();
    waitingForSettings.set(ctx.from!.id, 'price');
    await ctx.reply(
      `💰 Yangi bilet narxini kiriting (so'mda):\nMasalan: <code>50000</code>`,
      { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } },
    );
  }

  @Action('settings_card')
  async onSettingsCard(ctx: Context) {
    await ctx.answerCbQuery();
    waitingForSettings.set(ctx.from!.id, 'card');
    await ctx.reply(
      `💳 Yangi karta raqamini kiriting:\nMasalan: <code>8600 1234 5678 9012</code>`,
      { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } },
    );
  }

  @Action('settings_holder')
  async onSettingsHolder(ctx: Context) {
    await ctx.answerCbQuery();
    waitingForSettings.set(ctx.from!.id, 'holder');
    await ctx.reply(
      `👤 Karta egasining ism-familiyasini kiriting:\nMasalan: <code>Aziz Karimov</code>`,
      { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } },
    );
  }

  @Action('settings_deadline')
  async onSettingsDeadline(ctx: Context) {
    await ctx.answerCbQuery();
    waitingForSettings.set(ctx.from!.id, 'deadline');
    await ctx.reply(
      `⏰ To'lov muddatini daqiqalarda kiriting:\nMasalan: <code>30</code>`,
      { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } },
    );
  }

  @Action('settings_back')
  async onSettingsBack(ctx: Context) {
    await ctx.answerCbQuery();
    try {
      await ctx.deleteMessage();
    } catch {
      /* ignore */
    }
    await ctx.reply('🏠 Bosh menyu', {
      reply_markup: this.telegramService.getMainMenu(true, true),
    });
  }

  // ─── O'yin Tarixi callback'lari ──────────────────────────────────────────

  @Action(/^history_view_(\d+)$/)
  async onHistoryView(ctx: Context) {
    await ctx.answerCbQuery();
    const match = (ctx as any).match;
    const gameId = parseInt(match[1]);

    const detail = await this.telegramService.getGameHistoryDetail(gameId);
    await ctx.editMessageText(detail.text, {
      parse_mode: 'HTML',
      reply_markup: detail.keyboard,
    });
  }

  @Action(/^history_slot_(\d+)_(\d+)$/)
  async onHistorySlot(ctx: Context) {
    await ctx.answerCbQuery();
    const match = (ctx as any).match;
    const gameId = parseInt(match[1]);
    const slotNumber = parseInt(match[2]);

    const detail = await this.telegramService.getGameHistorySlotDetail(
      gameId,
      slotNumber,
    );
    await ctx.reply(detail, { parse_mode: 'HTML' });
  }

  @Action('history_back')
  async onHistoryBack(ctx: Context) {
    await ctx.answerCbQuery();
    const games = await this.telegramService.getFinishedGamesList(15);
    if (!games.length) {
      await ctx.editMessageText("📭 Hozircha tugagan o'yinlar yo'q.", {
        reply_markup: this.telegramService.getMainMenu(true, true),
      });
      return;
    }

    await ctx.editMessageText(
      `📜 <b>O'YIN TARIXI</b>\n\nKo'rmoqchi bo'lgan o'yinni tanlang:`,
      {
        parse_mode: 'HTML',
        reply_markup: this.telegramService.getGameHistoryKeyboard(games),
      },
    );
  }

  // ─── Broadcast ────────────────────────────────────────────────────────────

  @Action('broadcast_confirm')
  async onBroadcastConfirm(ctx: Context) {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id;
    const isAdmin = await this.lotteryService.isAdmin(userId.toString());
    if (!isAdmin) {
      await ctx.reply("❌ Ruxsat yo'q!");
      return;
    }

    const message = broadcastPending.get(userId);
    if (!message) {
      await ctx.reply('❌ Xabar topilmadi. Qaytadan boshlang.');
      return;
    }

    broadcastPending.delete(userId);
    await ctx.editMessageText('⏳ Xabar yuborilmoqda...', {
      parse_mode: 'HTML',
    });

    const result = await this.telegramService.broadcastMessage(message);
    await ctx.reply(
      `✅ <b>Xabar yuborildi!</b>\n\n📨 Yuborildi: <b>${result.sent} ta</b>\n❌ Yuborilmadi: <b>${result.failed} ta</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: this.telegramService.getMainMenu(true, true),
      },
    );
  }

  @Action('broadcast_cancel')
  async onBroadcastCancel(ctx: Context) {
    await ctx.answerCbQuery();
    broadcastPending.delete(ctx.from!.id);
    await ctx.editMessageText('❌ Xabar tarqatish bekor qilindi.');
    await ctx.reply('🏠 Bosh menyu', {
      reply_markup: this.telegramService.getMainMenu(true, true),
    });
  }
}
