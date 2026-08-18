const yearNode = document.getElementById('year');
if (yearNode) {
  yearNode.textContent = new Date().getFullYear();
}

const checkoutButton = document.getElementById('checkout-button');
const purchaseStatus = document.getElementById('purchase-status');
const customerNameInput = document.getElementById('customer-name');
const customerEmailInput = document.getElementById('customer-email');

const CHECKOUT_ENDPOINT =
  window.CHECKOUT_API_URL ||
  '/create-checkout-session';

async function startCheckout() {
  if (!checkoutButton) return;

  const email = customerEmailInput?.value?.trim();
  if (!email) {
    purchaseStatus.textContent = 'Please enter your email address before purchasing.';
    customerEmailInput?.focus();
    return;
  }

  checkoutButton.disabled = true;
  checkoutButton.textContent = 'Preparing checkout...';
  purchaseStatus.textContent = 'Connecting to secure checkout...';

  try {
    const response = await fetch(CHECKOUT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        name: customerNameInput?.value?.trim() || '',
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Unable to start checkout.');
    }

    if (data.url) {
      window.location.href = data.url;
      return;
    }

    throw new Error('No checkout URL returned.');
  } catch (error) {
    console.error(error);
    checkoutButton.disabled = false;
    checkoutButton.textContent = 'Buy now for $9.99';
    purchaseStatus.textContent = error.message || 'Checkout could not be started.';
  }
}

if (checkoutButton) {
  checkoutButton.addEventListener('click', startCheckout);
}
