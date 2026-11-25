/**
 * Example client for the VášPoukaz API (https://vaspoukaz.cz/firmy/api).
 *
 * One file, no dependencies: Node 18 or newer. It uses only TypeScript syntax
 * that Node can strip by itself, so Node 22.18+ runs it as it is
 * (`node your-script.ts`), and any bundler or `tsc` handles it on older
 * versions. Copy it into your project and change it as you like. It shows the
 * parts that are easy to get wrong:
 *
 *   - every write carries an Idempotency-Key and is retried with the SAME key,
 *     so a lost answer never redeems a voucher twice;
 *   - errors are told apart by their stable `code`, never by the message;
 *   - a webhook is verified from the raw body before anything is parsed.
 *
 * A booking paid with a voucher, start to finish:
 *
 *   const api = new VasPoukazClient({ token: process.env.VASPOUKAZ_TOKEN! })
 *
 *   // 1. The customer types the code into the booking form.
 *   const voucher = await api.lookupVoucher({ code: "3FA9 4C0B 7E21" })
 *   if (!voucher.redeemable) throw new Error(voucher.not_redeemable_reason ?? "")
 *
 *   // 2. Reserve it for the booking. Derive the key from YOUR booking id.
 *   const hold = await api.createHold(
 *     { voucher_id: voucher.id, ...amountFor(voucher, 40000), reference: "booking-48211" },
 *     "booking-48211-hold"
 *   )
 *
 *   // 3a. The customer came: turn the hold into a redemption.
 *   await api.captureHold(hold.id, {}, "booking-48211-capture")
 *   // 3b. Or the booking was cancelled: give the value back.
 *   await api.releaseHold(hold.id, "booking-48211-release")
 */
import { createHmac, timingSafeEqual } from "node:crypto"

export const DEFAULT_BASE_URL = "https://vaspoukaz.cz/api/v1"

// --- Objects (only the fields a client usually needs; the API returns more) ---

/** Money is always an integer in minor units: 1 000 Kč is 100000. */
export interface Money {
  amount: number
  currency: string
}

/** How a voucher is redeemed, and so what you send: see `amountFor`. */
export type VoucherUnit = "money" | "entries" | "whole"

export interface Voucher {
  id: string
  number: string
  status: string
  /** The one field to decide on. When false, `not_redeemable_reason` says why. */
  redeemable: boolean
  not_redeemable_reason: string | null
  unit: VoucherUnit
  product: {
    id: string
    title: string
    variant: { id: string; label: string | null } | null
  }
  /** What was paid for the voucher; use it to compute a top-up on your side. */
  value: Money | null
  balance: Money & { entries_total: number | null; entries_remaining: number | null }
  /** Reserved by bookings (yours and others'), and what is free right now. */
  held: { amount: number | null; entries: number | null }
  available: { amount: number | null; entries: number | null }
  /** Your own active holds on this voucher. */
  holds: { id: string; amount: number | null; reference: string | null }[]
  expires_at: string
}

export interface Hold {
  id: string
  voucher_id: string
  status: "active" | "captured" | "released"
  amount: number | null
  reference: string | null
  redemption_id: string | null
  voucher?: Voucher
}

export interface Redemption {
  id: string
  voucher_id: string
  status: "completed" | "reversed"
  amount: number
  currency: string
  hold_id: string | null
  reference: string | null
  voucher?: Voucher
}

export interface Product {
  id: string
  title: string
  unit: VoucherUnit
  state: string
  variants: { id: string; label: string | null; entries: number | null }[]
  code_pool: { available: number } | null
}

export interface ApiEvent {
  id: string
  type: string
  organization_id: string
  created_at: string
  data: { voucher?: Voucher; redemption?: Redemption; hold?: Hold } & Record<
    string,
    unknown
  >
}

export interface Page<T> {
  data: T[]
  has_more: boolean
  next_cursor: string | null
}

export interface Connection {
  id: string
  livemode: boolean
  scopes: string[]
  integration: { id: string; name: string }
  organization: {
    id: string
    name: string
    slug: string
    country: string | null
    currency: string
  }
}

// --- Errors ---

/**
 * Any answer that is not 2xx. Branch on `code`: it is the stable contract.
 * `message` is English text for developers and may change.
 */
export class VasPoukazApiError extends Error {
  readonly status: number
  readonly type: string
  readonly code: string
  /** Send this to us when you need a request looked at. */
  readonly requestId: string | null
  /** The whole error object: `param`, `errors` of a rejected code import, … */
  readonly details: Record<string, unknown>

  constructor(input: {
    status: number
    type: string
    code: string
    message: string
    requestId: string | null
    details: Record<string, unknown>
  }) {
    super(`${input.code}: ${input.message}`)
    this.name = "VasPoukazApiError"
    this.status = input.status
    this.type = input.type
    this.code = input.code
    this.requestId = input.requestId
    this.details = input.details
  }
}

// --- Client ---

export interface ClientOptions {
  /** `vp_live_…` or `vp_test_…`: one token acts for exactly one merchant. */
  token: string
  baseUrl?: string
  /** How many times a failed request is sent again (default 3). */
  maxRetries?: number
  fetch?: typeof fetch
}

interface RequestOptions {
  body?: unknown
  query?: Record<string, string | number | undefined>
  idempotencyKey?: string
}

/** What the server asks us to try again: nothing was decided yet. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

export class VasPoukazClient {
  private readonly token: string
  private readonly baseUrl: string
  private readonly maxRetries: number
  private readonly fetchImpl: typeof fetch

  constructor(options: ClientOptions) {
    this.token = options.token
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")
    this.maxRetries = options.maxRetries ?? 3
    this.fetchImpl = options.fetch ?? fetch
  }

  /** Verifies the token and names the merchant. Store `organization.id`: webhooks carry it. */
  me(): Promise<Connection> {
    return this.request("GET", "/me")
  }

  // Vouchers

  /**
   * Finds a voucher by the code its holder typed, or by the raw content of the
   * QR on it. Case, spaces and hyphens in a code do not matter. An unknown
   * code throws `voucher_not_found`.
   */
  lookupVoucher(input: { code: string } | { scan: string }): Promise<Voucher> {
    return this.request("POST", "/vouchers/lookup", { body: input })
  }

  getVoucher(id: string): Promise<Voucher> {
    return this.request("GET", `/vouchers/${encodeURIComponent(id)}`)
  }

  // Holds: reserve at booking time, capture at the visit, release on cancellation

  /**
   * Reserves part of a voucher for a booking. Nothing is redeemed yet, and a
   * hold never expires: it ends only by `captureHold` or `releaseHold`.
   * Send `amount` and `currency` only for `unit: "money"` (see `amountFor`).
   */
  createHold(
    input: {
      voucher_id?: string
      code?: string
      amount?: number
      currency?: string
      /** Your booking id: the merchant sees it next to the voucher. */
      reference?: string
    },
    idempotencyKey: string
  ): Promise<Hold> {
    return this.request("POST", "/holds", { body: input, idempotencyKey })
  }

  /** Turns a hold into a redemption. A smaller `amount` frees the rest. */
  captureHold(
    holdId: string,
    input: { amount?: number; currency?: string; note?: string },
    idempotencyKey: string
  ): Promise<Redemption> {
    return this.request("POST", `/holds/${encodeURIComponent(holdId)}/capture`, {
      body: input,
      idempotencyKey
    })
  }

  /** Frees a hold. Releasing a released hold is fine; a captured one is not. */
  releaseHold(holdId: string, idempotencyKey: string): Promise<Hold> {
    return this.request("POST", `/holds/${encodeURIComponent(holdId)}/release`, {
      idempotencyKey
    })
  }

  // Redemptions: for payment on the spot, without a booking

  redeem(
    input: {
      voucher_id?: string
      code?: string
      amount?: number
      currency?: string
      /** Your receipt or booking id. */
      reference?: string
      note?: string
    },
    idempotencyKey: string
  ): Promise<Redemption> {
    return this.request("POST", "/redemptions", { body: input, idempotencyKey })
  }

  /**
   * Takes back a redemption YOUR system made, to correct a mistake: whole, and
   * only within 7 days. For a cancelled booking use a hold and release it.
   */
  reverseRedemption(
    redemptionId: string,
    reason: string | undefined,
    idempotencyKey: string
  ): Promise<Redemption> {
    return this.request(
      "POST",
      `/redemptions/${encodeURIComponent(redemptionId)}/reverse`,
      { body: reason ? { reason } : {}, idempotencyKey }
    )
  }

  // Products: map them to your own services once per merchant

  listProducts(cursor?: string): Promise<Page<Product>> {
    return this.request("GET", "/products", {
      query: { limit: 100, starting_after: cursor }
    })
  }

  /** Imports your own codes into a product's pool. All or nothing: see `errors` on failure. */
  importCodes(
    productId: string,
    input: { codes: string[]; variant_id?: string },
    idempotencyKey: string
  ): Promise<{ added: number }> {
    return this.request("POST", `/products/${encodeURIComponent(productId)}/codes`, {
      body: input,
      idempotencyKey
    })
  }

  // Events: the same objects webhooks carry, to catch up after an outage

  listEvents(cursor?: string): Promise<Page<ApiEvent>> {
    return this.request("GET", "/events", {
      query: { limit: 100, starting_after: cursor }
    })
  }

  /** Walks every page of a list: `for await (const product of api.all((c) => api.listProducts(c)))`. */
  async *all<T>(fetchPage: (cursor?: string) => Promise<Page<T>>): AsyncGenerator<T> {
    let cursor: string | undefined
    do {
      const page = await fetchPage(cursor)
      yield* page.data
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined
    } while (cursor)
  }

  /**
   * One request with retries. A retry repeats the request unchanged, with the
   * same Idempotency-Key, so the server answers a write it has already done
   * instead of doing it again. That is what makes retrying a redemption safe.
   */
  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value))
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` }
    if (options.body !== undefined) headers["Content-Type"] = "application/json"
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey

    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body)
        })
      } catch (networkError) {
        // No answer at all: we cannot know whether the write happened. Ask again.
        if (attempt >= this.maxRetries) throw networkError
        await sleep(backoffMs(attempt))
        continue
      }

      if (response.ok) return (await response.json()) as T

      const error = await readError(response)
      const retryable =
        RETRYABLE_STATUS.has(response.status) || error.code === "request_in_progress"
      if (!retryable || attempt >= this.maxRetries) throw error
      const retryAfter = Number(response.headers.get("Retry-After"))
      await sleep(retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt))
    }
  }
}

async function readError(response: Response): Promise<VasPoukazApiError> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: Record<string, unknown>
  }
  const error = body.error ?? {}
  return new VasPoukazApiError({
    status: response.status,
    type: String(error.type ?? "api_error"),
    code: String(error.code ?? "unknown_error"),
    message: String(error.message ?? response.statusText),
    requestId:
      (error.request_id as string | undefined) ?? response.headers.get("X-Request-Id"),
    details: error
  })
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8000)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- Helpers ---

/**
 * The amount fields a hold or a redemption needs for this voucher: an amount
 * for `unit: "money"`, nothing for `entries` (one entry per call) and `whole`.
 * `wanted` is what the booking costs, in minor units.
 */
export function amountFor(
  voucher: {
    unit: VoucherUnit
    available: { amount: number | null }
    balance: { currency: string }
  },
  wanted: number
): { amount?: number; currency?: string } {
  if (voucher.unit !== "money") return {}
  // Never ask for more than is free: collect the rest from the customer yourself.
  const amount = Math.min(wanted, voucher.available.amount ?? 0)
  return { amount, currency: voucher.balance.currency }
}

/**
 * Going live: exchanges the one-time pairing code a merchant got in VášPoukaz
 * (Nastavení → Propojení) for that merchant's token. Authenticated by your
 * integration secret (`vpi_…`), not by a token. Store the token at once: it is
 * returned only here.
 */
export async function claimConnection(input: {
  integrationSecret: string
  pairingCode: string
  baseUrl?: string
  fetch?: typeof fetch
}): Promise<Connection & { token: string }> {
  const response = await (input.fetch ?? fetch)(
    `${(input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")}/connections`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.integrationSecret}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ pairing_code: input.pairingCode })
    }
  )
  if (!response.ok) throw await readError(response)
  return (await response.json()) as Connection & { token: string }
}

/**
 * Checks that a webhook really came from VášPoukaz. Pass the body EXACTLY as
 * received (the raw string or bytes), not JSON you parsed and serialized again:
 * the signature covers the bytes. Returns the parsed event, or null when the
 * signature is wrong or older than the tolerance (a replayed request).
 *
 * Header: `VasPoukaz-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`
 *
 * Answer 2xx quickly and dedupe by `event.id`: deliveries are at-least-once
 * and may arrive out of order.
 */
export function verifyWebhook(input: {
  rawBody: string
  signatureHeader: string | null | undefined
  /** `whsec_…`, the signing secret of your integration. */
  secret: string
  toleranceSeconds?: number
  /** Unix seconds; only for tests. */
  now?: number
}): ApiEvent | null {
  const parts = new Map<string, string>()
  for (const part of (input.signatureHeader ?? "").split(",")) {
    const separator = part.indexOf("=")
    if (separator > 0)
      parts.set(part.slice(0, separator).trim(), part.slice(separator + 1))
  }
  const timestamp = Number(parts.get("t"))
  const signature = parts.get("v1")
  if (!Number.isInteger(timestamp) || !signature) return null

  const now = input.now ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > (input.toleranceSeconds ?? 300)) return null

  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.rawBody}`)
    .digest()
  const given = Buffer.from(signature, "hex")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  return JSON.parse(input.rawBody) as ApiEvent
}
