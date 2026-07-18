/**
 * Gated download for StockBot.
 *
 * Flow: after a buyer pays, Stripe redirects them to success.html with the
 * checkout session id. That page calls this function. We verify with Stripe
 * (server-side, using the secret key) that the session was actually PAID, and
 * only then hand back a short-lived (15-min) presigned link to the file in a
 * PRIVATE Cloudflare R2 bucket. The file is never publicly reachable, so it
 * can't be downloaded without a completed purchase.
 *
 * Required environment variables (set in Netlify → Site settings → Environment):
 *   STRIPE_SECRET_KEY      - Stripe secret key (sk_live_... or sk_test_...)
 *   R2_ACCOUNT_ID          - Cloudflare account id
 *   R2_ACCESS_KEY_ID       - R2 API token access key id
 *   R2_SECRET_ACCESS_KEY   - R2 API token secret
 *   R2_BUCKET              - bucket name, e.g. "stockbot-downloads"
 *   R2_FILE_KEY            - object key, e.g. "StockBot-Mac.zip"
 */
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default async (request) => {
  const sessionId = new URL(request.url).searchParams.get("session_id");
  if (!sessionId) return json({ error: "missing_session" }, 400);

  // 1) Verify the payment with Stripe (secret key never leaves the server).
  let session;
  try {
    const res = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
    );
    if (!res.ok) return json({ error: "verify_failed" }, 402);
    session = await res.json();
  } catch {
    return json({ error: "verify_error" }, 502);
  }
  if (session.payment_status !== "paid") return json({ error: "not_paid" }, 402);

  // 2) Mint a 15-minute private download link from R2.
  try {
    const s3 = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: process.env.R2_FILE_KEY }),
      { expiresIn: 900 }
    );
    return json({ url });
  } catch {
    return json({ error: "link_error" }, 500);
  }
};
