import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { OrderStatus } from './api/pickup';
import { ORDER_STATUS } from './lib/orderStatus';
import { BROWNIE, ORDER_ID, PUFF, SAMOSA, deferred, installMockApi, makeOrder, type MockReply } from './test/mockApi';

const ORDER_PATH = `/api/orders/${ORDER_ID}`;

function setup(products = [SAMOSA, BROWNIE, PUFF]) {
  const api = installMockApi();
  api.on('GET /api/products', { body: { products } });
  return api;
}

function openOrder() {
  window.location.hash = `#/orders/${ORDER_ID}`;
}

const statusBadge = () => document.getElementById('order-status');

describe('product catalog', () => {
  it('shows a loading state, then products with rupee prices and availability', async () => {
    const api = setup();
    const gate = deferred<MockReply>();
    api.on('GET /api/products', () => gate.promise);

    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading products…');

    gate.resolve({ body: { products: [SAMOSA, BROWNIE, PUFF] } });
    const samosa = (await screen.findByRole('heading', { name: 'Samosa' })).closest('li')!;
    expect(within(samosa).getByText('₹20.00')).toBeInTheDocument();
    expect(within(samosa).getByText('40 available')).toBeInTheDocument();
    expect(screen.getByText('₹60.00')).toBeInTheDocument();
  });

  it('disables ordering for sold-out products', async () => {
    setup();
    render(<App />);
    const puff = (await screen.findByRole('heading', { name: 'Paneer Puff' })).closest('li')!;
    expect(within(puff).getByText('Sold out')).toBeInTheDocument();
    expect(within(puff).getByRole('button', { name: 'Increase Paneer Puff' })).toBeDisabled();
    expect(within(puff).getByRole('spinbutton', { name: 'Quantity of Paneer Puff' })).toBeDisabled();
  });

  it('shows an error with a retry when the API fails', async () => {
    const api = setup();
    api.on('GET /api/products', { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'boom' } } });
    const user = userEvent.setup();

    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load products. Something went wrong on the server. Please try again.',
    );

    api.on('GET /api/products', { body: { products: [SAMOSA] } });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Samosa' })).toBeInTheDocument();
  });

  it('shows a network error when the server is unreachable', async () => {
    installMockApi();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server.');
  });

  it('handles an empty catalog', async () => {
    setup([]);
    render(<App />);
    expect(await screen.findByText('No products are available right now.')).toBeInTheDocument();
  });
});

describe('quantity selection', () => {
  it('cannot exceed the available units', async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);
    const increase = await screen.findByRole('button', { name: 'Increase Chocolate Brownie' });

    await user.click(increase);
    await user.click(increase);
    expect(screen.getByRole('spinbutton', { name: 'Quantity of Chocolate Brownie' })).toHaveValue(2);
    expect(increase).toBeDisabled();

    const samosaInput = screen.getByRole('spinbutton', { name: 'Quantity of Samosa' });
    await user.clear(samosaInput);
    await user.type(samosaInput, '99');
    expect(samosaInput).toHaveValue(20); // capped at the per-item limit
  });

  it('keeps the reserve button disabled until something is selected', async () => {
    setup();
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Reserve for 2 minutes' })).toBeDisabled();
  });
});

describe('order creation', () => {
  it('sends only the accepted fields, blocks double submits, and shows the created order', async () => {
    const api = setup();
    const created = deferred<MockReply>();
    api.on('POST /api/orders', () => created.promise);
    api.on(`GET ${ORDER_PATH}`, { body: makeOrder() });
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Increase Samosa' }));
    await user.click(screen.getByRole('button', { name: 'Increase Samosa' }));
    expect(screen.getByText('₹40.00')).toBeInTheDocument(); // estimate

    const submit = screen.getByRole('button', { name: 'Reserve for 2 minutes' });
    await user.click(submit);
    expect(screen.getByRole('button', { name: 'Reserving…' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Reserving…' }));
    expect(api.count('POST /api/orders')).toBe(1);
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      items: [{ productId: SAMOSA.id, quantity: 2 }],
    });

    created.resolve({ status: 201, body: makeOrder() });

    expect(await screen.findByText(ORDER_ID)).toBeInTheDocument();
    expect(statusBadge()).toHaveTextContent('Awaiting payment');
    expect(screen.getByText('1:59')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('₹40.00', { selector: 'strong' })).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/orders/${ORDER_ID}`);
    // Not paid just because it was created.
    expect(screen.queryByText(ORDER_STATUS.paid.label)).not.toBeInTheDocument();
    // Availability is re-read from the server.
    await waitFor(() => expect(api.count('GET /api/products')).toBe(2));
  });

  it('explains a stock conflict using product names and refreshes availability', async () => {
    const api = setup();
    api.on('POST /api/orders', {
      status: 409,
      body: {
        error: {
          code: 'INSUFFICIENT_STOCK',
          message: 'Not enough stock for one or more items.',
          details: [{ productId: BROWNIE.id, requested: 2, available: 1 }],
        },
      },
    });
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Increase Chocolate Brownie' }));
    await user.click(screen.getByRole('button', { name: 'Increase Chocolate Brownie' }));
    await user.click(screen.getByRole('button', { name: 'Reserve for 2 minutes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not enough stock. Chocolate Brownie: 1 left (you asked for 2). Availability has been refreshed.',
    );
    await waitFor(() => expect(api.count('GET /api/products')).toBe(2));
    expect(window.location.hash).toBe('');
  });

  it('shows server validation messages', async () => {
    const api = setup();
    api.on('POST /api/orders', {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: [{ path: 'body.items.0.quantity', message: 'quantity must be at most 20' }],
        },
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Increase Samosa' }));
    await user.click(screen.getByRole('button', { name: 'Reserve for 2 minutes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Please check your order: quantity must be at most 20.');
  });
});

describe('order status', () => {
  it.each<OrderStatus>(['pending', 'paid', 'expired', 'needs_review', 'collected'])(
    'renders the %s state from the server',
    async (status) => {
      const api = setup();
      api.on(`GET ${ORDER_PATH}`, {
        body: makeOrder({ status, expiresInSeconds: status === 'pending' ? 90 : status === 'expired' ? 0 : null }),
      });
      openOrder();
      render(<App />);

      await waitFor(() => expect(statusBadge()).toHaveTextContent(ORDER_STATUS[status].label));
      expect(screen.getByText(ORDER_STATUS[status].guidance)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Simulate payment/ }) !== null).toBe(status === 'pending');
      expect(screen.queryByRole('button', { name: 'Staff: confirm pickup' }) !== null).toBe(status === 'paid');
      expect(screen.queryByText(/Reserved for/) !== null).toBe(status === 'pending');
    },
  );

  it('opens an order from the lookup form and rejects malformed ids', async () => {
    const api = setup();
    api.on(`GET ${ORDER_PATH}`, { body: makeOrder({ status: 'paid', expiresInSeconds: null }) });
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole('textbox', { name: 'Track an order by ID' });
    await user.type(input, 'abc');
    await user.click(screen.getByRole('button', { name: 'Track' }));
    expect(screen.getByText(/Enter a full order ID/)).toBeInTheDocument();
    expect(api.count(`GET ${ORDER_PATH}`)).toBe(0);

    await user.clear(input);
    await user.type(input, ORDER_ID);
    await user.click(screen.getByRole('button', { name: 'Track' }));
    await waitFor(() => expect(statusBadge()).toHaveTextContent(ORDER_STATUS.paid.label));
  });

  it('reports an unknown order', async () => {
    setup();
    openOrder();
    render(<App />);
    expect(await screen.findByText('No order was found with this ID.')).toBeInTheDocument();
  });

  it('polls a pending order and stops once the server reports a final state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = setup();
    api.on(`GET ${ORDER_PATH}`, { body: makeOrder() });
    openOrder();
    render(<App />);
    await waitFor(() => expect(statusBadge()).toHaveTextContent('Awaiting payment'));
    const initial = api.count(`GET ${ORDER_PATH}`);

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(api.count(`GET ${ORDER_PATH}`)).toBe(initial + 1);

    api.on(`GET ${ORDER_PATH}`, { body: makeOrder({ status: 'paid', expiresInSeconds: null }) });
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await waitFor(() => expect(statusBadge()).toHaveTextContent(ORDER_STATUS.paid.label));
    const afterPaid = api.count(`GET ${ORDER_PATH}`);

    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(api.count(`GET ${ORDER_PATH}`)).toBe(afterPaid); // polling stopped
  });

  it('re-checks with the server when the countdown reaches zero', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = setup();
    api.on(`GET ${ORDER_PATH}`, { body: makeOrder({ expiresInSeconds: 3 }) });
    openOrder();
    render(<App />);
    expect(await screen.findByText('0:03')).toBeInTheDocument();

    api.on(`GET ${ORDER_PATH}`, { body: makeOrder({ status: 'expired', expiresInSeconds: 0 }) });
    await act(() => vi.advanceTimersByTimeAsync(3_100));

    await waitFor(() => expect(statusBadge()).toHaveTextContent(ORDER_STATUS.expired.label));
    expect(screen.queryByRole('button', { name: /Simulate payment/ })).not.toBeInTheDocument();
  });
});

describe('payment simulation', () => {
  it('shows paid only after the server confirms it', async () => {
    const api = setup();
    api.on(`GET ${ORDER_PATH}`, { body: makeOrder() });
    api.on(`POST /api/dev/orders/${ORDER_ID}/simulate-payment`, {
      body: { eventId: 'devsim_1', orderId: ORDER_ID, outcome: 'paid', orderStatus: 'paid', duplicate: false },
    });
    const user = userEvent.setup();
    openOrder();
    render(<App />);

    const refetch = deferred<MockReply>();
    const payButton = await screen.findByRole('button', { name: 'Simulate payment of ₹40.00' });
    api.on(`GET ${ORDER_PATH}`, () => refetch.promise);
    await user.click(payButton);

    expect(api.calls.find((c) => c.path.endsWith('/simulate-payment'))?.body).toBeUndefined(); // no amount sent
    expect(await screen.findByRole('status')).toHaveTextContent('Payment confirmed by the server.');
    // The badge follows GET /orders/:id, which has not answered yet.
    expect(statusBadge()).toHaveTextContent('Awaiting payment');

    refetch.resolve({ body: makeOrder({ status: 'paid', expiresInSeconds: null }) });
    await waitFor(() => expect(statusBadge()).toHaveTextContent(ORDER_STATUS.paid.label));
    expect(screen.getByRole('button', { name: 'Staff: confirm pickup' })).toBeInTheDocument();
  });

  it('keeps the server status when it disagrees with the payment response', async () => {
    const api = setup();
    api.on(`GET ${ORDER_PATH}`, { body: makeOrder() });
    api.on(`POST /api/dev/orders/${ORDER_ID}/simulate-payment`, {
      body: { eventId: 'devsim_1', orderId: ORDER_ID, outcome: 'paid', orderStatus: 'paid', duplicate: false },
    });
    const user = userEvent.setup();
    openOrder();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Simulate payment/ }));

    await waitFor(() => expect(api.count(`GET ${ORDER_PATH}`)).toBe(2));
    expect(statusBadge()).toHaveTextContent('Awaiting payment');
  });

  it('explains a late payment that needs review', async () => {
    const api = setup();
    api.on(`GET ${ORDER_PATH}`, { body: makeOrder() });
    api.on(`POST /api/dev/orders/${ORDER_ID}/simulate-payment`, () => {
      api.on(`GET ${ORDER_PATH}`, { body: makeOrder({ status: 'needs_review', expiresInSeconds: null }) });
      return {
        body: { eventId: 'devsim_1', orderId: ORDER_ID, outcome: 'late_payment', orderStatus: 'needs_review', duplicate: false },
      };
    });
    const user = userEvent.setup();
    openOrder();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Simulate payment/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('arrived after the reservation expired');
    await waitFor(() => expect(statusBadge()).toHaveTextContent(ORDER_STATUS.needs_review.label));
    expect(screen.queryByRole('button', { name: 'Staff: confirm pickup' })).not.toBeInTheDocument();
  });

  it('points to the signed webhook sender when the simulator is disabled', async () => {
    const api = setup();
    api.on(`GET ${ORDER_PATH}`, { body: makeOrder() });
    const user = userEvent.setup();
    openOrder();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Simulate payment/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The payment simulator is turned off');
    expect(statusBadge()).toHaveTextContent('Awaiting payment');
  });
});

describe('pickup collection', () => {
  function paidOrderApi() {
    const api = setup();
    api.on(`GET ${ORDER_PATH}`, { body: makeOrder({ status: 'paid', expiresInSeconds: null }) });
    openOrder();
    return api;
  }

  it('confirms collection only after the server does, then refreshes order and stock', async () => {
    const api = paidOrderApi();
    const collected = deferred<MockReply>();
    api.on(`POST ${ORDER_PATH}/collect`, () => collected.promise);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Staff: confirm pickup' }));
    const busy = screen.getByRole('button', { name: 'Confirming pickup…' });
    expect(busy).toBeDisabled();
    await user.click(busy);
    expect(api.count(`POST ${ORDER_PATH}/collect`)).toBe(1);
    expect(screen.queryByText(/Collection confirmed/)).not.toBeInTheDocument();

    api.on(`GET ${ORDER_PATH}`, { body: makeOrder({ status: 'collected', expiresInSeconds: null }) });
    collected.resolve({ body: { ...makeOrder({ status: 'collected', expiresInSeconds: null }), alreadyCollected: false } });

    expect(await screen.findByRole('status')).toHaveTextContent('Collection confirmed by the server.');
    await waitFor(() => expect(statusBadge()).toHaveTextContent(ORDER_STATUS.collected.label));
    await waitFor(() => expect(api.count('GET /api/products')).toBeGreaterThanOrEqual(2));
  });

  it('tells staff when the order had already been collected', async () => {
    const api = paidOrderApi();
    api.on(`POST ${ORDER_PATH}/collect`, {
      body: { ...makeOrder({ status: 'collected', expiresInSeconds: null }), alreadyCollected: true },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Staff: confirm pickup' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'This order had already been collected. No stock was deducted again.',
    );
  });

  it('shows the server reason when the order is not collectable (e.g. expired)', async () => {
    const api = paidOrderApi();
    api.on(`POST ${ORDER_PATH}/collect`, {
      status: 409,
      body: {
        error: {
          code: 'ORDER_NOT_COLLECTABLE',
          message: 'Only paid orders can be collected; this order is expired.',
          details: { status: 'expired' },
        },
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Staff: confirm pickup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only paid orders can be collected; this order is expired.');
  });

  it('explains insufficient physical stock with product names', async () => {
    const api = paidOrderApi();
    api.on(`POST ${ORDER_PATH}/collect`, {
      status: 409,
      body: {
        error: {
          code: 'INSUFFICIENT_PHYSICAL_STOCK',
          message: 'Not enough physical stock to hand over this order.',
          details: [{ productId: SAMOSA.id, required: 2, inStock: 1 }],
        },
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Staff: confirm pickup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Samosa: 1 on the shelf, 2 needed');
    expect(statusBadge()).toHaveTextContent(ORDER_STATUS.paid.label);
  });

  it('asks to retry when the counter is busy', async () => {
    const api = paidOrderApi();
    api.on(`POST ${ORDER_PATH}/collect`, {
      status: 503,
      body: { error: { code: 'COLLECTION_BUSY', message: 'The order is busy. Please try again.' } },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Staff: confirm pickup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The counter is busy right now.');
  });
});
