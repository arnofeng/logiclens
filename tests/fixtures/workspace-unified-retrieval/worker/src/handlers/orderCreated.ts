// Mixed English/中文 consumer for the api event contract.
import { ORDER_CREATED_EVENT } from "../../../api/src/contracts/orders";

export function handleOrderCreated(eventName: string): boolean {
  messageBus.consume("orders.created", () => undefined);
  return eventName === ORDER_CREATED_EVENT;
}
