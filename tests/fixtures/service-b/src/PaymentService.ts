import type { OrderDTO as ServiceAOrderDTO } from "@fixture/service-a";
import { OrderGrpcClient, OrderServiceClient } from "../../service-a/src/OrderClient";

const ORDER_PROMOTION_LIST = "/mall/mgr/exact/queryPagePromotionList";
const API_ROUTES = {
  ORDER_DETAIL: "/api/order/:id"
};
const localUtility = {
  get(_path: string) {
    return { cached: true };
  }
};

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

export type PaymentConfig = {
  ORDER_SHARED_CONFIG: string;
};

export class PaymentService {
  private readonly orderClient = new OrderServiceClient();
  private readonly orderGrpcClient = new OrderGrpcClient();

  async charge(userId: string, amount: number) {
    await fetch("/api/order/{id}");
    await request.post("/mall/mgr/entireOrder/list", { userId });
    await request.post(`/mall/mgr/entireOrder/${userId}/getDetail`, { userId });
    await axios.post("/wechatassistant/public/sid/v2/getAppConfigStatus", { userId });
    await fetch("/api3/merchant/backstage/service/clientApplication/queryCAppByBosId", { method: "POST" });
    await apiPost(ORDER_PROMOTION_LIST, { userId });
    await request({ url: API_ROUTES.ORDER_DETAIL });
    await this.orderClient.getOrder(userId);
    await this.orderGrpcClient.getOrderStream(userId);
    await fetch(buildDynamicOrderUrl(userId));
    localUtility.get("/api/local/cache");
    eventBus.subscribe("order.created", (_payload: ServiceAOrderDTO) => undefined);
    process.env.ORDER_SHARED_CONFIG;
    return { id: `payment-${userId}`, amount };
  }
}

const eventBus = {
  subscribe(_topic: string, _handler: (payload: OrderDTO) => void) {}
};

function buildDynamicOrderUrl(userId: string) {
  return String(new URL(userId, "https://runtime.invalid"));
}
