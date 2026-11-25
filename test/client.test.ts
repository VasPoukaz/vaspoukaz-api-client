import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { test } from "node:test"
import {
  amountFor,
  VasPoukazApiError,
  VasPoukazClient,
  verifyWebhook
} from "../src/vaspoukaz-client.ts"

const SECRET = "whsec_test"
const NOW = 1_800_000_000

function sign(rawBody: string, timestamp = NOW, secret = SECRET): string {
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex")
  return `t=${timestamp},v1=${signature}`
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })

test("verifyWebhook accepts a correctly signed body", () => {
  const rawBody = JSON.stringify({ id: "evt_1", type: "ping" })
  const event = verifyWebhook({
    rawBody,
    signatureHeader: sign(rawBody),
    secret: SECRET,
    now: NOW
  })
  assert.equal(event?.id, "evt_1")
})

test("verifyWebhook refuses a changed body, a wrong secret and an old timestamp", () => {
  const rawBody = JSON.stringify({ id: "evt_1", type: "ping" })
  const base = { secret: SECRET, now: NOW }
  assert.equal(
    verifyWebhook({ ...base, rawBody: `${rawBody} `, signatureHeader: sign(rawBody) }),
    null
  )
  assert.equal(
    verifyWebhook({
      ...base,
      rawBody,
      signatureHeader: sign(rawBody, NOW, "whsec_other")
    }),
    null
  )
  assert.equal(
    verifyWebhook({ ...base, rawBody, signatureHeader: sign(rawBody, NOW - 3600) }),
    null
  )
  assert.equal(verifyWebhook({ ...base, rawBody, signatureHeader: null }), null)
})

test("amountFor sends an amount only for a voucher redeemed by money", () => {
  const money = {
    unit: "money" as const,
    available: { amount: 30000 },
    balance: { currency: "CZK" }
  }
  // Never more than is free: the rest is collected from the customer.
  assert.deepEqual(amountFor(money, 40000), { amount: 30000, currency: "CZK" })
  assert.deepEqual(amountFor({ ...money, unit: "entries" }, 40000), {})
  assert.deepEqual(amountFor({ ...money, unit: "whole" }, 40000), {})
})

test("a write is retried with the same Idempotency-Key", async () => {
  const keys: (string | null)[] = []
  const fakeFetch: typeof fetch = async (_url, init) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key"))
    return keys.length === 1
      ? json(503, { error: { type: "api_error", code: "unavailable", message: "" } })
      : json(201, { id: "hold_1", status: "active" })
  }
  const api = new VasPoukazClient({ token: "vp_test_x", fetch: fakeFetch })

  const hold = await api.createHold({ voucher_id: "v_1" }, "booking-1-hold")

  assert.equal(hold.id, "hold_1")
  assert.deepEqual(keys, ["booking-1-hold", "booking-1-hold"])
})

test("a refusal is thrown with its stable code", async () => {
  const fakeFetch: typeof fetch = async () =>
    json(404, {
      error: { type: "invalid_request", code: "voucher_not_found", message: "No such voucher." }
    })
  const api = new VasPoukazClient({ token: "vp_test_x", fetch: fakeFetch })

  await assert.rejects(
    () => api.lookupVoucher({ code: "0000" }),
    (error: unknown) =>
      error instanceof VasPoukazApiError &&
      error.code === "voucher_not_found" &&
      error.status === 404
  )
})
