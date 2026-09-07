using Microsoft.Extensions.Logging;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Routes component logging into the test output.
///
/// The capture and encoding components report what they are doing and why something did not
/// work through <see cref="ILogger"/>. Running them against <c>NullLogger</c> throws that
/// away, which turns a diagnosable failure into "it returned nothing" — so tests that touch
/// real hardware use this instead.
/// </summary>
public sealed class XunitLoggerFactory : ILoggerFactory
{
    private readonly ITestOutputHelper _output;
    private readonly LogLevel _minimum;

    public XunitLoggerFactory(ITestOutputHelper output, LogLevel minimum = LogLevel.Debug)
    {
        _output = output;
        _minimum = minimum;
    }

    public ILogger CreateLogger(string categoryName) => new XunitLogger(_output, categoryName, _minimum);

    public ILogger<T> CreateLogger<T>() => new XunitLogger<T>(_output, _minimum);

    public void AddProvider(ILoggerProvider provider)
    {
        // Nothing to add: this factory writes to exactly one place by design.
    }

    public void Dispose()
    {
    }

    private class XunitLogger : ILogger
    {
        private readonly ITestOutputHelper _output;
        private readonly string _category;
        private readonly LogLevel _minimum;

        public XunitLogger(ITestOutputHelper output, string category, LogLevel minimum)
        {
            _output = output;
            _category = category;
            _minimum = minimum;
        }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel >= _minimum;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;

            try
            {
                string message = formatter(state, exception);
                _output.WriteLine($"[{logLevel}] {_category}: {message}");
                if (exception is not null)
                {
                    _output.WriteLine($"        {exception.GetType().Name}: {exception.Message}");
                }
            }
            catch (InvalidOperationException)
            {
                // The test has already finished; there is nowhere left to write.
            }
        }
    }

    private sealed class XunitLogger<T> : XunitLogger, ILogger<T>
    {
        public XunitLogger(ITestOutputHelper output, LogLevel minimum)
            : base(output, typeof(T).Name, minimum)
        {
        }
    }
}
