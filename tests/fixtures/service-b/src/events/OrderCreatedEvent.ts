export class OrderCreatedEvent {
  constructor(
    public readonly sku: string,
    public readonly paymentId: string
  ) {}
}
