using Microsoft.AspNetCore.Mvc;
public record CreateOrderRequest(string Product);
public record OrderResponse(string Id);
[ApiController, Route("api/orders")]
public class OrdersController : ControllerBase {
  [HttpPost] public ActionResult<OrderResponse> Create(CreateOrderRequest request) => Ok(new OrderResponse("1"));
}
public static class Routes {
  public static void Map(WebApplication app) => app.MapGet("/health", () => "ok");
}
