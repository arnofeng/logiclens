import { OrderController } from "@fixture/service-a";

export class InventoryService {
  reserve(sku) {
    new OrderController();
    return reserveInventory(sku);
  }
}

export function reserveInventory(sku) {
  return { sku, reserved: true };
}
