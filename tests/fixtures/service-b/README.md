# Service B

## Events

The payment workflow publishes `OrderCreatedEvent` after a successful charge.

See [event source](src/events/OrderCreatedEvent.ts) for the event payload.

```ts
new OrderCreatedEvent(orderId)
```
