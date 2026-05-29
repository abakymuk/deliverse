'use client';

import { Button } from '@rp/ui/components/button';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import { type FormEvent, useState, useTransition } from 'react';
import { createOrderPaymentIntentAction } from './actions';

// Publishable key is safe in the client bundle. loadStripe is lazy; an empty
// string (key unset) surfaces a clear Stripe.js error rather than crashing at
// import — so the page still renders if the env var is missing.
const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '');

/**
 * Pay step for a placed order (DEL-44). "Pay now" asks the server action for a
 * PaymentIntent client_secret, then mounts the Stripe Payment Element. On
 * confirm, Stripe redirects to the order page; the charge webhook records the
 * payment, so this component never writes payment state itself.
 */
export function PayPanel({ orderId }: { orderId: string }) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function start() {
    setError(null);
    startTransition(async () => {
      const res = await createOrderPaymentIntentAction(orderId);
      if ('error' in res) {
        setError(res.error);
      } else {
        setClientSecret(res.clientSecret);
      }
    });
  }

  if (clientSecret) {
    return (
      <Elements stripe={stripePromise} options={{ clientSecret }}>
        <PayForm orderId={orderId} />
      </Elements>
    );
  }

  return (
    <div className="space-y-3">
      <Button onClick={start} disabled={pending}>
        {pending ? 'Starting…' : 'Pay now'}
      </Button>
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PayForm({ orderId }: { orderId: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const result = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/orders/${orderId}`,
      },
    });

    // On success Stripe redirects to return_url and the charge webhook records
    // the payment. We only reach here on an immediate error (e.g. declined card).
    if (result.error) {
      setError(result.error.message ?? 'Payment failed. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <PaymentElement />
      <Button type="submit" disabled={!stripe || submitting}>
        {submitting ? 'Processing…' : 'Pay'}
      </Button>
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
