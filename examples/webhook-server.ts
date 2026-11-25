/**
 * Webhooks: the smallest correct receiver.
 *
 *   npm run webhooks   -> listens on http://localhost:4020/webhooks/vaspoukaz
 *
 * Three rules it shows: verify the signature from the body exactly as it
 * arrived, answer 2xx quickly, and process every event id only once
 * (deliveries are at-least-once and may arrive out of order).
 */
import { createServer } from "node:http"
import { verifyWebhook } from "../src/vaspoukaz-client.ts"

const secret = process.env.VASPOUKAZ_WEBHOOK_SECRET
if (!secret) {
  console.error("Set VASPOUKAZ_WEBHOOK_SECRET (see .env.example).")
  process.exit(1)
}
const port = Number(process.env.WEBHOOK_PORT ?? 4020)

// In your system this is a table with a unique index on the event id.
const processed = new Set<string>()

createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/webhooks/vaspoukaz") {
    response.writeHead(404).end()
    return
  }

  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const rawBody = Buffer.concat(chunks).toString("utf8")

  const event = verifyWebhook({
    rawBody,
    signatureHeader: request.headers["vaspoukaz-signature"] as string | undefined,
    secret
  })
  if (!event) {
    response.writeHead(401).end()
    return
  }

  // Answer first; do slow work afterwards or in a queue.
  response.writeHead(204).end()

  if (processed.has(event.id)) return
  processed.add(event.id)
  console.log(event.type, event.id, event.data.voucher?.id ?? "")
}).listen(port, () => {
  console.log(`Webhook receiver: http://localhost:${port}/webhooks/vaspoukaz`)
})
