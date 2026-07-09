-- CreateTable
CREATE TABLE "hubspot_tokens" (
    "id" TEXT NOT NULL,
    "access_token_cipher" TEXT NOT NULL,
    "refresh_token_cipher" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hubspot_tokens_pkey" PRIMARY KEY ("id")
);
