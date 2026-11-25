/**
 * Redemptions: payment with a voucher on the spot, without a booking.
 *
 *   npm run redemption -- "<code>" <price>            -> redeems
 *   npm run redemption -- "<code>" <price> --reverse  -> redeems and takes it back (a mistake at the till)
 *
 * <price> is in minor units (40000 = 400 Kč); ignored for a voucher redeemed
 * by entries or as a whole.
 */
import { amountFor } from "../src/vaspoukaz-client.ts"
import { clientFromEnv, requireArg, run } from "./shared.ts"

const usage = 'npm run redemption -- "<code>" <price> [--reverse]'
const code = requireArg(process.argv[2], usage)
const price = Number(requireArg(process.argv[3], usage))
const reverse = process.argv.includes("--reverse")

// In your system this is the id of the receipt.
const receiptId = `receipt-${Date.now()}`
const api = clientFromEnv()

await run(async () => {
  const voucher = await api.lookupVoucher({ code })
  if (!voucher.redeemable) {
    console.log(`The voucher cannot be accepted: ${voucher.not_redeemable_reason}`)
    return
  }

  const redemption = await api.redeem(
    { voucher_id: voucher.id, ...amountFor(voucher, price), reference: receiptId },
    `${receiptId}-redeem`
  )
  console.log(`Redemption ${redemption.id} is ${redemption.status}.`)

  if (reverse) {
    const reversed = await api.reverseRedemption(
      redemption.id,
      "Wrong voucher entered at the till",
      `${receiptId}-reverse`
    )
    console.log(`Redemption is ${reversed.status}.`)
  }

  const after = await api.getVoucher(voucher.id)
  console.log("Voucher now:", { status: after.status, available: after.available })
})
