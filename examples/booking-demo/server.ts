/**
 * A tiny booking system that accepts VášPoukaz gift vouchers.
 *
 * It is a demo of the integration, not a booking system to build on: bookings
 * live in memory and there is no login. What it does show, with real API calls:
 *
 *   booking made      -> look the voucher up, put a HOLD on it
 *   customer came     -> CAPTURE the hold (the voucher is redeemed)
 *   booking cancelled -> RELEASE the hold (the value is free again)
 *   webhook arrives   -> verify the signature, react to the event
 *
 * Run it from the repository root:  cp .env.example .env  (fill in the token)  &&  npm run demo
 */
import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  type ApiEvent,
  amountFor,
  type Connection,
  type Product,
  VasPoukazApiError,
  VasPoukazClient,
  type Voucher,
  verifyWebhook
} from "../../src/vaspoukaz-client.ts"

const token = process.env.VASPOUKAZ_TOKEN
if (!token) {
  console.error("Set VASPOUKAZ_TOKEN (see .env.example).")
  process.exit(1)
}
const webhookSecret = process.env.VASPOUKAZ_WEBHOOK_SECRET ?? ""
const port = Number(process.env.PORT ?? 4010)

const api = new VasPoukazClient({ token, baseUrl: process.env.VASPOUKAZ_BASE_URL })

// --- The booking system's own data (in memory) ---

/** What this fictional studio offers. Prices are in minor units, like the API. */
const services = [
  { id: "masaz-60", name: "Masáž 60 minut", price: 90000 },
  { id: "masaz-90", name: "Masáž 90 minut", price: 130000 },
  { id: "vstup", name: "Jednorázový vstup", price: 22000 }
]

interface Booking {
  id: string
  customer: string
  serviceId: string
  status: "booked" | "visited" | "cancelled"
  /** Set when the booking is paid, fully or in part, with a voucher. */
  voucher: {
    id: string
    number: string
    holdId: string
    /** What the hold covers, in words the staff understand. */
    covers: string
    /** False once VášPoukaz support released the hold (`hold.released`). */
    held: boolean
  } | null
  /** What the customer still pays on the spot, in minor units. */
  toPay: number
}

const bookings: Booking[] = []
const receivedEvents: { id: string; type: string; at: string; note: string }[] = []
const seenEventIds = new Set<string>()

// --- Voucher logic ---

/** What a voucher can pay of a service, and what is left for the customer. */
function coverage(voucher: Voucher, price: number): { covers: string; toPay: number } {
  if (voucher.unit === "money") {
    const { amount = 0 } = amountFor(voucher, price)
    return {
      covers: formatMoney(amount, voucher.balance.currency),
      toPay: price - amount
    }
  }
  // An entry pass or a single-use voucher pays for the service as such. A real
  // system checks `voucher.product.id` / `variant.id` against the booked
  // service here (the mapping the merchant set up once).
  return {
    covers: voucher.unit === "entries" ? "1 vstup z permanentky" : "celý poukaz",
    toPay: 0
  }
}

async function createBooking(input: {
  customer: string
  serviceId: string
  code: string
}): Promise<Booking> {
  const service = services.find((candidate) => candidate.id === input.serviceId)
  if (!service) throw new UserError("Vyberte službu.")

  const booking: Booking = {
    id: randomUUID().slice(0, 8),
    customer: input.customer.trim() || "Zákazník",
    serviceId: service.id,
    status: "booked",
    voucher: null,
    toPay: service.price
  }

  if (input.code.trim()) {
    const voucher = await api.lookupVoucher({ code: input.code })
    if (!voucher.redeemable) {
      throw new UserError(describeUnredeemable(voucher.not_redeemable_reason))
    }
    const { covers, toPay } = coverage(voucher, service.price)

    // The idempotency key comes from OUR booking id: if this request is sent
    // twice (a retry, a double click), the API returns the same hold.
    const hold = await api.createHold(
      {
        voucher_id: voucher.id,
        ...amountFor(voucher, service.price),
        reference: `rezervace-${booking.id}`
      },
      `rezervace-${booking.id}-blokace`
    )
    booking.voucher = {
      id: voucher.id,
      number: voucher.number,
      holdId: hold.id,
      covers,
      held: true
    }
    booking.toPay = toPay
  }

  bookings.unshift(booking)
  return booking
}

async function markVisited(booking: Booking): Promise<void> {
  if (booking.voucher?.held) {
    await api.captureHold(booking.voucher.holdId, {}, `rezervace-${booking.id}-potvrzeni`)
    booking.voucher.held = false
  }
  booking.status = "visited"
}

async function cancelBooking(booking: Booking): Promise<void> {
  if (booking.voucher?.held) {
    await api.releaseHold(booking.voucher.holdId, `rezervace-${booking.id}-uvolneni`)
    booking.voucher.held = false
  }
  booking.status = "cancelled"
}

// --- Webhooks ---

function handleWebhook(rawBody: string, signatureHeader: string | undefined): number {
  // Always from the raw body, before any parsing.
  const event = verifyWebhook({ rawBody, signatureHeader, secret: webhookSecret })
  if (!event) return 401

  // Deliveries are at-least-once: the same event may come again.
  if (seenEventIds.has(event.id)) return 204
  seenEventIds.add(event.id)

  receivedEvents.unshift({
    id: event.id,
    type: event.type,
    at: new Date().toLocaleTimeString("cs-CZ"),
    note: reactTo(event)
  })
  receivedEvents.splice(20)
  return 204
}

/** What the booking system does about an event. Unknown types are ignored. */
function reactTo(event: ApiEvent): string {
  const voucher = event.data.voucher
  switch (event.type) {
    case "voucher.issued":
      return `Prodán poukaz ${voucher?.number ?? ""} (${voucher?.product.title ?? ""}).`
    case "redemption.created":
      return `Poukaz ${voucher?.number ?? ""} byl uplatněn, zbývá ${formatBalance(voucher)}.`
    case "hold.released": {
      // Support released our hold: the booking is no longer paid by the voucher.
      const booking = bookings.find(
        (candidate) => candidate.voucher?.holdId === event.data.hold?.id
      )
      if (booking?.voucher) {
        booking.voucher.held = false
        const service = services.find((candidate) => candidate.id === booking.serviceId)
        booking.toPay = service?.price ?? booking.toPay
        return `Blokace rezervace ${booking.id} byla uvolněna, rezervace je znovu k úhradě.`
      }
      return "Blokace byla uvolněna."
    }
    case "voucher.refunded":
    case "voucher.cancelled":
      return `Poukaz ${voucher?.number ?? ""} už neplatí.`
    case "ping":
      return "Zkušební webhook dorazil a jeho podpis je platný."
    default:
      return "Bez reakce."
  }
}

// --- Messages for people ---

class UserError extends Error {}

/** `not_redeemable_reason` of a voucher, said the way a customer understands. */
function describeUnredeemable(reason: string | null): string {
  switch (reason) {
    case "expired":
      return "Platnost poukazu vypršela. Zákazník si ho může prodloužit."
    case "fully_redeemed":
      return "Poukaz už je celý vyčerpaný."
    case "fully_held":
      return "Poukaz je už použitý u jiné rezervace."
    case "not_activated":
      return "Poukaz ještě nebyl aktivován."
    default:
      return "Tento poukaz teď přijmout nejde."
  }
}

/** API errors are told apart by `code`; the English `message` is for developers. */
function describeApiError(error: VasPoukazApiError): string {
  switch (error.code) {
    case "voucher_not_found":
      return "Poukaz s tímto kódem jsme nenašli."
    case "insufficient_available_balance":
      return "Na poukazu není dost volné hodnoty, část drží jiná rezervace."
    case "voucher_expired":
      return "Platnost poukazu vypršela."
    case "hold_released":
      return "Blokace poukazu už byla uvolněna. Rezervaci je potřeba uhradit jinak."
    case "invalid_token":
    case "connection_revoked":
      return "Propojení s VášPoukaz nefunguje. Zkontrolujte token."
    default:
      return `Poukaz se nepodařilo zpracovat (${error.code}).`
  }
}

function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat("cs-CZ", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(minor / 100)
}

function formatBalance(voucher: Voucher | undefined): string {
  if (!voucher) return "?"
  return voucher.unit === "entries"
    ? `${voucher.balance.entries_remaining} vstupů`
    : formatMoney(voucher.balance.amount, voucher.balance.currency)
}

// --- HTTP ---

let connection: Connection | null = null
let products: Product[] = []

/** Who we act for and what they sell: read once, shown on the page. */
async function loadMerchant(): Promise<void> {
  connection = await api.me()
  products = []
  for await (const product of api.all((cursor) => api.listProducts(cursor))) {
    products.push(product)
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      body += chunk
    })
    request.on("end", () => resolve(body))
    request.on("error", reject)
  })
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  response.end(JSON.stringify(body))
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost")
  const method = request.method ?? "GET"

  if (method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    response.end(PAGE)
    return
  }

  if (method === "POST" && url.pathname === "/webhooks/vaspoukaz") {
    const status = handleWebhook(
      await readBody(request),
      request.headers["vaspoukaz-signature"] as string | undefined
    )
    response.writeHead(status).end()
    return
  }

  if (method === "GET" && url.pathname === "/api/state") {
    if (!connection) await loadMerchant()
    sendJson(response, 200, {
      merchant: connection?.organization,
      services,
      bookings,
      events: receivedEvents,
      products
    })
    return
  }

  const body =
    method === "POST"
      ? (JSON.parse((await readBody(request)) || "{}") as Record<string, string>)
      : {}

  if (method === "POST" && url.pathname === "/api/voucher/check") {
    const voucher = await api.lookupVoucher({ code: body.code ?? "" })
    sendJson(response, 200, {
      number: voucher.number,
      title: voucher.product.title,
      variant: voucher.product.variant?.label ?? null,
      redeemable: voucher.redeemable,
      problem: voucher.redeemable
        ? null
        : describeUnredeemable(voucher.not_redeemable_reason),
      available:
        voucher.unit === "entries"
          ? `${voucher.available.entries} vstupů`
          : formatMoney(voucher.available.amount ?? 0, voucher.balance.currency),
      expires: new Date(voucher.expires_at).toLocaleDateString("cs-CZ")
    })
    return
  }

  if (method === "POST" && url.pathname === "/api/bookings") {
    sendJson(
      response,
      201,
      await createBooking({
        customer: body.customer ?? "",
        serviceId: body.serviceId ?? "",
        code: body.code ?? ""
      })
    )
    return
  }

  const action = url.pathname.match(/^\/api\/bookings\/([^/]+)\/(visit|cancel)$/)
  if (method === "POST" && action) {
    const booking = bookings.find((candidate) => candidate.id === action[1])
    if (!booking || booking.status !== "booked") {
      throw new UserError("Rezervaci už nejde změnit.")
    }
    await (action[2] === "visit" ? markVisited(booking) : cancelBooking(booking))
    sendJson(response, 200, booking)
    return
  }

  sendJson(response, 404, { error: "Not found" })
}

createServer((request, response) => {
  route(request, response).catch((error: unknown) => {
    if (error instanceof VasPoukazApiError) {
      console.warn(`API refused: ${error.code} (request ${error.requestId})`)
      sendJson(response, 422, { error: describeApiError(error) })
    } else if (error instanceof UserError) {
      sendJson(response, 422, { error: error.message })
    } else {
      console.error(error)
      sendJson(response, 500, { error: "Něco se nepovedlo. Zkuste to prosím znovu." })
    }
  })
}).listen(port, () => {
  console.info(`Booking demo: http://localhost:${port}`)
  console.info(`Webhook address: http://localhost:${port}/webhooks/vaspoukaz`)
  if (!webhookSecret) console.info("No VASPOUKAZ_WEBHOOK_SECRET: webhooks are refused.")
})

// --- The page (one file, no build step) ---

const PAGE = `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rezervace Demo</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
  body { max-width: 60rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
  h1 { margin-bottom: 0; } h2 { margin-top: 2.5rem; font-size: 1.15rem; }
  .muted { opacity: .7; font-size: .9rem; }
  form, .card { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: .6rem; padding: 1rem; }
  label { display: block; font-weight: 600; margin-top: .75rem; }
  input, select { width: 100%; padding: .5rem; font: inherit; box-sizing: border-box; margin-top: .25rem; }
  button { font: inherit; padding: .5rem .9rem; border-radius: .4rem; border: 1px solid currentColor; background: none; color: inherit; cursor: pointer; }
  button.primary { background: #2f5d50; color: #fff; border-color: #2f5d50; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: 1rem; align-items: center; }
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: .45rem .5rem; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); vertical-align: top; }
  #message { min-height: 1.5rem; margin-top: .75rem; }
  .error { color: #b3261e; } .ok { color: #2f5d50; }
</style>
</head>
<body>
<h1>Rezervace Demo</h1>
<p class="muted" id="merchant">Načítáme obchodníka…</p>

<h2>Nová rezervace</h2>
<form id="booking">
  <label for="customer">Jméno zákazníka</label>
  <input id="customer" name="customer" autocomplete="off">
  <label for="service">Služba</label>
  <select id="service" name="serviceId"></select>
  <label for="code">Kód dárkového poukazu (nepovinné)</label>
  <input id="code" name="code" autocomplete="off" placeholder="např. 3FA9 4C0B 7E21">
  <div class="row">
    <button type="button" id="check">Ověřit poukaz</button>
    <button type="submit" class="primary">Vytvořit rezervaci</button>
  </div>
  <p id="message" role="status"></p>
</form>

<h2>Rezervace</h2>
<div class="card"><table><thead><tr><th>Zákazník</th><th>Služba</th><th>Poukaz</th><th>Doplatek</th><th>Stav</th><th></th></tr></thead><tbody id="bookings"></tbody></table></div>

<h2>Přijaté webhooky</h2>
<div class="card"><table><thead><tr><th>Čas</th><th>Událost</th><th>Co jsme s ní udělali</th></tr></thead><tbody id="events"></tbody></table></div>

<h2>Produkty obchodníka</h2>
<p class="muted">Seznam z <code>GET /v1/products</code>. Skutečný systém by tu obchodníkovi dal přiřadit produkty ke službám.</p>
<div class="card"><table><thead><tr><th>Produkt</th><th>Čerpání</th><th>Varianty</th></tr></thead><tbody id="products"></tbody></table></div>

<script>
const money = (minor) => new Intl.NumberFormat("cs-CZ", { style: "currency", currency: "CZK", maximumFractionDigits: 0 }).format(minor / 100)
const statusLabel = { booked: "Rezervováno", visited: "Proběhlo", cancelled: "Zrušeno" }
const unitLabel = { money: "částka", entries: "vstupy", whole: "celý poukaz" }
const message = document.getElementById("message")

function say(text, isError) { message.textContent = text; message.className = isError ? "error" : "ok" }

async function call(path, body) {
  const response = await fetch(path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
  const json = await response.json()
  if (!response.ok) throw new Error(json.error)
  return json
}

function row(cells) {
  const tr = document.createElement("tr")
  for (const cell of cells) {
    const td = document.createElement("td")
    if (cell instanceof Node) td.append(cell); else td.textContent = cell
    tr.append(td)
  }
  return tr
}

function actions(booking) {
  const wrap = document.createElement("div"); wrap.className = "row"; wrap.style.marginTop = "0"
  if (booking.status !== "booked") return wrap
  for (const [action, label] of [["visit", "Zákazník přišel"], ["cancel", "Zrušit rezervaci"]]) {
    const button = document.createElement("button"); button.textContent = label
    button.onclick = async () => { try { await call("/api/bookings/" + booking.id + "/" + action, {}); say("Hotovo."); } catch (error) { say(error.message, true) } refresh() }
    wrap.append(button)
  }
  return wrap
}

async function refresh() {
  const state = await call("/api/state")
  document.getElementById("merchant").textContent = "Propojeno s obchodníkem " + state.merchant.name + ". Rezervace se ukládají jen do paměti."
  const select = document.getElementById("service")
  if (!select.options.length) for (const service of state.services) select.add(new Option(service.name + " (" + money(service.price) + ")", service.id))
  const names = Object.fromEntries(state.services.map((service) => [service.id, service.name]))
  document.getElementById("bookings").replaceChildren(...state.bookings.map((booking) => row([
    booking.customer, names[booking.serviceId],
    booking.voucher ? booking.voucher.number + ": " + booking.voucher.covers + (booking.voucher.held ? " (blokováno)" : "") : "bez poukazu",
    money(booking.toPay), statusLabel[booking.status], actions(booking)
  ])))
  document.getElementById("events").replaceChildren(...state.events.map((event) => row([event.at, event.type, event.note])))
  document.getElementById("products").replaceChildren(...state.products.map((product) => row([
    product.title, unitLabel[product.unit], product.variants.map((variant) => variant.label).filter(Boolean).join(", ") || "bez variant"
  ])))
}

document.getElementById("check").onclick = async () => {
  try {
    const voucher = await call("/api/voucher/check", { code: document.getElementById("code").value })
    say(voucher.problem ?? ("Poukaz " + voucher.number + " (" + voucher.title + (voucher.variant ? ", " + voucher.variant : "") + ") je v pořádku. Volné: " + voucher.available + ", platí do " + voucher.expires + "."), !voucher.redeemable)
  } catch (error) { say(error.message, true) }
}

document.getElementById("booking").onsubmit = async (event) => {
  event.preventDefault()
  try {
    const booking = await call("/api/bookings", Object.fromEntries(new FormData(event.target)))
    say(booking.voucher ? "Rezervace je vytvořená a poukaz zablokovaný. Doplatek: " + money(booking.toPay) + "." : "Rezervace je vytvořená.")
    event.target.reset()
  } catch (error) { say(error.message, true) }
  refresh()
}

refresh(); setInterval(refresh, 5000)
</script>
</body>
</html>`
