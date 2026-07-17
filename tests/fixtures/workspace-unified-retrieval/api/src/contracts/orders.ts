/** English API contract produced for the catalog service. */
export interface CreateOrderRequest {
  customerId: string;
  catalog_item_id: string;
}

export const ORDER_CREATED_EVENT = "orders.created";
