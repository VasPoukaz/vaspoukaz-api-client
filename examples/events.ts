/**
 * Events: read what happened to the merchant's vouchers without a webhook
 * address, or catch up after an outage. Events carry the same objects as webhooks.
 *
 *   npm run events
 */
import { clientFromEnv, run } from "./shared.ts"

const api = clientFromEnv()

await run(async () => {
  let count = 0
  // In your system, store the id of the last event you processed and continue
  // from it next time: `api.listEvents(lastEventId)`.
  for await (const event of api.all((cursor) => api.listEvents(cursor))) {
    count += 1
    console.log(event.created_at, event.type, event.data.voucher?.id ?? "")
  }
  console.log(`${count} events.`)
})
