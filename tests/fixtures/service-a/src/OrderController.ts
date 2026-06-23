import { OrderService } from "./OrderService";

export interface OrderDTO {
  sku: string;
  userId: string;
}

export type OrderSchema = {
  sku: string;
  userId: string;
};

export enum OrderStatus {
  Created = "created",
  Paid = "paid"
}

export class OrderController {
  constructor(private readonly orderService = new OrderService()) {}

  async createOrder(input: OrderDTO) {
    const route = "/api/order/:id";
    process.env.ORDER_SHARED_CONFIG;
    eventBus.publish("order.created", input);
    return this.orderService.createOrder(input);
  }
}

const eventBus = {
  publish(_topic: string, _payload: OrderDTO) {}
};
