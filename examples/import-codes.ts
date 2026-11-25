/**
 * Codes: sell vouchers under your own codes. Imports codes into a product's
 * pool; a voucher sold afterwards carries one of them.
 *
 *   npm run import-codes -- <product-id> <code> [<code> ...]
 *   npm run import-codes -- <product-id> --variant=<variant-id> <code> [<code> ...]
 *
 * The connection needs the `codes:write` scope. An import is all or nothing.
 */
import { clientFromEnv, requireArg, run } from "./shared.ts"

const usage = "npm run import-codes -- <product-id> [--variant=<variant-id>] <code> [<code> ...]"
const productId = requireArg(process.argv[2], usage)
const rest = process.argv.slice(3)
const variantId = rest.find((arg) => arg.startsWith("--variant="))?.split("=")[1]
const codes = rest.filter((arg) => !arg.startsWith("--"))
requireArg(codes[0], usage)

const api = clientFromEnv()

await run(async () => {
  const result = await api.importCodes(
    productId,
    { codes, ...(variantId && { variant_id: variantId }) },
    // The same batch sent twice must not be imported twice.
    `import-${productId}-${codes.join("-")}`.slice(0, 255)
  )
  console.log(`Imported ${result.added} codes.`)
})
