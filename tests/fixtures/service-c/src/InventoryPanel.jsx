import React from "react";
import { InventoryService } from "./InventoryService";

export function InventoryPanel({ sku }) {
  const service = new InventoryService();
  const reservation = service.reserve(sku);
  return <section>{reservation.sku}</section>;
}
