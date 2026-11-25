# Klient pro API VášPoukaz

Ukázkový klient pro rezervační a pokladní systémy, které přijímají dárkové poukazy prodané přes VášPoukaz. Kód můžete převzít a upravit pro svůj systém.

- Dokumentace: https://vaspoukaz.cz/firmy/api
- Reference API (Swagger UI): https://vaspoukaz.cz/api/v1/docs
- Specifikace OpenAPI: https://vaspoukaz.cz/api/v1/openapi.json

## Obsah repozitáře

| Cesta | Co obsahuje |
|---|---|
| `src/vaspoukaz-client.ts` | Klient bez závislostí: volání API, opakování požadavků, chyby a ověření podpisu webhooku. |
| `examples/quickstart.ts` | Ověření přístupu: vypíše propojení, produkty prodejce a volitelně vyhledá poukaz. |
| `examples/booking-demo/` | Ukázkový rezervační systém, který klienta používá. |
| `test/` | Testy klienta, které běží bez přístupu k API. |

## Spuštění

Potřebujete Node 22.18 nebo novější.

1. Nainstalujte závislosti: `npm install`
2. Vytvořte soubor s nastavením: `cp .env.example .env`
3. Do `.env` doplňte token (`VASPOUKAZ_TOKEN`). O testovací token požádejte na firmy@vaspoukaz.cz.
4. Ověřte přístup: `npm run quickstart`

| Příkaz | Co udělá |
|---|---|
| `npm run quickstart` | Vypíše, ke kterému prodejci token patří, a jeho produkty. |
| `npm run quickstart -- "KÓD POUKAZU"` | Navíc vyhledá poukaz podle kódu. Nic neuplatní. |
| `npm run demo` | Spustí ukázkový rezervační systém na http://localhost:4010. |
| `npm test` | Spustí testy klienta. |
| `npm run typecheck` | Zkontroluje typy. |

## Nastavení

| Proměnná | K čemu slouží |
|---|---|
| `VASPOUKAZ_TOKEN` | Token propojení s prodejcem (`vp_test_…` nebo `vp_live_…`). |
| `VASPOUKAZ_WEBHOOK_SECRET` | Secret pro ověření podpisu webhooků (`whsec_…`). Bez něj ukázka webhooky odmítá. |
| `VASPOUKAZ_BASE_URL` | Adresa API, výchozí `https://vaspoukaz.cz/api/v1`. |
| `PORT` | Port ukázkového rezervačního systému, výchozí `4010`. |

## Použití klienta

Soubor `src/vaspoukaz-client.ts` zkopírujte do svého projektu.

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

## Ukázkový rezervační systém

Příkaz `npm run demo` spustí malý rezervační systém. Rezervace drží jen v paměti a nemá přihlášení. Ukazuje skutečná volání API ve správném pořadí.

| V ukázce | Volání API | Kde v kódu |
|---|---|---|
| Ověřit poukaz podle kódu | `POST /v1/vouchers/lookup` | `/api/voucher/check` |
| Vytvořit rezervaci placenou poukazem | `POST /v1/holds` | `createBooking` |
| Zákazník přišel | `POST /v1/holds/{id}/capture` | `markVisited` |
| Zrušit rezervaci | `POST /v1/holds/{id}/release` | `cancelBooking` |
| Přijmout webhook a ověřit podpis | hlavička `VasPoukaz-Signature` | `handleWebhook`, `reactTo` |
| Vypsat produkty prodejce | `GET /v1/products` | `loadMerchant` |

Webhooky posíláme jen na veřejnou adresu `https://`. Při vývoji si ukázku zpřístupněte tunelem, například `cloudflared tunnel --url http://localhost:4010`, a adresu `https://…/webhooks/vaspoukaz` nám pošlete.
