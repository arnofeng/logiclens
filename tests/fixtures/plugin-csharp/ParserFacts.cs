global using GlobalAlias = System.Collections.Generic.List<string>;
using static System.Math;
using Plain.Project.Services;

namespace Block.Scoped
{
    [Marker("type", Enabled = true)]
    public interface IService { }

    public struct Point { }
    public readonly record struct Coordinate(int X, int Y);
    public enum State { Ready }

    public class Outer
    {
        public record Inner<T>(T Value)
        {
            [Marker(7, slot: 2, Name = "primary")]
            public Inner(T value) : this(value) { }

            public TResult Convert<TResult>(T value)
            {
                TResult Local(T item) => Factory.Create<TResult>(item, "local");
                return Local(value);
            }
        }
    }
}

namespace File.Scoped;

public class Client
{
    public void Run()
    {
        service?.Send("payload", 42, 3.5);
        var message = $"sent:{42}";
    }
}
