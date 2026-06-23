import { PaymentService } from "../../service-b/src/PaymentService";
import { OrderCreatedEvent } from "../../service-b/src/events/OrderCreatedEvent";

export class OrderService {
  constructor(private readonly paymentService = new PaymentService()) {}

  async createOrder(input: { sku: string; userId: string }) {
    const payment = await this.paymentService.charge(input.userId, 100);
    return publish(new OrderCreatedEvent(input.sku, payment.id));
  }
}

export function publish(event: OrderCreatedEvent) {
  return { ok: true, event };
}
