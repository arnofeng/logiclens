using System.Net.Http;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/[controller]")]
[Route("v2/[controller]")]
public class OrdersController : ControllerBase
{
    [HttpGet("{id:int}")]
    [HttpGet("by-id/{id:guid}")]
    public ActionResult<OrderDto> Get(int id) => Ok();

    [HttpPut]
    [Route("first")]
    [Route("second")]
    public IActionResult Replace(CreateOrder request) => Ok();

    [AcceptVerbs("GET", "HEAD", Route = "search")]
    public IActionResult Search(string query) => Ok();

    [HttpPost("/absolute/[action]")]
    public Task<ActionResult<OrderDto>> Create(CreateOrder request) => Task.FromResult<ActionResult<OrderDto>>(Ok());

    [Route("unknown")]
    public IActionResult Unknown() => Ok();

    [AcceptVerbs("CUSTOM", Route = "custom")]
    public IActionResult Custom() => Ok();

    [HttpDelete("optional/{id?}")]
    public IActionResult Delete(int id) => Ok();

    [HttpPatch("catch/{**slug}")]
    public IActionResult Patch(string slug) => Ok();

    [HttpHead("default/{id=1}")]
    public IActionResult Head(int id) => Ok();

    [HttpOptions("options")]
    public IActionResult Options() => Ok();
}

[ApiController]
[Route(BuildPath())]
public class DynamicController : ControllerBase
{
    [HttpGet("relative")]
    public IActionResult Relative() => Ok();

    [HttpGet("/stable")]
    public IActionResult Stable() => Ok();

    [HttpDelete(BuildPath())]
    public IActionResult Dynamic() => Ok();
}

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
WebApplication web = builder.Build();
IEndpointRouteBuilder endpoints = web;
const string ApiRoot = "/api";
const string OrdersPath = ApiRoot + "/orders";
var api = app.MapGroup(ApiRoot);
var versioned = api.MapGroup("/v1");
versioned.MapGet("/{id:int}", (int id) => Results.Ok());
versioned.MapPost("/", (CreateOrder request) => Results.Ok(request));
app.MapMethods(OrdersPath, new[] { HttpMethods.Head, HttpMethods.Options }, Handler);
app.MapMethods("/multi", new[] { "GET", "PATCH", "CUSTOM" }, Handler);
app.MapGroup("/direct").MapGroup("/nested").MapDelete("/{id?}", Handler);
app.MapPut("/named", NamedHandler);
app.MapGet(BuildPath(), Handler);
web.MapGet("/web-root", Handler);
endpoints.MapPost("/endpoint-root", Handler);

static ActionResult<OrderDto> NamedHandler(CreateOrder request) => new OrderDto(1);

public sealed class OrdersClient
{
    private readonly HttpClient _httpClient;
    public OrdersClient(HttpClient httpClient) => _httpClient = httpClient;

    public Task<HttpResponseMessage> Load() => _httpClient.GetAsync(OrdersPath);
    public Task<OrderDto?> LoadJson() => _httpClient.GetFromJsonAsync<OrderDto>("/api/orders/1");
    public Task<HttpResponseMessage> LoadExplicit() => this._httpClient.GetAsync("/api/orders/2");
    public Task<HttpResponseMessage> Save(CreateOrder body) => _httpClient.PostAsync("/api/orders", JsonContent.Create(body));
    public Task<HttpResponseMessage> Send() => _httpClient.SendAsync(new HttpRequestMessage(HttpMethod.Patch, "/api/orders/1"));
    public Task<HttpResponseMessage> Dynamic(string path) => _httpClient.GetAsync(path);
}

public sealed class NotAClient
{
    private readonly FakeClient httpClient = new();
    public Task GetAsync(string path) => Task.CompletedTask;
    public Task FalsePositive() => GetAsync("/should-not-exist");
    public Task NamedFalsePositive() => httpClient.GetAsync("/also-not-http");
}

public sealed record CreateOrder(string Name);
public sealed record OrderDto(int Id);
