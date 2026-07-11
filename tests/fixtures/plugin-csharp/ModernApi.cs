using Microsoft.AspNetCore.Mvc;

namespace LogicLens.Fixtures;

[AttributeUsage(AttributeTargets.Class)]
public sealed class MarkerAttribute : Attribute { }

[Marker]
public record Request<T>(T Value, string? Note, int? Count);

public static class Helpers
{
    public static TResult Convert<TValue, TResult>(TValue value, Func<TValue, TResult> converter)
        => converter(value);
}

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/items/{id}", ([FromRoute] int id) => Results.Ok(new Request<int>(id, null, null)));
app.MapPost("/items", (Request<string> request) => Results.Created("/items", request));
app.Run();
