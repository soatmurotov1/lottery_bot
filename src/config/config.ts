// src/config/config.ts

export const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN!,
    adminId: parseInt(process.env.ADMIN_TELEGRAM_ID!),
    adminUsername: process.env.ADMIN_USERNAME ?? 'admin', // @ belgisisiz
  },
  game: {
    totalSlots: parseInt(process.env.TOTAL_SLOTS ?? '20'),
  },
  payment: {
    ticketPrice: parseInt(process.env.TICKET_PRICE ?? '50000'),
    deadlineMinutes: parseInt(process.env.PAYMENT_DEADLINE_MINUTES ?? '30'),
    bankName: process.env.BANK_NAME ?? 'Uzcard',
    cardNumber: process.env.CARD_NUMBER ?? '8600 0000 0000 0000',
    cardHolder: process.env.CARD_HOLDER ?? 'Ism Familya',
  },
};