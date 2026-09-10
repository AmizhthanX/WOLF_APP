using Wolf.Agent.Core.Privileged;
using Wolf.Agent.Helper;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Which devices WOLF refuses to disable, and why.
///
/// Disabling hardware on a PC nobody is sitting at is the most dangerous thing WOLF does
/// short of destroying data. The question behind every rule here is the same one: *if this
/// goes wrong, can it be undone from the other end of a network?* Where the answer is no, the
/// device is refused rather than confirmed — a confirmation dialog asks somebody to accept a
/// risk, and it is the wrong tool when accepting it removes their ability to do anything
/// about it.
///
/// Changing a device needs administrator, so the acting half runs elevated and is not
/// exercised here. This is the deciding half, which is where a mistake would be quiet: a
/// wrong rule produces a confident refusal or a confident permission, and neither looks like
/// an error until somebody's machine does not come back.
/// </summary>
public sealed class DeviceProtectionTests
{
    private readonly ITestOutputHelper _output;

    public DeviceProtectionTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Theory]
    [InlineData("System")]
    [InlineData("Processor")]
    [InlineData("Computer")]
    [InlineData("SecurityDevices")]
    public void Windows_own_system_devices_are_never_disabled(string deviceClass)
    {
        // These are not features, they are the machine. Disabling one often removes the
        // means of turning it back on along with it.
        Assert.Equal("system-critical", DeviceProtection.For(deviceClass, networkConnected: false));
    }

    [Theory]
    [InlineData("DiskDrive")]
    [InlineData("HDC")]
    [InlineData("SCSIAdapter")]
    [InlineData("Volume")]
    public void Storage_is_never_disabled_even_when_it_might_not_be_the_boot_disk(string deviceClass)
    {
        // WOLF does not try to work out which controller carries the system volume. The
        // question it can answer honestly is "is this storage", and treating all of it as
        // boot-critical costs the ability to disable a spare disk — a much smaller loss than
        // a machine that does not come back.
        Assert.Equal("storage-critical", DeviceProtection.For(deviceClass, networkConnected: false));
    }

    [Fact]
    public void The_display_adapter_is_never_disabled()
    {
        // Disabling it ends the session WOLF captures, so the screen could not be used to
        // put it back.
        Assert.Equal("display-adapter", DeviceProtection.For("Display", networkConnected: false));
    }

    [Fact]
    public void A_connected_network_adapter_is_never_disabled()
    {
        // The one that would cut the link this PC is being managed over. Nothing could turn
        // it back on remotely, by definition.
        Assert.Equal("network-connected", DeviceProtection.For("Net", networkConnected: true));
    }

    [Fact]
    public void A_disconnected_network_adapter_can_be_disabled()
    {
        // Deliberately allowed. Refusing every network device would make the class useless
        // for what it is most often wanted for — turning off an adapter that is misbehaving
        // — and an idle one can be re-enabled from whatever link is actually carrying WOLF.
        Assert.Null(DeviceProtection.For("Net", networkConnected: false));
    }

    [Theory]
    [InlineData("AudioEndpoint")]
    [InlineData("Camera")]
    [InlineData("Bluetooth")]
    [InlineData("Printer")]
    [InlineData("USB")]
    // Windows' class for software-defined devices: virtual cameras, virtual audio. Exactly
    // what somebody wants to switch off remotely, and briefly classified system-critical
    // until this was run against a machine that had one.
    [InlineData("SoftwareDevice")]
    public void Ordinary_peripherals_are_allowed(string deviceClass)
    {
        // Allowed here does not mean easy: every one of these is still `critical` risk in
        // the command registry, so disabling it takes a confirmation, a re-authentication
        // and a single-use privileged grant. This list is the floor, not the ceiling.
        Assert.Null(DeviceProtection.For(deviceClass, networkConnected: false));
    }

    [Fact]
    public void A_device_with_no_class_is_allowed_rather_than_guessed_at()
    {
        // Windows leaves the class empty for devices it has not classified. Refusing them
        // all would be safe and would also refuse a large tail of ordinary hardware; the
        // command still needs a privileged grant either way.
        Assert.Null(DeviceProtection.For(null, networkConnected: false));
    }

    [Fact]
    public void Class_names_are_matched_regardless_of_case()
    {
        // Windows is inconsistent about these, and a protection that missed because of a
        // capital letter would be a protection that was not there at all.
        foreach (string spelling in new[] { "net", "NET", "Net" })
        {
            Assert.Equal("network-connected", DeviceProtection.For(spelling, networkConnected: true));
        }

        Assert.Equal("storage-critical", DeviceProtection.For("diskdrive", networkConnected: false));
    }

    [Fact]
    public void Every_protection_explains_itself()
    {
        // A refusal without a reason is the kind of answer that gets worked around with a
        // script rather than understood.
        foreach (string protection in new[]
                 {
                     "network-connected",
                     "storage-critical",
                     "display-adapter",
                     "system-critical",
                 })
        {
            string explanation = DeviceProtection.Explain(protection);
            _output.WriteLine($"{protection}: {explanation}");

            Assert.False(string.IsNullOrWhiteSpace(explanation));
            Assert.True(explanation.Length > 40, $"'{protection}' needs a real explanation");
        }
    }

    [Fact]
    public void A_refusal_names_the_device_and_says_why()
    {
        HelperDeviceResult refusal = DeviceProtection.Refuse(
            "PCI\\VEN_8086&DEV_15F3",
            "Intel Ethernet Controller I225-V",
            "network-connected");

        Assert.False(refusal.Ok);
        Assert.Equal("device-protected", refusal.Code);
        Assert.Equal("Intel Ethernet Controller I225-V", refusal.Name);
        Assert.Contains("network adapter", refusal.Message!, StringComparison.OrdinalIgnoreCase);

        // Nothing was touched, so nothing is claimed about the device's state.
        Assert.Equal("unknown", refusal.State);
        Assert.False(refusal.RestartRequired);
    }

    /* --------------------------------------------------------------------- */
    /* The name check                                                         */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_device_whose_name_has_changed_is_not_the_one_that_was_asked_for()
    {
        // The same idea as terminating a process by pid *and* expected name. Instance ids
        // are stable, but a dashboard can be minutes out of date, and disabling the wrong
        // device is not something an operator gets to take back.
        Assert.False(DeviceManager.NamesMatch("Realtek USB Audio", "Intel Ethernet Controller"));
    }

    [Fact]
    public void Trailing_space_and_case_do_not_count_as_a_different_device()
    {
        // Windows renames devices as drivers install. A case change is not somebody pointing
        // at different hardware, and refusing on one would make the check noise that
        // operators learn to work around.
        Assert.True(DeviceManager.NamesMatch("Intel Ethernet Controller", "intel ethernet controller "));
    }

    /* --------------------------------------------------------------------- */
    /* Against the devices this machine actually has                          */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void The_devices_on_this_pc_are_listed_with_their_protections()
    {
        // Listing is read-only WMI and needs no elevation, so unlike the acting half this
        // runs on an ordinary developer machine. It is worth running against real hardware:
        // the class names, the problem codes and the shape of an instance id are all things
        // a synthetic fixture would get subtly wrong.
        using var loggers = new XunitLoggerFactory(_output, Microsoft.Extensions.Logging.LogLevel.Warning);
        var manager = new DeviceManager(loggers.CreateLogger<DeviceManager>());

        IReadOnlyList<HelperDevice> devices = manager.List(null, includeAbsent: false);

        _output.WriteLine($"{devices.Count} device(s) present");
        Assert.True(devices.Count > 0, "no devices at all were reported, which cannot be right");

        foreach (HelperDevice device in devices)
        {
            Assert.False(string.IsNullOrWhiteSpace(device.InstanceId));
            Assert.False(string.IsNullOrWhiteSpace(device.Name));
            Assert.Contains(device.State, new[] { "working", "disabled", "error", "unknown" });

            // A device in `error` has to say what the problem is, the same way a drive with
            // unknown health has to say why it is unknown.
            if (device.State == "error") Assert.NotNull(device.Problem);
        }

        HelperDevice[] protectedDevices = devices.Where(device => device.ProtectedBy is not null).ToArray();

        foreach (HelperDevice device in protectedDevices.Take(8))
        {
            _output.WriteLine($"  protected ({device.ProtectedBy}): {device.DeviceClass} — {device.Name}");
        }

        // Every machine has storage and a display. If nothing came back protected, the rules
        // are not being applied to real class names — which is exactly the failure a
        // synthetic test cannot catch.
        Assert.True(
            protectedDevices.Length > 0,
            "no device on this PC was protected, so the rules are not matching real class names");
    }

    [Fact]
    public void This_pc_reports_a_storage_device_and_refuses_to_disable_it()
    {
        using var loggers = new XunitLoggerFactory(_output, Microsoft.Extensions.Logging.LogLevel.Warning);
        var manager = new DeviceManager(loggers.CreateLogger<DeviceManager>());

        HelperDevice[] disks = manager.List("DiskDrive", includeAbsent: false).ToArray();

        if (disks.Length == 0)
        {
            _output.WriteLine("No DiskDrive-class device here; skipping.");
            return;
        }

        foreach (HelperDevice disk in disks)
        {
            _output.WriteLine($"{disk.Name}: {disk.State}, protected by {disk.ProtectedBy}");
            Assert.Equal("storage-critical", disk.ProtectedBy);
        }

        // And the refusal happens before Windows is asked for anything, so this is safe to
        // run: nothing is disabled, and nothing was ever going to be.
        HelperDeviceResult refusal = manager.SetEnabled(disks[0].InstanceId, enabled: false, disks[0].Name);

        Assert.False(refusal.Ok);
        Assert.Equal("device-protected", refusal.Code);
        _output.WriteLine($"refused: {refusal.Message}");
    }

    [Fact]
    public void Asking_about_a_device_that_is_not_there_says_so()
    {
        using var loggers = new XunitLoggerFactory(_output, Microsoft.Extensions.Logging.LogLevel.Warning);
        var manager = new DeviceManager(loggers.CreateLogger<DeviceManager>());

        HelperDeviceResult result = manager.SetEnabled(
            @"PCI\VEN_0000&DEV_0000\NOT_A_REAL_DEVICE",
            enabled: true,
            "Something that does not exist");

        Assert.False(result.Ok);
        Assert.Equal("device-not-found", result.Code);
    }
}
