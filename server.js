import Stripe from 'stripe';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

function base64urlEncode(bytes) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlDecode(value) {
  let base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function createHmacSignature(secret, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return base64urlEncode(new Uint8Array(signature));
}

async function verifyHmacSignature(secret, payload, signature) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const verified = await crypto.subtle.verify(
    'HMAC',
    key,
    base64urlDecode(signature),
    encoder.encode(payload)
  );

  return verified;
}

async function createDownloadToken(secret, email, checkoutId) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 2;
  const payload = `${email}|${checkoutId}|${exp}`;
  const sig = await createHmacSignature(secret, payload);
  return `${encodeURIComponent(payload)}.${sig}`;
}

async function verifyDownloadToken(secret, token) {
  if (!token) return false;

  try {
    const separatorIndex = token.lastIndexOf('.');
    if (separatorIndex <= 0 || separatorIndex === token.length - 1) return false;

    const encodedPayload = token.slice(0, separatorIndex);
    const signature = token.slice(separatorIndex + 1);

    const payload = decodeURIComponent(encodedPayload);
    const [email, checkoutId, exp] = payload.split('|');

    if (!email || !checkoutId || !exp) return false;

    const expiration = Number(exp);
    if (!Number.isFinite(expiration)) return false;

    const validSignature = await verifyHmacSignature(secret, payload, signature);
    if (!validSignature) return false;

    return expiration > Date.now();
  } catch {
    return false;
  }
}

async function sendDeliveryEmail(env, customerEmail, customerName, checkoutId) {
  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured.');
  }

  if (!env.DOWNLOAD_SECRET) {
    console.error('DOWNLOAD_SECRET is not configured; cannot create download token.');
    throw new Error('Download configuration is unavailable.');
  }

  const downloadToken = await createDownloadToken(env.DOWNLOAD_SECRET, customerEmail, checkoutId);
  const downloadUrl = `${env.PUBLIC_APP_URL}/download?token=${encodeURIComponent(downloadToken)}`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'Digital Minimalism <noreply@example.com>',
      to: customerEmail,
      subject: `Your ebook: ${env.PRODUCT_NAME || 'Digital Minimalism and Intentional Living Ebook'}`,
      text: `Hello ${customerName || 'there'},\n\nThank you for purchasing ${env.PRODUCT_NAME || 'the ebook'}.\n\nYour secure download link is below:\n${downloadUrl}\n\nThis link expires in 48 hours.`,
      html: `
        <p>Hello ${customerName || 'there'},</p>
        <p>Thank you for purchasing <strong>${env.PRODUCT_NAME || 'the ebook'}</strong>.</p>
        <p>Your secure download link is below:</p>
        <p><a href="${downloadUrl}">Download your ebook</a></p>
        <p>This link expires in 48 hours.</p>
      `,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend email failed: ${errorText}`);
  }

  return downloadUrl;
}

async function createStripeCheckoutSession(env, body) {
  const { email, name } = body || {};
  if (!email) {
    return jsonResponse({ error: 'Customer email is required.' }, 400);
  }

  const params = new URLSearchParams({
    mode: 'payment',
    success_url: `${env.PUBLIC_APP_URL}/success.html`,
    cancel_url: `${env.PUBLIC_APP_URL}/?checkout=cancelled`,
    customer_email: email,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': env.PRODUCT_NAME || 'Digital Minimalism and Intentional Living Ebook',
    'line_items[0][price_data][product_data][description]': 'Digital ebook download',
    'line_items[0][price_data][unit_amount]': '999',
    'line_items[0][quantity]': '1',
    'metadata[customer_name]': name || '',
    'metadata[product_name]': env.PRODUCT_NAME || 'Digital Minimalism and Intentional Living Ebook',
  });

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const data = await response.json();
  if (!response.ok) {
    return jsonResponse({ error: data.error?.message || 'Unable to create checkout session.' }, 500);
  }

  return jsonResponse({ url: data.url });
}

async function verifyStripeWebhook(rawBody, signature, secret, apiKey) {
  const stripe = new Stripe(apiKey);
  return stripe.webhooks.constructEventAsync(
    rawBody,
    signature,
    secret,
    undefined,
    Stripe.createSubtleCryptoProvider()
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'ebook checkout worker' });
    }

    if (url.pathname === '/download') {
      if (!env.DOWNLOAD_SECRET) {
        console.error('DOWNLOAD_SECRET is not configured; rejecting download request.');
        return jsonResponse({ error: 'Download service is not configured.' }, 500);
      }

      const token = url.searchParams.get('token');
      let isValid = false;
      try {
        isValid = await verifyDownloadToken(env.DOWNLOAD_SECRET, token);
      } catch {
        isValid = false;
      }

      if (!isValid) {
        return jsonResponse({ error: 'Invalid or expired download link.' }, 403);
      }

      if (!env.EBOOK_BUCKET || !env.EBOOK_FILE_KEY) {
        return jsonResponse({ error: 'Ebook storage is not configured.' }, 500);
      }

      let ebook;
      try {
        ebook = await env.EBOOK_BUCKET.get(env.EBOOK_FILE_KEY);
      } catch {
        return jsonResponse({ error: 'Unable to retrieve ebook from storage.' }, 500);
      }

      if (!ebook) {
        return jsonResponse({ error: 'Ebook file not found.' }, 404);
      }

      if (!ebook.body) {
        return jsonResponse({ error: 'Ebook file is unavailable.' }, 500);
      }

      const headers = new Headers({
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="Scattered-to-Centered.pdf"',
        'Cache-Control': 'private, no-store',
      });
      if (typeof ebook.size === 'number') {
        headers.set('Content-Length', String(ebook.size));
      }

      return new Response(ebook.body, { headers });
    }

    if (url.pathname === '/create-checkout-session' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return createStripeCheckoutSession(env, body);
    }

    if (url.pathname === '/webhook/stripe' && request.method === 'POST') {
      const rawBody = await request.text();
      const signature = request.headers.get('stripe-signature');

      try {
        const event = await verifyStripeWebhook(
          rawBody,
          signature,
          env.STRIPE_WEBHOOK_SECRET,
          env.STRIPE_SECRET_KEY
        );

        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          const customerEmail = session.customer_details?.email || session.customer_email;
          const customerName = session.metadata?.customer_name || 'Customer';
          const checkoutId = session.id;

          if (!customerEmail) {
            return jsonResponse({ error: 'Customer email missing from checkout session.' }, 400);
          }

          await sendDeliveryEmail(env, customerEmail, customerName, checkoutId);
        }

        return jsonResponse({ received: true });
      } catch (error) {
        return jsonResponse({ error: error.message || 'Webhook verification failed.' }, 400);
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return jsonResponse({ error: 'Route not found.' }, 404);
  },
};
