namespace Acme.Orders;

public class OrdersService : Orders.OrdersBase {
  public override Task<OrderReply> GetOrder(OrderRequest request, ServerCallContext context) => Handle(request);
  public override Task Upload(IAsyncStreamReader<OrderChunk> requestStream, ServerCallContext context) => Handle();
  public override Task Download(OrderRequest request, IServerStreamWriter<OrderReply> responseStream, ServerCallContext context) => Handle(request);
  public override Task Chat(IAsyncStreamReader<OrderChunk> requestStream, IServerStreamWriter<OrderReply> responseStream, ServerCallContext context) => Handle();
}

public class Caller {
  private readonly Orders.OrdersClient client;
  public Task Run(OrderRequest request) => client.GetOrderAsync(request);
  public void Streams(OrderRequest request) {
    AsyncClientStreamingCall<OrderChunk, OrderReply> upload = client.Upload();
    AsyncServerStreamingCall<OrderReply> download = client.Download(request);
    AsyncDuplexStreamingCall<OrderChunk, OrderReply> chat = client.Chat();
  }
}

public class FakeBase { public Task Noise(FakeRequest request, ServerCallContext context) => Handle(); }
public class FakeClient { public Task Publish(string topic) => Handle(); }

public class Messaging {
  private readonly IProducer<string, OrderCreated> kafkaProducer;
  private readonly IConsumer<string, OrderCreated> kafkaConsumer;
  private readonly IModel rabbit;
  private readonly IPublishEndpoint bus;
  private readonly IMessageSession session;
  private readonly ServiceBusClient azure;

  public async Task Send(OrderCreated message) {
    await kafkaProducer.ProduceAsync("orders.created", new Message<string, OrderCreated>());
    kafkaConsumer.Subscribe("orders.created");
    rabbit.BasicPublish("events", "orders.created", body: Array.Empty<byte>());
    rabbit.BasicConsume("orders.queue", consumer: null);
    await bus.Publish<OrderCreated>(message);
    await session.Publish<OrderCreated>(message);
    var sender = azure.CreateSender("orders.created");
    await sender.SendMessageAsync(new ServiceBusMessage());
    kafkaProducer.ProduceAsync(BuildTopic(), new Message<string, OrderCreated>());
  }
}

public class MassTransitConsumer : IConsumer<OrderCreated> { }
public class NServiceBusHandler : IHandleMessages<OrderCreated> { }

public class EfOnlyEntity {
  [Key] public int Id { get; set; }
  public string Name { get; set; }
}
public class StoreContext : DbContext { public DbSet<EfOnlyEntity> Entities { get; set; } }
