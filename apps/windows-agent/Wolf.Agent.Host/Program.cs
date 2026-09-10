using System.Runtime.Versioning;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Wolf.Agent.Core;
using Wolf.Agent.Core.Cloud;
using Wolf.Agent.Core.Commands;
using Wolf.Agent.Core.Privileged;
using Wolf.Agent.Core.Identity;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.Core.Sessions;
using Wolf.Agent.Core.Storage;
using Wolf.Agent.Core.Telemetry;

// Namespaced away from `Wolf.Agent.Host` so the type name does not shadow
// Microsoft.Extensions.Hosting.Host inside this file.
namespace Wolf.Agent.Service;

/// <summary>
/// Host for the WOLF agent Windows service.
///
/// The service runs with the privileges it needs and no more. Elevated operations that
/// this process cannot legitimately perform are not attempted here; they belong to the
/// privileged helper, which exposes a narrow, allow-listed command surface of its own.
/// </summary>
[SupportedOSPlatform("windows")]
public static class Program
{
    public static async Task Main(string[] args)
    {
        HostApplicationBuilder builder = Host.CreateApplicationBuilder(args);

        builder.Services.Configure<AgentOptions>(builder.Configuration.GetSection(AgentOptions.SectionName));

        // Windows service integration: the Event Log is where a service failure is actually
        // visible to an operator, so it is wired up alongside the file/console logging.
        builder.Services.AddWindowsService(options => options.ServiceName = "WolfAgent");
        builder.Logging.AddEventLog(settings => settings.SourceName = "WOLF Agent");

        builder.Services.AddHttpClient<EnrollmentClient>(client =>
        {
            client.Timeout = TimeSpan.FromSeconds(30);
            client.DefaultRequestHeaders.UserAgent.ParseAdd($"WolfAgent/{AgentWorker.AgentVersion}");
        });

        builder.Services.AddSingleton(provider =>
        {
            AgentOptions options = provider.GetRequiredService<IOptions<AgentOptions>>().Value;
            return new AgentStore(options.DatabasePath, provider.GetRequiredService<ILogger<AgentStore>>());
        });

        builder.Services.AddSingleton(provider =>
        {
            AgentOptions options = provider.GetRequiredService<IOptions<AgentOptions>>().Value;
            return new PcIdentityStore(options.IdentityPath, provider.GetRequiredService<ILogger<PcIdentityStore>>());
        });

        builder.Services.AddSingleton<SessionHostSupervisor>();
        builder.Services.AddSingleton<TelemetryCollector>();
        // The monitor asks the session host which desktop has the input, rather than
        // inferring it from whether LogonUI happens to be running.
        builder.Services.AddSingleton(provider => new WindowsSessionMonitor(
            provider.GetRequiredService<ILogger<WindowsSessionMonitor>>(),
            () => provider.GetRequiredService<SessionHostSupervisor>().State.InputDesktop));
        builder.Services.AddSingleton<MachineInfoProvider>();

        builder.Services.AddSingleton<ProcessCommandHandler>();
        builder.Services.AddSingleton<PowerCommandHandler>();
        builder.Services.AddSingleton<RemoteDesktopCommandHandler>();

        // Everything that needs administrator goes through the helper, and the client for it
        // is cheap: it connects per call rather than holding a privileged channel open for
        // the life of the agent.
        builder.Services.AddSingleton<HelperClient>();
        builder.Services.AddSingleton<DiskCommandHandler>();
        builder.Services.AddSingleton<DeviceCommandHandler>();

        // The router is built from the handlers, and the system handler needs to advertise
        // what the router ends up supporting — resolved lazily to break the cycle.
        builder.Services.AddSingleton<CommandRouter>(provider =>
        {
            var handlers = new List<ICommandHandler>
            {
                provider.GetRequiredService<ProcessCommandHandler>(),
                provider.GetRequiredService<PowerCommandHandler>(),
                provider.GetRequiredService<RemoteDesktopCommandHandler>(),
                provider.GetRequiredService<DiskCommandHandler>(),
                provider.GetRequiredService<DeviceCommandHandler>(),
            };

            CommandRouter? router = null;
            handlers.Add(new SystemCommandHandler(
                provider.GetRequiredService<MachineInfoProvider>(),
                provider.GetRequiredService<WindowsSessionMonitor>(),
                provider.GetRequiredService<TelemetryCollector>(),
                () => router?.SupportedTypes ?? Array.Empty<string>(),
                AgentWorker.AgentVersion));

            router = new CommandRouter(
                handlers,
                provider.GetRequiredService<AgentStore>(),
                AgentWorker.AgentVersion,
                provider.GetRequiredService<ILogger<CommandRouter>>());

            return router;
        });

        builder.Services.AddHostedService<AgentWorker>();

        using IHost host = builder.Build();
        await host.RunAsync();
    }
}
