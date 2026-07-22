/**
 * Gated download for StockBot V4 — routes to the correct edition + OS.
 *
 * Flow: after a buyer pays, Stripe redirects them to success.html with the
 * checkout session id. That page calls this function (with an ?os= choice).
 * We verify with Stripe (server-side, secret key) that the session was PAID,
 * read WHICH price they bought to decide the edition (tamper-proof — the buyer
 * can't upgrade themselves by editing the URL), then hand back a short-lived
 * (15-min) presigned link to the matching file in a PRIVATE Cloudflare R2 bucket.
 *
 * Edition mapping (server-side, by Stripe price id):
 *   STRIPE_PRICE_PRO      -> "Pro"       (the diversified V4 ensemble)
 *   STRIPE_PRICE_ECONOMY  -> "Economy"   (the aggressive V4 twin)
 *
 * Files expected in R2 (bucket = R2_BUCKET), named exactly:
 *   StockBot-Pro-Mac.zip       StockBot-Pro-Windows.zip
 *   StockBot-Economy-Mac.zip   StockBot-Economy-Windows.zip
 *
 * Required environment variables (Netlify -> Site settings -> Environment):
 *   STRIPE_SECRET_KEY      - Stripe secret key (sk_live_... or sk_test_...)
 *   STRIPE_PRICE_PRO       - the Stripe price id behind the Pro buy button
 *   STRIPE_PRICE_ECONOMY   - the Stripe price id behind the Economy buy button
 *   R2_ACCOUNT_ID          - Cloudflare account id
 *   R2_ACCESS_KEY_ID       - R2 API token access key id
 *   R2_SECRET_ACCESS_KEY   - R2 API token secret
 *   R2_BUCKET              - bucket name, e.g. "stockbot-downloads"
 */
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function editionForPrice(priceId) {
  if (priceId && priceId === process.env.STRIPE_PRICE_PRO) return "Pro";
  if (priceId && priceId === process.env.STRIPE_PRICE_ECONOMY) return "Economy";
  return null;
}

export default async (request) => {
  const params = new URL(request.url).searchParams;
  const sessionId = params.get("session_id");
  const os = (params.get("os") || "mac").toLowerCase() === "windows" ? "Windows" : "Mac";
  if (!sessionId) return json({ error: "missing_session" }, 400);
  const auth = { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` };

  // 1) Verify the payment with Stripe (secret key never leaves the server).
  let session;
  try {
    const res = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { headers: auth }
    );
    if (!res.ok) return json({ error: "verify_failed" }, 402);
    session = await res.json();
  } catch {
    return json({ error: "verify_error" }, 502);
  }
  // Accept fully-paid orders AND fully-discounted ones (100%-off codes → Stripe
  // reports "no_payment_required"). This enables free review/test copies.
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required")
    return json({ error: "not_paid" }, 402);

  // 2) Read what they bought → edition (tamper-proof; can't be spoofed via URL).
  let edition = null;
  try {
    const liRes = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=1`,
      { headers: auth }
    );
    const li = await liRes.json();
    edition = editionForPrice(li?.data?.[0]?.price?.id);
  } catch {
    return json({ error: "verify_error" }, 502);
  }
  if (!edition) return json({ error: "unknown_edition" }, 400);

  // 3) Mint a 15-minute private download link to the matching file.
  const key = `StockBot-${edition}-${os}.zip`;
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
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }),
      { expiresIn: 900 }
    );
    return json({ url, edition, os, file: key });
  } catch {
    return json({ error: "link_error" }, 500);
  }
};
