/**
 * The shortest check that your access works.
 *
 *   npm run quickstart                     -> who the token acts for, and their products
 *   npm run quickstart -- "3FA9 4C0B 7E21" -> also looks that voucher up (nothing is redeemed)
 */
import { VasPoukazApiError, VasPoukazClient } from "../src/vaspoukaz-client.ts"

const token = process.env.VASPOUKAZ_TOKEN
if (!token) {
  console.error("Set VASPOUKAZ_TOKEN (see .env.example).")
  process.exit(1)
}

const api = new VasPoukazClient({ token, baseUrl: process.env.VASPOUKAZ_BASE_URL })

try {
  console.log("Connection:", await api.me())

  const products = await api.listProducts()
  console.log(`Products (${products.data.length}):`)
  for (const product of products.data) console.log(" -", product.id, product.title)

  const code = process.argv[2]
  if (code) {
    const voucher = await api.lookupVoucher({ code })
    console.log("Voucher:", {
      id: voucher.id,
      status: voucher.status,
      redeemable: voucher.redeemable,
      not_redeemable_reason: voucher.not_redeemable_reason,
      unit: voucher.unit,
      available: voucher.available
    })
  }
} catch (error) {
  if (!(error instanceof VasPoukazApiError)) throw error
  console.error(`The API refused the request: ${error.code} (${error.status})`)
  process.exit(1)
}
