/**
 * Holds: a booking paid with a voucher, start to finish.
 *
 *   npm run booking -- "<code>" <price> capture   -> the customer came
 *   npm run booking -- "<code>" <price> release   -> the booking was cancelled
 *
 * <price> is what the service costs, in minor units (40000 = 400 Kč). It is
 * ignored for a voucher redeemed by entries or as a whole.
 */
import { amountFor } from "../src/vaspoukaz-client.ts"
import { clientFromEnv, requireArg, run } from "./shared.ts"

const usage = 'npm run booking -- "<code>" <price> capture|release'
const code = requireArg(process.argv[2], usage)
const price = Number(requireArg(process.argv[3], usage))
const outcome = requireArg(process.argv[4], usage)

// In your system this is the id of the booking. Every Idempotency-Key is
// derived from it, so a request repeated after a lost answer never writes twice.
const bookingId = `booking-${Date.now()}`
const api = clientFromEnv()

await run(async () => {
  // 1. The customer types the code into the booking form.
  const voucher = await api.lookupVoucher({ code })
  if (!voucher.redeemable) {
    console.log(`The voucher cannot be accepted: ${voucher.not_redeemable_reason}`)
    return
  }

  // 2. The customer confirms the booking: reserve the value.
  const amount = amountFor(voucher, price)
  const hold = await api.createHold(
    { voucher_id: voucher.id, ...amount, reference: bookingId },
    `${bookingId}-hold`
  )
  console.log(`Hold ${hold.id} is ${hold.status}.`)
  if (amount.amount !== undefined && amount.amount < price) {
    console.log(`Collect the rest from the customer: ${price - amount.amount}`)
  }

  if (outcome === "capture") {
    // 3a. The customer came: the held value is redeemed.
    const redemption = await api.captureHold(hold.id, {}, `${bookingId}-capture`)
    console.log(`Redemption ${redemption.id} is ${redemption.status}.`)
  } else {
    // 3b. The booking was cancelled: the value is free again.
    const released = await api.releaseHold(hold.id, `${bookingId}-release`)
    console.log(`Hold is ${released.status}.`)
  }

  const after = await api.getVoucher(voucher.id)
  console.log("Voucher now:", { status: after.status, available: after.available })
})
