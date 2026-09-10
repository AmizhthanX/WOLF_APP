using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.Core.Privileged;
using Wolf.Agent.Helper;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Which services WOLF refuses to stop, and why.
///
/// The question behind every entry is the one that makes remote service control different from
/// local service control: *if this goes wrong, can it be undone from the other end of a
/// network?* Stopping `Dhcp` on a machine in the next room is an inconvenience. Stopping it on
/// a machine in another country removes the only means of putting it back.
///
/// Free of I/O on purpose, so it can be checked against the service list of any Windows build
/// rather than only by stopping things on this one to see what happens. The read-only half of
/// <see cref="ServiceManager"/> is exercised against the real service control manager below;
/// the half that changes things is not, and the tests say which.
/// </summary>
public sealed class ServiceProtectionTests
{
    private readonly ITestOutputHelper _output;

    public ServiceProtectionTests(ITestOutputHelper output)
    {
        _output = output;
    }

    /* --------------------------------------------------------------------- */
    /* WOLF's own                                                             */
    /* --------------------------------------------------------------------- */

    [Theory]
    [InlineData("WolfAgent")]
    [InlineData("wolfagent")]
    [InlineData("WolfAgentHelper")]
    public void WOLF_will_not_stop_itself(string service)
    {
        ServiceRefusal? refusal = ServiceProtection.Check(service, "stop");

        _output.WriteLine($"{service}: {refusal?.Code} — {refusal?.Reason}");

        // Stopping this ends the connection that would have reported the result, so the
        // operator learns nothing except that their session died. Refused rather than
        // escalated: there is no confirmation that makes "and then you lose the machine"
        // acceptable, and the honest alternative is the control panel on the PC itself.
        Assert.NotNull(refusal);
        Assert.Equal("wolf-service", refusal!.Code);
        Assert.Contains("control panel", refusal.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void WOLF_will_not_disable_itself_either()
    {
        // The worse of the two: stopped, it comes back when the machine does. Disabled, it
        // does not, and the machine is then unreachable in a way nothing remote can fix.
        Assert.NotNull(ServiceProtection.Check("WolfAgent", "disable"));
        Assert.NotNull(ServiceProtection.Check("WolfAgent", "configure"));
    }

    [Fact]
    public void Starting_WOLFs_own_service_is_not_refused()
    {
        // Harmless and occasionally useful: the helper may be stopped while the agent is not.
        // Refusing it would be a rule with no risk behind it.
        Assert.Null(ServiceProtection.Check("WolfAgentHelper", "start"));
    }

    /* --------------------------------------------------------------------- */
    /* Windows' own skeleton                                                  */
    /* --------------------------------------------------------------------- */

    [Theory]
    [InlineData("RpcSs", "the RPC service Windows cannot start again")]
    [InlineData("DcomLaunch", "the COM launcher everything depends on")]
    [InlineData("SamSs", "the account manager")]
    [InlineData("PlugPlay", "device enumeration")]
    [InlineData("EventLog", "the log that would record what went wrong")]
    [InlineData("CryptSvc", "certificate services, which TLS needs")]
    [InlineData("Winmgmt", "WMI, which WOLF's own telemetry reads")]
    public void A_service_Windows_needs_to_run_at_all_is_refused(string service, string what)
    {
        ServiceRefusal? refusal = ServiceProtection.Check(service, "stop");

        _output.WriteLine($"{service} ({what}): {refusal?.Code}");

        Assert.NotNull(refusal);
        Assert.Equal("system-critical", refusal!.Code);
    }

    /* --------------------------------------------------------------------- */
    /* The way back in                                                        */
    /* --------------------------------------------------------------------- */

    [Theory]
    [InlineData("Dhcp", "the address the PC is reachable on")]
    [InlineData("Dnscache", "name resolution")]
    [InlineData("nsi", "the network store, which the whole stack reads")]
    [InlineData("BFE", "the base filtering engine — firewall, IPsec, and often the stack")]
    [InlineData("mpssvc", "the firewall")]
    [InlineData("iphlpsvc", "IP helper")]
    [InlineData("WlanSvc", "wireless, which on a laptop is the only route")]
    public void A_service_the_connection_depends_on_is_refused(string service, string what)
    {
        ServiceRefusal? refusal = ServiceProtection.Check(service, "stop");

        _output.WriteLine($"{service} ({what}): {refusal?.Code}");

        // This is the category that makes remote service control a different feature from
        // local service control. Every one of these cuts the connection WOLF would need to
        // undo it.
        Assert.NotNull(refusal);
        Assert.Equal("network-critical", refusal!.Code);
    }

    [Fact]
    public void The_base_filtering_engine_is_protected_because_its_name_does_not_warn_you()
    {
        // `BFE` reads like an optional filtering component. Stopping it takes the firewall,
        // IPsec, and on many builds the network stack — which is exactly the kind of thing an
        // operator would try without expecting to lose the machine.
        Assert.Equal("network-critical", ServiceProtection.WhyNot("BFE")!.Code);
    }

    /* --------------------------------------------------------------------- */
    /* What is allowed                                                        */
    /* --------------------------------------------------------------------- */

    [Theory]
    [InlineData("Spooler", "the print spooler")]
    [InlineData("MSSQLSERVER", "a database")]
    [InlineData("W3SVC", "a web server")]
    [InlineData("wuauserv", "Windows Update")]
    [InlineData("SomeVendorUpdater", "a third-party updater")]
    public void An_ordinary_service_is_not_protected(string service, string what)
    {
        _output.WriteLine($"{service}: {what}");

        // The list is a floor, not a ceiling. Everything here is still `high` or `critical`
        // in the command registry — confirmation, re-authentication, and for a disable a
        // single-use privileged grant. What the list adds is the set of things no amount of
        // confirming should unlock.
        Assert.Null(ServiceProtection.Check(service, "stop"));
        Assert.Null(ServiceProtection.Check(service, "restart"));
        Assert.Null(ServiceProtection.Check(service, "disable"));
    }

    [Fact]
    public void Starting_anything_is_allowed_because_it_can_be_stopped_again()
    {
        // The asymmetry is deliberate and is the same one the device rules make. Starting
        // restores function; a service that should not have been started can be stopped. The
        // reverse is not true, which is the whole reason the other direction has a list.
        foreach (string service in ServiceProtection.ProtectedNames())
        {
            if (service.StartsWith("Wolf", StringComparison.OrdinalIgnoreCase)) continue;
            Assert.Null(ServiceProtection.Check(service, "start"));
        }
    }

    [Fact]
    public void An_action_that_takes_a_service_away_is_recognised_as_one()
    {
        Assert.True(ServiceProtection.Removes("stop"));
        Assert.True(ServiceProtection.Removes("restart"));
        Assert.True(ServiceProtection.Removes("disable"));

        Assert.False(ServiceProtection.Removes("start"));
        Assert.False(ServiceProtection.Removes("configure"));
    }

    [Fact]
    public void A_service_with_no_name_is_refused_rather_than_allowed_through()
    {
        // The direction a bug in this should fail. An empty name reaching the service control
        // manager is at best an error and at worst something else's service.
        Assert.NotNull(ServiceProtection.Check("", "stop"));
        Assert.NotNull(ServiceProtection.Check("   ", "stop"));
        Assert.Equal("unknown-service", ServiceProtection.WhyNot("")!.Code);
    }

    [Fact]
    public void The_protected_list_is_offered_whole_so_a_client_can_show_it()
    {
        IReadOnlyCollection<string> names = ServiceProtection.ProtectedNames();

        _output.WriteLine($"{names.Count} protected service(s)");

        Assert.Contains("WolfAgent", names);
        Assert.Contains("RpcSs", names);
        Assert.Contains("Dhcp", names);
        Assert.DoesNotContain("Spooler", names);
    }

    /* --------------------------------------------------------------------- */
    /* Against the real service control manager                               */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void The_real_service_list_reads_back_with_what_WOLF_would_refuse()
    {
        var manager = new ServiceManager(NullLogger<ServiceManager>.Instance);
        IReadOnlyList<HelperService> services = manager.List(null);

        _output.WriteLine($"{services.Count} service(s) on this machine");

        // Every Windows machine has services. An empty list here would mean the enumeration
        // is wrong rather than the machine being unusual.
        Assert.NotEmpty(services);

        HelperService? rpc = services.FirstOrDefault(s =>
            string.Equals(s.Name, "RpcSs", StringComparison.OrdinalIgnoreCase));

        Assert.NotNull(rpc);
        _output.WriteLine(
            $"RpcSs: status={rpc!.Status} start={rpc.StartType} " +
            $"canStop={rpc.CanStop} protectedBy={rpc.ProtectedBy}");

        // Carried in the listing so an operator sees what is off limits before they try it,
        // rather than after.
        Assert.Equal("system-critical", rpc.ProtectedBy);
        Assert.Equal("running", rpc.Status);

        // Windows' own answer and WOLF's are reported separately, because they are different
        // facts: `RpcSs` is one Windows itself will not stop.
        Assert.False(rpc.CanStop);
    }

    [Fact]
    public void An_ordinary_service_reads_back_with_no_protection_and_a_real_start_type()
    {
        var manager = new ServiceManager(NullLogger<ServiceManager>.Instance);

        HelperService? spooler = manager.List("Spooler").FirstOrDefault(s =>
            string.Equals(s.Name, "Spooler", StringComparison.OrdinalIgnoreCase));

        if (spooler is null)
        {
            // A real answer on a real machine — a server core install has no spooler. Saying
            // so beats a test that silently proves nothing.
            _output.WriteLine("There is no print spooler on this machine; nothing to check.");
            return;
        }

        _output.WriteLine($"Spooler: status={spooler.Status} start={spooler.StartType} account={spooler.Account}");

        Assert.Null(spooler.ProtectedBy);
        Assert.Contains(
            spooler.StartType,
            new[] { "automatic", "automatic-delayed", "manual", "disabled", "boot", "system", "unknown" });

        // The account is the fact that decides what a service can reach, which is why it is
        // in the listing at all.
        Assert.NotNull(spooler.Account);
    }

    [Fact]
    public void A_search_narrows_the_list_rather_than_filtering_it_afterwards()
    {
        var manager = new ServiceManager(NullLogger<ServiceManager>.Instance);

        IReadOnlyList<HelperService> all = manager.List(null);
        IReadOnlyList<HelperService> matched = manager.List("Rpc");

        _output.WriteLine($"{matched.Count} of {all.Count} match 'Rpc'");

        Assert.True(matched.Count < all.Count, "a search that matched everything is not a search");
        Assert.All(matched, service =>
            Assert.True(
                service.Name.Contains("Rpc", StringComparison.OrdinalIgnoreCase) ||
                service.DisplayName.Contains("Rpc", StringComparison.OrdinalIgnoreCase)));
    }

    [Fact]
    public void Controlling_a_protected_service_is_refused_without_touching_Windows()
    {
        var manager = new ServiceManager(NullLogger<ServiceManager>.Instance);

        HelperServiceResult result = manager.Control("RpcSs", "stop", "Remote Procedure Call (RPC)");

        _output.WriteLine($"{result.Code}: {result.Message}");

        // Refused by WOLF before the service control manager is asked. Windows would refuse
        // this one too, but relying on that would be relying on Windows to protect a list
        // WOLF wrote for its own reasons.
        Assert.False(result.Ok);
        Assert.Equal("system-critical", result.Code);
        Assert.Equal("unknown", result.Status);
    }

    [Fact]
    public void A_service_that_is_not_there_is_reported_as_missing()
    {
        var manager = new ServiceManager(NullLogger<ServiceManager>.Instance);

        HelperServiceResult result = manager.Control(
            "WolfNoSuchService" + Guid.NewGuid().ToString("N"),
            "start",
            "Nothing");

        Assert.False(result.Ok);
        Assert.Equal("unknown-service", result.Code);
    }

    [Fact]
    public void A_display_name_that_no_longer_matches_stops_the_change()
    {
        var manager = new ServiceManager(NullLogger<ServiceManager>.Instance);

        // Checked the way a process id is checked against its name before it is terminated.
        // A service list an operator read a minute ago can describe a machine that has
        // changed since — and `Spooler` under a different display name is a different thing
        // to be stopping.
        HelperServiceResult result = manager.Control("Spooler", "start", "Not What It Is Called");

        _output.WriteLine($"{result.Code}: {result.Message}");

        if (result.Code == "unknown-service")
        {
            _output.WriteLine("There is no print spooler on this machine; nothing to check.");
            return;
        }

        Assert.False(result.Ok);
        Assert.Equal("name-mismatch", result.Code);
    }

    [Fact]
    public void A_start_type_WOLF_does_not_set_is_refused_before_anything_is_opened()
    {
        var manager = new ServiceManager(NullLogger<ServiceManager>.Instance);

        // `boot` and `system` are readable but not settable. They belong to drivers that load
        // before the service control manager exists, and a remote tool that could put an
        // ordinary service there could make a machine unbootable in a way nothing on it could
        // undo.
        foreach (string startType in new[] { "boot", "system", "whenever", "" })
        {
            HelperServiceResult result = manager.SetStartType("Spooler", startType, "Print Spooler");
            Assert.False(result.Ok);
            Assert.Equal("malformed", result.Code);
        }
    }

    /// <summary>
    /// The one that cannot run here, and says so.
    ///
    /// Actually starting and stopping a service needs administrator, and this development
    /// session is not elevated. More to the point, a test suite that stopped services on
    /// whatever machine it happened to run on would be a worse idea than an untested path.
    ///
    /// Run it elevated with <c>WOLF_TEST_SERVICE_CONTROL=1</c>, which uses the print spooler:
    /// stoppable, restartable, and harmless to cycle.
    /// </summary>
    [Fact]
    public void Starting_and_stopping_a_service_really_works()
    {
        if (Environment.GetEnvironmentVariable("WOLF_TEST_SERVICE_CONTROL") is not ("1" or "true"))
        {
            _output.WriteLine(
                "Needs an elevated test run. Set WOLF_TEST_SERVICE_CONTROL=1 to cycle the print spooler.");
            return;
        }

        var manager = new ServiceManager(NullLogger<ServiceManager>.Instance);

        HelperService? spooler = manager.List("Spooler").FirstOrDefault(s =>
            string.Equals(s.Name, "Spooler", StringComparison.OrdinalIgnoreCase));

        Assert.NotNull(spooler);

        HelperServiceResult stopped = manager.Control("Spooler", "stop", spooler!.DisplayName);
        _output.WriteLine($"stop: ok={stopped.Ok} status={stopped.Status} {stopped.Code} {stopped.Message}");

        Assert.True(stopped.Ok, stopped.Message);
        Assert.Equal("stopped", stopped.Status);

        HelperServiceResult started = manager.Control("Spooler", "start", spooler.DisplayName);
        _output.WriteLine($"start: ok={started.Ok} status={started.Status}");

        // The state Windows is in afterwards, never the state that was asked for.
        Assert.True(started.Ok, started.Message);
        Assert.Equal("running", started.Status);
    }
}
