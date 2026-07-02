// src/lottery/dto/book-slot.dto.ts

export class BookSlotDto {
  slotNumber: number;
  telegramId: string;
  username?: string;
  fullName: string;
}

// src/lottery/dto/confirm-payment.dto.ts
export class ConfirmPaymentDto {
  slotNumber: number;
  userId: number;     // DB user ID
  approved: boolean;
}