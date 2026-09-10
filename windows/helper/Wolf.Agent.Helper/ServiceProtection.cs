namespace Wolf.Agent.Helper;

/// <summary>Why a service will not be touched, or null when it will be.</summary>
public sealed record ServiceRefusal(string Code, string Reason);

/// <summary>
/// Decides which Windows services WOLF will refuse to stop or disable.
///
/// The same question as <see cref="DeviceProtection"/>, and it is the only question worth
/// asking here: *if this goes wrong, can it be undone from the other end of a network?* Where
/// the answer is no, the service is refused rather than confirmed. A confirmation dialog asks
/// somebody to accept a risk; it is the wrong tool when accepting the risk removes their
/// ability to do anything about it.
///
/// Kept apart from the code that talks to the service control manager, and free of I/O, so it
/// can be checked against the service list of any machine rather than only by stopping things
/// on this one to see what happens.
///
/// **This is a floor, not a ceiling.** Everything not refused here is still classified `high`
/// or `critical` in the command registry — confirmation, re-authentication, and for a disable,
/// a single-use privileged grant. The list below is the set of things no amount of confirming
/// should unlock.
///
/// **WOLF never creates or deletes a service, and never will.** Creating one is a persistence
/// mechanism; a remote-management tool that can install a service is a remote-persistence
/// tool, and that is a different product with a different threat model. What is here manages
/// services that already exist.
/// </summary>
public static class ServiceProtection
{
    /// <summary>
    /// WOLF's own services.
    ///
    /// Stopping one of these ends the connection that would have reported the result, so the
    /// operator learns nothing except that their session died. Refused rather than escalated:
    /// there is no confirmation that makes "and then you lose the machine" acceptable, and
    /// the honest alternative is the local control panel on the PC itself.
    /// </summary>
    private static readonly HashSet<string> OwnServices = new(StringComparer.OrdinalIgnoreCase)
    {
        "WolfAgent",
        "WolfAgentHelper",
    };

    /// <summary>
    /// The RPC and COM core.
    ///
    /// `RpcSs` is the canonical example of a service that cannot be stopped and cannot be
    /// started again: Windows itself refuses, and a machine whose start type was changed to
    /// disabled does not boot to a usable desktop. Everything that would perform the recovery
    /// depends on it, including the service control manager the recovery would go through.
    /// </summary>
    private static readonly HashSet<string> CoreServices = new(StringComparer.OrdinalIgnoreCase)
    {
        "RpcSs",
        "DcomLaunch",
        "RpcEptMapper",
        "LSM",
        "SamSs",
        "PlugPlay",
        "Power",
        "ProfSvc",
        "EventLog",
        "CryptSvc",
        "gpsvc",
        "UserManager",
        "SystemEventsBroker",
        "BrokerInfrastructure",
        "CoreMessagingRegistrar",
        "DsmSvc",
        "Winmgmt",
    };

    /// <summary>
    /// Everything the way back in depends on.
    ///
    /// This is the category that makes remote service control different from local service
    /// control. Stopping `Dhcp` on a machine in the next room is an inconvenience; stopping it
    /// on a machine in another country removes the only means of putting it back.
    ///
    /// `BFE` is here because it is not obviously networking: it is the base filtering engine,
    /// and stopping it takes the firewall *and* IPsec *and*, on many builds, the network stack
    /// with it. It is the classic example of a service whose name does not tell you what
    /// stopping it does.
    /// </summary>
    private static readonly HashSet<string> NetworkServices = new(StringComparer.OrdinalIgnoreCase)
    {
        "Dhcp",
        "Dnscache",
        "nsi",
        "NlaSvc",
        "netprofm",
        "BFE",
        "mpssvc",
        "Netman",
        "WinHttpAutoProxySvc",
        "LanmanWorkstation",
        "NcbService",
        "Wcmsvc",
        "WlanSvc",
        "iphlpsvc",
    };

    /// <summary>
    /// Whether WOLF will stop, restart or disable this service.
    ///
    /// The service is named rather than passed as an object so this stays decidable without
    /// touching the machine — which is what lets it be tested against a list of services from
    /// any Windows build rather than only the one it was written on.
    /// </summary>
    public static ServiceRefusal? WhyNot(string serviceName)
    {
        if (string.IsNullOrWhiteSpace(serviceName))
        {
            return new ServiceRefusal("unknown-service", "No service was named.");
        }

        if (OwnServices.Contains(serviceName))
        {
            return new ServiceRefusal(
                "wolf-service",
                "That is WOLF's own service. Stopping it would end this session and there " +
                "would be nothing left to report the result or to start it again. Use the " +
                "WOLF control panel on the PC itself.");
        }

        if (CoreServices.Contains(serviceName))
        {
            return new ServiceRefusal(
                "system-critical",
                "Windows depends on that service to run at all. Stopping or disabling it " +
                "remotely produces a machine that cannot be recovered without somebody at " +
                "the keyboard.");
        }

        if (NetworkServices.Contains(serviceName))
        {
            return new ServiceRefusal(
                "network-critical",
                "That service is part of how this PC stays reachable. Stopping it would cut " +
                "the connection WOLF would need to undo it.");
        }

        return null;
    }

    /// <summary>
    /// Whether an operation is one that can take a service away.
    ///
    /// Starting a service is always allowed, whatever it is: it restores function rather than
    /// removing it, and a service that should not have been started can be stopped again —
    /// which is not true in the other direction. The asymmetry is deliberate and is the same
    /// one <see cref="DeviceProtection"/> makes.
    /// </summary>
    public static bool Removes(string action) =>
        action is "stop" or "restart" or "disable";

    /// <summary>
    /// Whether WOLF will perform this action on this service.
    ///
    /// Null means yes. Everything else carries the reason, which is what the operator reads.
    /// </summary>
    public static ServiceRefusal? Check(string serviceName, string action)
    {
        if (!Removes(action))
        {
            // Still refused for WOLF's own services: "start the thing that is already
            // running" is harmless, but setting WOLF's own start type is not, and the
            // narrower rule would be one more thing to get wrong later.
            return OwnServices.Contains(serviceName ?? string.Empty) && action != "start"
                ? WhyNot(serviceName!)
                : null;
        }

        return WhyNot(serviceName);
    }

    /// <summary>Every service WOLF will not stop, for the operator to see before they try.</summary>
    public static IReadOnlyCollection<string> ProtectedNames() =>
        OwnServices.Concat(CoreServices).Concat(NetworkServices).ToArray();
}
