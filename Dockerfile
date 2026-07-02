# ---------- 1-BOSQICH: BUILD ----------
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build


# ---------- 2-BOSQICH: PRODUCTION ----------
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

EXPOSE 3000

# Konteyner ishga tushganda: avval migratsiyalarni qo'llaydi, keyin appni ishga tushiradi
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]