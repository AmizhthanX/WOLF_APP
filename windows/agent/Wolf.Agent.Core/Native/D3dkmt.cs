using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Wolf.Agent.Core.Native;

/// <summary>
/// The Windows display-kernel thunks WOLF reads GPU facts from.
///
/// Chosen over DXGI because every call here is a plain struct in and a plain struct out: no COM,
/// no vtables, no unsafe code, and nothing that creates a device on the GPU just to ask it its
/// name. Task Manager reads the same adapter performance data through the same call.
///
/// Read-only by construction. The only operations bound are enumerate, query and close.
/// </summary>
[SupportedOSPlatform("windows")]
internal static partial class D3dkmt
{
    // KMTQUERYADAPTERINFOTYPE values used, from d3dkmthk.h.
    internal const int QuerySegmentSize = 3;
    internal const int QueryAdapterAddress = 6;
    internal const int QueryAdapterRegistryInfo = 8;
    internal const int QueryAdapterType = 15;
    internal const int QueryAdapterPerfData = 62;

    /// <summary>D3DKMT_ADAPTERTYPE bit flags.</summary>
    internal const uint AdapterRenderSupported = 1u << 0;
    internal const uint AdapterSoftwareDevice = 1u << 2;

    [StructLayout(LayoutKind.Sequential)]
    internal struct AdapterInfo
    {
        public uint hAdapter;
        public uint LuidLowPart;
        public int LuidHighPart;
        public uint NumOfSources;
        public int bPrecisePresentRegionsPreferred;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct EnumAdapters2
    {
        public uint NumAdapters;
        public IntPtr pAdapters;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct QueryAdapterInfoArgs
    {
        public uint hAdapter;
        public int Type;
        public IntPtr pPrivateDriverData;
        public uint PrivateDriverDataSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct CloseAdapterArgs
    {
        public uint hAdapter;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SegmentSizeInfo
    {
        public ulong DedicatedVideoMemorySize;
        public ulong DedicatedSystemMemorySize;
        public ulong SharedSystemMemorySize;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct AdapterAddress
    {
        public uint BusNumber;
        public uint DeviceNumber;
        public uint FunctionNumber;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct AdapterType
    {
        public uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct AdapterPerfData
    {
        public uint PhysicalAdapterIndex;
        public ulong MemoryFrequency;
        public ulong MaxMemoryFrequency;
        public ulong MaxMemoryFrequencyOC;
        public ulong MemoryBandwidth;
        public ulong PCIEBandwidth;
        public uint FanRPM;
        /// <summary>Tenths of a percent of the adapter's power limit — not watts.</summary>
        public uint Power;
        /// <summary>Tenths of a degree Celsius; zero when the driver does not report one.</summary>
        public uint Temperature;
        public byte PowerStateOverride;
    }

    /// <summary>Four WCHAR[260] strings; the adapter's name is the first.</summary>
    internal const int RegistryInfoSize = 4 * 260 * 2;

    [LibraryImport("gdi32.dll")]
    internal static partial int D3DKMTEnumAdapters2(ref EnumAdapters2 args);

    [LibraryImport("gdi32.dll")]
    internal static partial int D3DKMTQueryAdapterInfo(ref QueryAdapterInfoArgs args);

    [LibraryImport("gdi32.dll")]
    internal static partial int D3DKMTCloseAdapter(ref CloseAdapterArgs args);

    /// <summary>
    /// Query one fixed-size structure. False — never a zeroed structure — when the driver refuses.
    /// </summary>
    internal static bool TryQuery<T>(uint adapter, int type, T input, out T output)
        where T : struct
    {
        output = default;
        int size = Marshal.SizeOf<T>();
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(input, buffer, fDeleteOld: false);
            var args = new QueryAdapterInfoArgs
            {
                hAdapter = adapter,
                Type = type,
                pPrivateDriverData = buffer,
                PrivateDriverDataSize = (uint)size,
            };

            if (D3DKMTQueryAdapterInfo(ref args) != 0)
            {
                return false;
            }

            output = Marshal.PtrToStructure<T>(buffer);
            return true;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    internal static string? TryQueryName(uint adapter)
    {
        IntPtr buffer = Marshal.AllocHGlobal(RegistryInfoSize);
        try
        {
            var args = new QueryAdapterInfoArgs
            {
                hAdapter = adapter,
                Type = QueryAdapterRegistryInfo,
                pPrivateDriverData = buffer,
                PrivateDriverDataSize = RegistryInfoSize,
            };

            if (D3DKMTQueryAdapterInfo(ref args) != 0)
            {
                return null;
            }

            string? name = Marshal.PtrToStringUni(buffer, 260)?.Split('\0')[0].Trim();
            return string.IsNullOrEmpty(name) ? null : name;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }
}
