/**
 * Connection: going live. Exchanges the one-time pairing code a merchant got
 * in VášPoukaz (Nastavení → Propojení) for that merchant's token.
 *
 *   npm run connect -- <pairing-code>
 *
 * Needs VASPOUKAZ_INTEGRATION_SECRET (`vpi_…`), which you get from us when
 * your integration is finished. Run this on your server, never on a
 * merchant's device.
 */
import { claimConnection, VasPoukazClient } from "../src/vaspoukaz-client.ts"
import { requireArg, run } from "./shared.ts"

const pairingCode = requireArg(process.argv[2], "npm run connect -- <pairing-code>")
const integrationSecret = process.env.VASPOUKAZ_INTEGRATION_SECRET
if (!integrationSecret) {
  console.error("Set VASPOUKAZ_INTEGRATION_SECRET (see .env.example).")
  process.exit(1)
}

await run(async () => {
  const connection = await claimConnection({
    integrationSecret,
    pairingCode,
    baseUrl: process.env.VASPOUKAZ_BASE_URL
  })

  // The token is returned only here. In your system, store it encrypted next
  // to the merchant's account; this example only proves that it works.
  const api = new VasPoukazClient({
    token: connection.token,
    baseUrl: process.env.VASPOUKAZ_BASE_URL
  })
  const me = await api.me()
  console.log(`Connected: ${me.organization.id}, scopes ${me.scopes.join(", ")}`)
  console.log(`Token received (${connection.token.slice(0, 8)}…). Store it now.`)
})
