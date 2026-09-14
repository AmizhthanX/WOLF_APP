using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Wolf.Agent.Core.Native;

namespace Wolf.Agent.Core.Telemetry;

/// <summary>One physical GPU, as the display kernel describes it.</summary>
/// <param name="AdapterId">
/// Stable across reboots: the PCI location where there is one. The LUID is not — Windows assigns
/// a new one every boot — and a series key that changed on every restart would break every
/// history chart and every alert rule narrowed to one GPU.
/// </param>
/// <param name="Luid">The LUID in the form performance counter instance names use.</param>
public sealed record GpuAdapter(
    string AdapterId,
    string Luid,
    string Name,
    long? DedicatedVideoMemoryBytes,
    double? TemperatureCelsius);

/// <summary>
/// Lists the machine's real GPUs.
///
/// Software adapters (the Microsoft Basic Render Driver) and adapters that cannot render (indirect
/// display drivers such as virtual monitors) are left out: they have no load, no memory and no
/// temperature, and listing them makes a one-GPU machine look like a three-GPU one.
/// </summary>
[SupportedOSPlatform("windows")]
public static class GpuAdapters
{
    public static string FormatLuid(int highPart, uint lowPart) => $"0x{(uint)highPart:X8}_0x{lowPart:X8}";

    public static IReadOnlyList<GpuAdapter> Enumerate()
    {
        var enumerate = new D3dkmt.EnumAdapters2();
        if (D3dkmt.D3DKMTEnumAdapters2(ref enumerate) != 0 || enumerate.NumAdapters == 0)
        {
            return Array.Empty<GpuAdapter>();
        }

        int entrySize = Marshal.SizeOf<D3dkmt.AdapterInfo>();
        IntPtr buffer = Marshal.AllocHGlobal(entrySize * (int)enumerate.NumAdapters);
        var infos = new List<D3dkmt.AdapterInfo>();

        try
        {
            enumerate.pAdapters = buffer;
            if (D3dkmt.D3DKMTEnumAdapters2(ref enumerate) != 0)
            {
                return Array.Empty<GpuAdapter>();
            }

            for (int index = 0; index < enumerate.NumAdapters; index++)
            {
                infos.Add(Marshal.PtrToStructure<D3dkmt.AdapterInfo>(buffer + index * entrySize));
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }

        var adapters = new List<GpuAdapter>();
        var seenLuids = new HashSet<string>(StringComparer.Ordinal);

        foreach (D3dkmt.AdapterInfo info in infos)
        {
            try
            {
                string luid = FormatLuid(info.LuidHighPart, info.LuidLowPart);

                // The same adapter appears once per display source it drives.
                if (!seenLuids.Add(luid))
                {
                    continue;
                }

                if (!D3dkmt.TryQuery(info.hAdapter, D3dkmt.QueryAdapterType, default(D3dkmt.AdapterType), out D3dkmt.AdapterType type) ||
                    (type.Flags & D3dkmt.AdapterSoftwareDevice) != 0 ||
                    (type.Flags & D3dkmt.AdapterRenderSupported) == 0)
                {
                    continue;
                }

                string name = D3dkmt.TryQueryName(info.hAdapter) ?? "Unknown GPU";

                long? dedicated = D3dkmt.TryQuery(info.hAdapter, D3dkmt.QuerySegmentSize, default(D3dkmt.SegmentSizeInfo), out D3dkmt.SegmentSizeInfo segments) &&
                                  segments.DedicatedVideoMemorySize > 0
                    ? (long)segments.DedicatedVideoMemorySize
                    : null;

                string adapterId = D3dkmt.TryQuery(info.hAdapter, D3dkmt.QueryAdapterAddress, default(D3dkmt.AdapterAddress), out D3dkmt.AdapterAddress address) &&
                                   address.BusNumber != uint.MaxValue
                    ? $"pci-{address.BusNumber}.{address.DeviceNumber}.{address.FunctionNumber}"
                    : $"luid-{luid}";

                double? temperature = null;
                if (D3dkmt.TryQuery(info.hAdapter, D3dkmt.QueryAdapterPerfData, new D3dkmt.AdapterPerfData { PhysicalAdapterIndex = 0 }, out D3dkmt.AdapterPerfData perf) &&
                    perf.Temperature > 0)
                {
                    // Zero is the driver saying "no sensor", not a GPU at freezing point.
                    temperature = perf.Temperature / 10.0;
                }

                adapters.Add(new GpuAdapter(adapterId, luid, name, dedicated, temperature));
            }
            finally
            {
                var close = new D3dkmt.CloseAdapterArgs { hAdapter = info.hAdapter };
                D3dkmt.D3DKMTCloseAdapter(ref close);
            }
        }

        return adapters;
    }
}
