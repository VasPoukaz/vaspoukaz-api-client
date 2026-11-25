# Klient pro API VášPoukaz

Ukázkový klient pro rezervační a pokladní systémy, které přijímají dárkové poukazy prodané přes VášPoukaz. Můžete ho převzít a upravit pro svůj systém.

- Dokumentace: https://vaspoukaz.cz/firmy/api
- Reference API (Swagger UI): https://vaspoukaz.cz/api/v1/docs
- Specifikace OpenAPI: https://vaspoukaz.cz/api/v1/openapi.json

## Použití

Klient je jeden soubor v TypeScriptu bez závislostí. Potřebuje Node 18 nebo novější. Soubor `vaspoukaz-client.ts` zkopírujte do svého projektu.

```ts
import { VasPoukazClient, amountFor } from "./vaspoukaz-client.ts"

const api = new VasPoukazClient({ token: process.env.VASPOUKAZ_TOKEN! })

// 1. Zákazník zadá kód poukazu.
const voucher = await api.lookupVoucher({ code: "3FA9 4C0B 7E21" })
if (!voucher.redeemable) throw new Error(voucher.not_redeemable_reason ?? "")

// 2. Zákazník dokončí rezervaci: hodnotu poukazu zablokujete.
const hold = await api.createHold(
  { voucher_id: voucher.id, ...amountFor(voucher, 40000), reference: "booking-48211" },
  "booking-48211-hold"
)

// 3a. Zákazník dorazí: zablokovanou hodnotu odečtete.
await api.captureHold(hold.id, {}, "booking-48211-capture")
// 3b. Zákazník rezervaci zruší: blokaci uvolníte.
await api.releaseHold(hold.id, "booking-48211-release")
```

## Testovací přístup

O testovací token požádejte na firmy@vaspoukaz.cz.
