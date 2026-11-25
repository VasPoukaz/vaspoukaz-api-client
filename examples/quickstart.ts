/**
 * Connection: the shortest check that your access works.
 *
 *   npm run quickstart                     -> who the token acts for, and their products
 *   npm run quickstart -- "3FA9 4C0B 7E21" -> also looks that voucher up (nothing is redeemed)
 */
import { clientFromEnv, run } from "./shared.ts"

const api = clientFromEnv()

await run(async () => {
  console.log("Connection:", await api.me())

  const products = await api.listProducts()
  console.log(`Products (${products.data.length}):`)
  for (const product of products.data) console.log(" -", product.id, product.title)

  const code = process.argv[2]
  if (!code) return
  const voucher = await api.lookupVoucher({ code })
  console.log("Voucher:", {
    id: voucher.id,
    status: voucher.status,
    redeemable: voucher.redeemable,
    not_redeemable_reason: voucher.not_redeemable_reason,
    unit: voucher.unit,
    available: voucher.available
  })
})
