using Wolf.Agent.Core.Privileged;

namespace Wolf.Agent.Helper;

/// <summary>
/// Decides which devices WOLF will refuse to disable.
///
/// The reasoning behind every entry is the same question: *if this goes wrong, can it be
/// undone from the other end of a network?* Where the answer is no, the device is refused
/// rather than confirmed. A confirmation dialog asks the operator to accept a risk; it is the
/// wrong tool when accepting the risk can remove their ability to do anything about it.
///
/// Kept apart from the code that talks to Windows, and free of I/O, because this is the part
/// with the safety property. It can then be checked against the device list of any machine —
/// including ones far stranger than the one this was written on — rather than only by
/// disabling hardware to see what happens.
///
/// **This is a floor, not a ceiling.** Everything not refused here is still `critical` risk
/// in the command registry: confirmation, re-authentication, and a single-use privileged
/// grant. The list below is the set of things no amount of confirming should unlock.
/// </summary>
public static class DeviceProtection
{
    /// <summary>
    /// Device classes Windows uses for the machine's own skeleton.
    ///
    /// Processors, buses, firmware, memory controllers. Disabling one of these does not
    /// remove a feature, it removes the machine — often before it can be turned back on.
    ///
    /// `SecurityDevices` is here for the TPM: disabling it remotely can leave BitLocker
    /// unable to unlock the volume at boot, which is a machine that does not come back.
    ///
    /// `SoftwareDevice` is deliberately *not* here, though it was at first. It is Windows'
    /// class for software-defined devices — virtual cameras, virtual audio endpoints — which
    /// are exactly the kind of thing somebody legitimately wants to switch off remotely.
    /// Running this against a real machine is what caught it: a virtual camera came back
    /// classified as system-critical, which would have been a confident, permanent refusal
    /// of something entirely safe.
    /// </summary>
    private static readonly HashSet<string> SystemClasses = new(StringComparer.OrdinalIgnoreCase)
    {
        "System",
        "Processor",
        "Computer",
        "PCMCIA",
        "SecurityDevices",
        "FirmwareDevice",
        "Firmware",
        "MemoryTechnologyDriver",
    };

    /// <summary>
    /// Storage classes the machine may be booting from.
    ///
    /// WOLF does not try to work out which controller carries the system volume. The
    /// question it can answer honestly is "is this storage", and treating all of it as
    /// boot-critical costs the ability to disable a spare disk — which is a much smaller
    /// loss than a machine that does not come back.
    /// </summary>
    private static readonly HashSet<string> StorageClasses = new(StringComparer.OrdinalIgnoreCase)
    {
        "DiskDrive",
        "HDC",
        "SCSIAdapter",
        "Volume",
        "VolumeSnapshot",
        "SDHost",
    };

    /// <summary>Display adapters, which drive the session WOLF captures.</summary>
    private static readonly HashSet<string> DisplayClasses = new(StringComparer.OrdinalIgnoreCase)
    {
        "Display",
        "Monitor",
    };

    private static readonly HashSet<string> NetworkClasses = new(StringComparer.OrdinalIgnoreCase)
    {
        "Net",
    };

    /// <summary>
    /// Which protection applies to a device, or null when WOLF will let it be disabled.
    ///
    /// <paramref name="networkConnected"/> is whether this device is a network adapter that
    /// currently has a live connection. It is answered by the caller because it is a runtime
    /// fact rather than a property of the device.
    /// </summary>
    public static string? For(string? deviceClass, bool networkConnected)
    {
        if (deviceClass is null) return null;

        if (SystemClasses.Contains(deviceClass)) return "system-critical";
        if (StorageClasses.Contains(deviceClass)) return "storage-critical";
        if (DisplayClasses.Contains(deviceClass)) return "display-adapter";

        // Only *connected* adapters. A disconnected one can be disabled and re-enabled
        // safely, and refusing every network device would make the class useless for the
        // thing it is most often wanted for — turning off an adapter that is misbehaving.
        if (NetworkClasses.Contains(deviceClass) && networkConnected) return "network-connected";

        return null;
    }

    /// <summary>
    /// Why a protection exists, in the operator's terms.
    ///
    /// Every refusal carries one. "WOLF will not do that" without a reason is the kind of
    /// answer that gets worked around with a script rather than understood.
    /// </summary>
    public static string Explain(string protection) => protection switch
    {
        "network-connected" =>
            "This network adapter has a live connection. Disabling it could be the link WOLF " +
            "is managing this PC over, and nothing could turn it back on remotely.",
        "storage-critical" =>
            "This is a storage device or controller. Disabling it can stop the PC booting, " +
            "which is not something that can be undone from here.",
        "display-adapter" =>
            "This is a display adapter. Disabling it ends the session WOLF captures, so the " +
            "screen could not be used to put it back.",
        "system-critical" =>
            "This is one of Windows' own system devices. Disabling it can stop the machine " +
            "working entirely.",
        _ => "WOLF does not disable this kind of device remotely.",
    };

    /// <summary>The refusal a caller gets when it asks anyway.</summary>
    public static HelperDeviceResult Refuse(string instanceId, string name, string protection) =>
        new(
            InstanceId: instanceId,
            Name: name,
            Ok: false,
            State: "unknown",
            RestartRequired: false,
            Code: "device-protected",
            Message: Explain(protection));
}
