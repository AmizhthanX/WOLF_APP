using System.Runtime.Versioning;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Helper;

/// <summary>
/// The WOLF privileged helper.
///
/// Runs as a Windows service, does nothing until the agent asks it something, and only ever
/// does the handful of things on its allow-list. It holds no network connection and reads no
/// configuration: everything it will ever do is compiled into it.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class HelperProgram
{
    private const string HelperVersion = "0.1.0";

    private static async Task<int> Main()
    {
        HostApplicationBuilder builder = Host.CreateApplicationBuilder();

        builder.Services.AddWindowsService(options => options.ServiceName = "WolfAgentHelper");
        builder.Logging.AddConsole();
        builder.Services.AddHostedService<HelperWorker>();
        builder.Services.AddSingleton(_ => HelperVersion);

        using IHost host = builder.Build();
        await host.RunAsync().ConfigureAwait(false);
        return 0;
    }
}

/// <summary>Keeps the pipe server running for as long as the service does.</summary>
[SupportedOSPlatform("windows")]
internal sealed class HelperWorker : BackgroundService
{
    private readonly ILoggerFactory _loggers;
    private readonly ILogger<HelperWorker> _logger;
    private readonly string _version;

    public HelperWorker(ILoggerFactory loggers, string version)
    {
        _loggers = loggers;
        _logger = loggers.CreateLogger<HelperWorker>();
        _version = version;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("WOLF privileged helper {Version} starting.", _version);

        await using var server = new HelperServer(_loggers, _version);
        server.Start();

        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }

        _logger.LogInformation("WOLF privileged helper stopping after {Count} request(s).", server.RequestsServed);
    }
}
