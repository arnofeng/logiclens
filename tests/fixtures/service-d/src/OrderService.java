package com.example.orders;

import java.util.List;
import java.util.*;
import com.example.payments.PaymentService;

public class OrderService {
  private final PaymentService paymentService = new PaymentService();

  public Order createOrder(String orderId) {
    paymentService.charge(orderId);
    return new Order(orderId, List.of("created"));
  }

  interface Handler {
    void handle(Order order);
  }

  enum Status {
    CREATED
  }
}
