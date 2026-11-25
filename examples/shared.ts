/** What every example needs: a client built from `.env` and one way to report a refusal. */
import { VasPoukazApiError, VasPoukazClient } from "../src/vaspoukaz-client.ts"

export function clientFromEnv(): VasPoukazClient {
  const token = process.env.VASPOUKAZ_TOKEN
  if (!token) {
    console.error("Set VASPOUKAZ_TOKEN (see .env.example).")
    process.exit(1)
  }
  return new VasPoukazClient({ token, baseUrl: process.env.VASPOUKAZ_BASE_URL })
}

/** Runs an example and prints an API refusal by its stable `code`. */
export async function run(example: () => Promise<void>): Promise<void> {
  try {
    await example()
  } catch (error) {
    if (!(error instanceof VasPoukazApiError)) throw error
    console.error(`The API refused the request: ${error.code} (${error.status})`)
    console.error(`request id: ${error.requestId ?? "-"}`)
    process.exit(1)
  }
}

/** Stops with the usage line when a required argument is missing. */
export function requireArg(value: string | undefined, usage: string): string {
  if (value) return value
  console.error(`Usage: ${usage}`)
  process.exit(1)
}
