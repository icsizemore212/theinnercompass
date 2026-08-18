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

  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return false;

  const payload = decodeURIComponent(encodedPayload);
  const [email, checkoutId, exp] = payload.split('|');

  if (!email || !checkoutId || !exp) return false;

  const validSignature = await verifyHmacSignature(secret, payload, signature);
  if (!validSignature) return false;

  return Number(exp) > Date.now();
}

async function sendDeliveryEmail(env, customerEmail, customerName, checkoutId) {
  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured.');
  }

  const downloadToken = await createDownloadToken(env.DOWNLOAD_SECRET || 'dev-secret', customerEmail, checkoutId);
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

async function createPrivateDownloadUrl(env) {
  const fileKey = env.EBOOK_FILE_KEY || 'digital-minimalism-ebook.pdf';

  if (env.EBOOK_BUCKET && typeof env.EBOOK_BUCKET.getSignedUrl === 'function') {
    return env.EBOOK_BUCKET.getSignedUrl(fileKey, {
      method: 'GET',
      expiresIn: 60 * 60 * 24,
    });
  }

  if (env.EBOOK_FILE_URL) {
    return env.EBOOK_FILE_URL;
  }

  return null;
}

async function createStripeCheckoutSession(env, body) {
  const { email, name } = body || {};
  if (!email) {
    return jsonResponse({ error: 'Customer email is required.' }, 400);
  }

  const params = new URLSearchParams({
    mode: 'payment',
    success_url: `${env.PUBLIC_APP_URL}/?checkout=success`,
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

async function verifyStripeWebhook(rawBody, signature, secret) {
  const signatureParts = {};
  for (const part of (signature || '').split(',')) {
    const [key, value] = part.split('=');
    if (key && value) {
      signatureParts[key] = value;
    }
  }

  if (!signatureParts.t || !signatureParts.v1) {
    throw new Error('Missing Stripe signature headers.');
  }

  const payload = `${signatureParts.t}.${rawBody}`;
  const isValid = await verifyHmacSignature(secret, payload, signatureParts.v1);
  if (!isValid) {
    throw new Error('Stripe webhook signature invalid.');
  }

  return JSON.parse(rawBody);
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
      const token = url.searchParams.get('token');
      const isValid = await verifyDownloadToken(env.DOWNLOAD_SECRET || 'dev-secret', token);

      if (!isValid) {
        return jsonResponse({ error: 'Invalid or expired download link.' }, 403);
      }

      const fileUrl = await createPrivateDownloadUrl(env);
      if (!fileUrl) {
        return jsonResponse({ error: 'No ebook file configured.' }, 500);
      }

      return Response.redirect(fileUrl, 302);
    }

    if (url.pathname === '/create-checkout-session' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return createStripeCheckoutSession(env, body);
    }

    if (url.pathname === '/webhook/stripe' && request.method === 'POST') {
      const rawBody = await request.text();
      const signature = request.headers.get('stripe-signature');

      try {
        const event = await verifyStripeWebhook(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);

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

    return jsonResponse({ error: 'Route not found.' }, 404);
  },
};
