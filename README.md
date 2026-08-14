# Stripe ebook checkout + delivery backend

This project includes a simple Stripe checkout flow and a webhook endpoint that sends a digital product email to the buyer after successful payment.

## Files added

- [server.js](server.js) - Express API with Stripe checkout and webhook handling.
- [index.html](index.html) - Purchase form and Buy button.
- [script.js](script.js) - Calls the checkout endpoint and sends the buyer's email.
- [.env.example](.env.example) - Environment variables for Stripe and SMTP.

## Required environment variables

Copy [.env.example](.env.example) to a real `.env` file and fill in values:

```bash
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
PUBLIC_APP_URL=https://your-public-domain.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM="Digital Minimalism <you@gmail.com>"
PRODUCT_NAME="Digital Minimalism and Intentional Living Ebook"
PRODUCT_DOWNLOAD_URL=https://your-domain.com/downloads/digital-minimalism-ebook.pdf
```

## API endpoints

- `POST /create-checkout-session` - Creates a Stripe Checkout session from the customer email.
- `POST /webhook/stripe` - Stripe webhook endpoint for `checkout.session.completed` events.
- `GET /health` - Health check.

## Stripe setup

1. Create a Stripe product and price.
2. Use the same price amount as the ebook price.
3. Set your webhook endpoint to the public URL from your deployment, for example:

```text
https://your-backend-domain.com/webhook/stripe
```

Select events:
- `checkout.session.completed`

## Email delivery

This code uses Nodemailer with SMTP. The simplest working setup is Gmail App Password or a transactional provider such as SendGrid/Mailgun.

## Local run

```bash
npm install
cp .env.example .env
npm start
```

Then open the static landing page in a browser and click Buy now.

## Production deployment

Deploy the API to a public host such as Render, Railway, Fly.io, or another Node hosting provider.

Then update the checkout URL in [script.js](script.js) from:

```js
const CHECKOUT_ENDPOINT = 'http://localhost:3000/create-checkout-session';
```

to your public endpoint:

```js
const CHECKOUT_ENDPOINT = 'https://your-backend-domain.com/create-checkout-session';
```

## Important note

The ebook file must be hosted somewhere public so the email can include a working download link.
