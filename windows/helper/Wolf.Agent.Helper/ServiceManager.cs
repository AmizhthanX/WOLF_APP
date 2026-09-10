using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.ServiceProcess;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Privileged;

namespace Wolf.Agent.Helper;

/// <summary>
/// Talking to the Windows service control manager.
///
/// The I/O half of service management; the decisions live in <see cref="ServiceProtection"/>.
/// Split for the same reason as devices — the part with the safety property should be
/// checkable without stopping anything on a real machine.
///
/// <see cref="ServiceController"/> covers listing, starting and stopping. It has no way to
/// read or change a start type, so that goes through `advapi32` directly. Both are here rather
/// than in the agent because both need administrator, and the whole point of the helper is
/// that the process holding the network connection is not the process holding those rights.
///
/// **Nothing here creates or deletes a service.** `CreateService` and `DeleteService` are not
/// called and there is no operation that would reach them: installing a service is a
/// persistence mechanism, and a remote-management tool that can do it is a different product.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed partial class ServiceManager
{
    /// <summary>
    /// How long to wait for a service to reach the state it was asked for.
    ///
    /// Long enough for a database or a hypervisor to shut down cleanly, short enough that an
    /// operator is not left staring at nothing. A service that has not finished by then is
    /// reported as still changing rather than as failed — because it usually is.
    /// </summary>
    private static readonly TimeSpan Settle = TimeSpan.FromSeconds(30);

    private readonly ILogger<ServiceManager> _logger;

    public ServiceManager(ILogger<ServiceManager> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Every service on the machine, with what WOLF would refuse to do to each.
    ///
    /// The refusal is computed here rather than left to the client, so an operator sees which
    /// services are off limits *before* they try one — the same reason the device list carries
    /// its own protection field.
    /// </summary>
    public IReadOnlyList<HelperService> List(string? nameFilter)
    {
        var services = new List<HelperService>();

        foreach (ServiceController controller in ServiceController.GetServices())
        {
            using (controller)
            {
                if (nameFilter is { Length: > 0 } &&
                    !controller.ServiceName.Contains(nameFilter, StringComparison.OrdinalIgnoreCase) &&
                    !controller.DisplayName.Contains(nameFilter, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                services.Add(Describe(controller));
            }
        }

        services.Sort((left, right) =>
            string.Compare(left.DisplayName, right.DisplayName, StringComparison.OrdinalIgnoreCase));

        return services;
    }

    private HelperService Describe(ServiceController controller)
    {
        string? startType = null;
        string? account = null;
        string? path = null;

        try
        {
            (startType, account, path) = ReadConfiguration(controller.ServiceName);
        }
        catch (Win32Exception ex)
        {
            // A service whose configuration cannot be read is still worth listing. Dropping
            // it would make the list quietly disagree with services.msc, which is worse than
            // a row with some fields missing.
            _logger.LogDebug(
                "The configuration of {Service} could not be read ({Code}).",
                controller.ServiceName,
                ex.NativeErrorCode);
        }

        ServiceRefusal? refusal = ServiceProtection.WhyNot(controller.ServiceName);

        return new HelperService(
            controller.ServiceName,
            controller.DisplayName,
            controller.Status.ToString().ToLowerInvariant(),
            startType,
            account,
            path,
            CanStopSafely(controller),
            refusal?.Code);
    }

    /// <summary>
    /// Whether Windows itself says the service accepts a stop.
    ///
    /// Distinct from WOLF's own refusal and reported separately: "Windows will not stop this"
    /// and "WOLF will not ask it to" are different facts, and an operator debugging a service
    /// that will not stop needs to know which one they are looking at.
    /// </summary>
    private static bool CanStopSafely(ServiceController controller)
    {
        try
        {
            return controller.CanStop;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    /// <summary>
    /// Start, stop or restart a service.
    ///
    /// The result reports the state Windows is in afterwards, not the state that was asked
    /// for. A service that was told to stop and did not is the case this exists to make
    /// visible, and reporting the request back as though it were the outcome is exactly the
    /// kind of false success the whole product is built to avoid.
    /// </summary>
    public HelperServiceResult Control(string serviceName, string action, string expectedDisplayName)
    {
        ServiceRefusal? refusal = ServiceProtection.Check(serviceName, action);
        if (refusal is not null)
        {
            return new HelperServiceResult(serviceName, expectedDisplayName, false, "unknown", refusal.Code, refusal.Reason);
        }

        ServiceController controller;

        try
        {
            controller = new ServiceController(serviceName);
            _ = controller.Status;
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentException)
        {
            return new HelperServiceResult(
                serviceName, expectedDisplayName, false, "unknown", "unknown-service",
                "There is no service with that name on this PC.");
        }

        using (controller)
        {
            // The display name is checked the way a process id is checked against its name
            // before it is terminated. A service list an operator read a minute ago can
            // describe a machine that has changed since.
            if (!string.Equals(controller.DisplayName, expectedDisplayName, StringComparison.OrdinalIgnoreCase))
            {
                return new HelperServiceResult(
                    serviceName,
                    controller.DisplayName,
                    false,
                    controller.Status.ToString().ToLowerInvariant(),
                    "name-mismatch",
                    $"That service is called '{controller.DisplayName}' on this PC now, not " +
                    $"'{expectedDisplayName}'. Nothing was changed.");
            }

            try
            {
                return Apply(controller, action, serviceName);
            }
            catch (Win32Exception ex)
            {
                _logger.LogWarning(
                    "Service {Service} could not be {Action}ed ({Code}).",
                    serviceName,
                    action,
                    ex.NativeErrorCode);

                return new HelperServiceResult(
                    serviceName, controller.DisplayName, false,
                    SafeStatus(controller), "failed", WindowsSaid(ex.NativeErrorCode));
            }
            catch (InvalidOperationException ex)
            {
                return new HelperServiceResult(
                    serviceName, controller.DisplayName, false,
                    SafeStatus(controller), "failed",
                    ex.InnerException is Win32Exception inner
                        ? WindowsSaid(inner.NativeErrorCode)
                        : "Windows would not perform that on this service.");
            }
        }
    }

    private HelperServiceResult Apply(ServiceController controller, string action, string serviceName)
    {
        switch (action)
        {
            case "start":
                if (controller.Status is ServiceControllerStatus.Running)
                {
                    // Not an error, and not a lie either: reported as done because the state
                    // the operator asked for is the state the machine is in.
                    return Done(controller, serviceName, "That service was already running.");
                }

                controller.Start();
                controller.WaitForStatus(ServiceControllerStatus.Running, Settle);
                break;

            case "stop":
                if (controller.Status is ServiceControllerStatus.Stopped)
                {
                    return Done(controller, serviceName, "That service was already stopped.");
                }

                if (!controller.CanStop)
                {
                    return new HelperServiceResult(
                        serviceName, controller.DisplayName, false,
                        SafeStatus(controller), "not-stoppable",
                        "Windows does not allow that service to be stopped.");
                }

                controller.Stop();
                controller.WaitForStatus(ServiceControllerStatus.Stopped, Settle);
                break;

            case "restart":
                if (controller.Status is not ServiceControllerStatus.Stopped)
                {
                    if (!controller.CanStop)
                    {
                        return new HelperServiceResult(
                            serviceName, controller.DisplayName, false,
                            SafeStatus(controller), "not-stoppable",
                            "Windows does not allow that service to be stopped, so it cannot be restarted.");
                    }

                    controller.Stop();
                    controller.WaitForStatus(ServiceControllerStatus.Stopped, Settle);
                }

                controller.Start();
                controller.WaitForStatus(ServiceControllerStatus.Running, Settle);
                break;

            default:
                return new HelperServiceResult(
                    serviceName, controller.DisplayName, false, SafeStatus(controller),
                    "malformed", $"'{action}' is not something WOLF does to a service.");
        }

        controller.Refresh();
        return Done(controller, serviceName, null);
    }

    private HelperServiceResult Done(ServiceController controller, string serviceName, string? note)
    {
        _logger.LogInformation(
            "Service {Service} is now {Status}.",
            serviceName,
            controller.Status);

        return new HelperServiceResult(
            serviceName,
            controller.DisplayName,
            true,
            controller.Status.ToString().ToLowerInvariant(),
            null,
            note);
    }

    private static string SafeStatus(ServiceController controller)
    {
        try
        {
            controller.Refresh();
            return controller.Status.ToString().ToLowerInvariant();
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
        {
            return "unknown";
        }
    }

    /// <summary>
    /// Change when a service starts.
    ///
    /// Separate from starting and stopping because it survives a reboot, which makes it the
    /// more dangerous of the two: a service stopped by mistake comes back when the machine
    /// does, and a service disabled by mistake does not.
    /// </summary>
    public HelperServiceResult SetStartType(string serviceName, string startType, string expectedDisplayName)
    {
        uint mode = startType switch
        {
            "automatic" => ServiceAutoStart,
            "automatic-delayed" => ServiceAutoStart,
            "manual" => ServiceDemandStart,
            "disabled" => ServiceDisabled,
            _ => 0,
        };

        if (mode == 0)
        {
            return new HelperServiceResult(
                serviceName, expectedDisplayName, false, "unknown", "malformed",
                $"'{startType}' is not a start type WOLF sets.");
        }

        ServiceRefusal? refusal = ServiceProtection.Check(
            serviceName,
            startType == "disabled" ? "disable" : "configure");

        if (refusal is not null)
        {
            return new HelperServiceResult(serviceName, expectedDisplayName, false, "unknown", refusal.Code, refusal.Reason);
        }

        using var controller = new ServiceController(serviceName);

        try
        {
            if (!string.Equals(controller.DisplayName, expectedDisplayName, StringComparison.OrdinalIgnoreCase))
            {
                return new HelperServiceResult(
                    serviceName, controller.DisplayName, false, SafeStatus(controller), "name-mismatch",
                    $"That service is called '{controller.DisplayName}' on this PC now. Nothing was changed.");
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentException)
        {
            return new HelperServiceResult(
                serviceName, expectedDisplayName, false, "unknown", "unknown-service",
                "There is no service with that name on this PC.");
        }

        IntPtr manager = OpenSCManagerW(null, null, ScManagerConnect);
        if (manager == IntPtr.Zero)
        {
            return Failed(serviceName, expectedDisplayName, Marshal.GetLastWin32Error());
        }

        try
        {
            IntPtr handle = OpenServiceW(manager, serviceName, ServiceChangeConfig | ServiceQueryConfig);
            if (handle == IntPtr.Zero)
            {
                return Failed(serviceName, expectedDisplayName, Marshal.GetLastWin32Error());
            }

            try
            {
                if (!ChangeServiceConfigW(
                        handle, ServiceNoChange, mode, ServiceNoChange,
                        null, null, IntPtr.Zero, null, null, null, null))
                {
                    return Failed(serviceName, expectedDisplayName, Marshal.GetLastWin32Error());
                }

                // The delayed flag is a second call, and it is set *and cleared* rather than
                // only set: switching a delayed-start service to plain automatic and leaving
                // the flag on would produce a service whose reported start type is not the
                // one it has.
                SetDelayedStart(handle, startType == "automatic-delayed");

                _logger.LogInformation("Service {Service} now starts {StartType}.", serviceName, startType);

                return new HelperServiceResult(
                    serviceName, controller.DisplayName, true, SafeStatus(controller), null,
                    startType == "disabled"
                        ? "The service is disabled. It is still running if it was already; it will not start again."
                        : null);
            }
            finally
            {
                CloseServiceHandle(handle);
            }
        }
        finally
        {
            CloseServiceHandle(manager);
        }
    }

    private static void SetDelayedStart(IntPtr service, bool delayed)
    {
        var info = new ServiceDelayedAutoStartInfo { DelayedAutostart = delayed };
        IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf<ServiceDelayedAutoStartInfo>());

        try
        {
            Marshal.StructureToPtr(info, buffer, false);
            ChangeServiceConfig2W(service, ServiceConfigDelayedAutoStartInfo, buffer);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private HelperServiceResult Failed(string serviceName, string displayName, int error)
    {
        _logger.LogWarning("The configuration of {Service} could not be changed ({Code}).", serviceName, error);

        return new HelperServiceResult(
            serviceName, displayName, false, "unknown", "failed", WindowsSaid(error));
    }

    /// <summary>Windows' own reason, in the operator's terms.</summary>
    private static string WindowsSaid(int error) => error switch
    {
        5 => "Windows refused: access is denied even to an administrator for this service.",
        1051 => "Other running services depend on that one, so Windows would not stop it.",
        1053 => "The service did not respond in time.",
        1056 => "That service is already running.",
        1060 => "There is no service with that name on this PC.",
        1062 => "That service is not running.",
        1072 => "That service is marked for deletion.",
        _ => $"Windows refused the change (error {error}).",
    };

    /// <summary>
    /// Read a service's configuration.
    ///
    /// `QueryServiceConfig` is called twice on purpose: the first call fails with the size it
    /// wants, which is the only way to size the buffer for a structure with trailing strings.
    /// </summary>
    private static (string StartType, string? Account, string? Path) ReadConfiguration(string serviceName)
    {
        IntPtr manager = OpenSCManagerW(null, null, ScManagerConnect);
        if (manager == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

        try
        {
            IntPtr service = OpenServiceW(manager, serviceName, ServiceQueryConfig);
            if (service == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

            try
            {
                QueryServiceConfigW(service, IntPtr.Zero, 0, out int needed);

                IntPtr buffer = Marshal.AllocHGlobal(needed);

                try
                {
                    if (!QueryServiceConfigW(service, buffer, needed, out _))
                    {
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    }

                    QueryServiceConfig config = Marshal.PtrToStructure<QueryServiceConfig>(buffer);

                    string startType = config.StartType switch
                    {
                        ServiceBootStart => "boot",
                        ServiceSystemStart => "system",
                        ServiceAutoStart => IsDelayed(service) ? "automatic-delayed" : "automatic",
                        ServiceDemandStart => "manual",
                        ServiceDisabled => "disabled",
                        _ => "unknown",
                    };

                    return (
                        startType,
                        config.ServiceStartName == IntPtr.Zero ? null : Marshal.PtrToStringUni(config.ServiceStartName),
                        config.BinaryPathName == IntPtr.Zero ? null : Marshal.PtrToStringUni(config.BinaryPathName));
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
            finally
            {
                CloseServiceHandle(service);
            }
        }
        finally
        {
            CloseServiceHandle(manager);
        }
    }

    private static bool IsDelayed(IntPtr service)
    {
        QueryServiceConfig2W(service, ServiceConfigDelayedAutoStartInfo, IntPtr.Zero, 0, out int needed);
        if (needed <= 0) return false;

        IntPtr buffer = Marshal.AllocHGlobal(needed);

        try
        {
            if (!QueryServiceConfig2W(service, ServiceConfigDelayedAutoStartInfo, buffer, needed, out _))
            {
                return false;
            }

            return Marshal.PtrToStructure<ServiceDelayedAutoStartInfo>(buffer).DelayedAutostart;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /* --------------------------------------------------------------------- */
    /* Interop                                                                */
    /* --------------------------------------------------------------------- */

    private const uint ScManagerConnect = 0x0001;
    private const uint ServiceQueryConfig = 0x0001;
    private const uint ServiceChangeConfig = 0x0002;
    private const uint ServiceNoChange = 0xFFFFFFFF;
    private const uint ServiceBootStart = 0x00000000;
    private const uint ServiceSystemStart = 0x00000001;
    private const uint ServiceAutoStart = 0x00000002;
    private const uint ServiceDemandStart = 0x00000003;
    private const uint ServiceDisabled = 0x00000004;
    private const int ServiceConfigDelayedAutoStartInfo = 3;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct QueryServiceConfig
    {
        public uint ServiceType;
        public uint StartType;
        public uint ErrorControl;
        public IntPtr BinaryPathName;
        public IntPtr LoadOrderGroup;
        public uint TagId;
        public IntPtr Dependencies;
        public IntPtr ServiceStartName;
        public IntPtr DisplayName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceDelayedAutoStartInfo
    {
        [MarshalAs(UnmanagedType.Bool)]
        public bool DelayedAutostart;
    }

    [LibraryImport("advapi32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial IntPtr OpenSCManagerW(string? machineName, string? databaseName, uint access);

    [LibraryImport("advapi32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial IntPtr OpenServiceW(IntPtr manager, string serviceName, uint access);

    [LibraryImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseServiceHandle(IntPtr handle);

    [LibraryImport("advapi32.dll", SetLastError = true, EntryPoint = "QueryServiceConfigW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool QueryServiceConfigW(IntPtr service, IntPtr config, int size, out int needed);

    [LibraryImport("advapi32.dll", SetLastError = true, EntryPoint = "QueryServiceConfig2W")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool QueryServiceConfig2W(IntPtr service, int level, IntPtr buffer, int size, out int needed);

    [LibraryImport("advapi32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool ChangeServiceConfigW(
        IntPtr service,
        uint serviceType,
        uint startType,
        uint errorControl,
        string? binaryPathName,
        string? loadOrderGroup,
        IntPtr tagId,
        string? dependencies,
        string? serviceStartName,
        string? password,
        string? displayName);

    [LibraryImport("advapi32.dll", SetLastError = true, EntryPoint = "ChangeServiceConfig2W")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool ChangeServiceConfig2W(IntPtr service, int level, IntPtr info);
}
