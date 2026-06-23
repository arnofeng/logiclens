export class OrderServiceClient {
  async getOrder(id: string) {
    return request({
      operationId: "getOrder",
      url: "/api/order/:id",
      params: { id }
    });
  }
}

export class OrderGrpcClient {
  async getOrderStream(id: string) {
    return grpc.unary("OrderService/GetOrderStream", { id });
  }
}

const request = {
  async request(_input: unknown) {
    return { ok: true };
  }
};

const grpc = {
  async unary(_method: string, _input: unknown) {
    return { ok: true };
  }
};
