using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using SharpGen.Runtime;
using Vortice.MediaFoundation;

namespace Wolf.Agent.SessionHost.Encoding;

/// <summary>
/// ICodecAPI, the interface encoders actually listen to for rate control and key frames.
///
/// This exists because the obvious alternative silently does nothing. Codec properties look
/// like attributes, and <c>IMFTransform.Attributes.Set</c> accepts any GUID without
/// complaining, so setting <c>CODECAPI_AVEncVideoForceKeyFrame</c> there compiles, runs,
/// returns success, and has no effect on the bitstream. The encoder reads those properties
/// through ICodecAPI or not at all.
///
/// Only the first seven methods are declared. The vtable order is what matters for the ones
/// being called, and everything past <c>SetValue</c> is unused here.
/// </summary>
[ComImport]
[Guid("901db4c7-31ce-41a2-85dc-8fa0bf41b8da")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ICodecApi
{
    [PreserveSig]
    int IsSupported(ref Guid api);

    [PreserveSig]
    int IsModifiable(ref Guid api);

    [PreserveSig]
    int GetParameterRange(
        ref Guid api,
        [MarshalAs(UnmanagedType.Struct)] out object minimum,
        [MarshalAs(UnmanagedType.Struct)] out object maximum,
        [MarshalAs(UnmanagedType.Struct)] out object steppingDelta);

    [PreserveSig]
    int GetParameterValues(ref Guid api, out IntPtr values, out uint count);

    [PreserveSig]
    int GetDefaultValue(ref Guid api, [MarshalAs(UnmanagedType.Struct)] out object value);

    [PreserveSig]
    int GetValue(ref Guid api, [MarshalAs(UnmanagedType.Struct)] out object value);

    [PreserveSig]
    int SetValue(ref Guid api, [MarshalAs(UnmanagedType.Struct)] ref object value);
}

/// <summary>
/// A codec-property channel to one transform, or nothing if the transform has none.
///
/// Software encoders and some older drivers do not implement ICodecAPI. That is a real
/// limitation rather than a failure, so the caller gets a null and reports reduced control
/// instead of refusing to stream.
/// </summary>
[SupportedOSPlatform("windows10.0.19041.0")]
internal sealed class CodecApi : IDisposable
{
    private static readonly Guid ICodecApiIid = new("901db4c7-31ce-41a2-85dc-8fa0bf41b8da");

    private readonly ICodecApi _codec;
    private readonly ILogger _logger;
    private bool _disposed;

    private CodecApi(ICodecApi codec, ILogger logger)
    {
        _codec = codec;
        _logger = logger;
    }

    public static CodecApi? TryCreate(IMFTransform transform, ILogger logger)
    {
        IntPtr codecPointer = IntPtr.Zero;
        try
        {
            Guid iid = ICodecApiIid;
            int hr = Marshal.QueryInterface(transform.NativePointer, in iid, out codecPointer);
            if (hr < 0 || codecPointer == IntPtr.Zero)
            {
                logger.LogDebug(
                    "This encoder does not implement ICodecAPI (0x{Hr:X8}); codec properties are unavailable.",
                    hr);
                return null;
            }

            var codec = (ICodecApi)Marshal.GetTypedObjectForIUnknown(codecPointer, typeof(ICodecApi));
            return new CodecApi(codec, logger);
        }
        catch (Exception ex) when (ex is COMException or InvalidCastException or SharpGenException)
        {
            logger.LogDebug(ex, "ICodecAPI could not be obtained from the encoder.");
            return null;
        }
        finally
        {
            if (codecPointer != IntPtr.Zero)
            {
                Marshal.Release(codecPointer);
            }
        }
    }

    /// <summary>Whether the encoder knows this property at all.</summary>
    public bool IsSupported(Guid property)
    {
        if (_disposed) return false;

        try
        {
            return _codec.IsSupported(ref property) == 0;
        }
        catch (COMException)
        {
            return false;
        }
    }

    /// <summary>Whether this property can be changed while the encoder is running.</summary>
    public bool IsModifiable(Guid property)
    {
        if (_disposed) return false;

        try
        {
            return _codec.IsModifiable(ref property) == 0;
        }
        catch (COMException)
        {
            return false;
        }
    }

    /// <summary>
    /// Set a property, reporting whether the encoder took it.
    ///
    /// The return value is the point: every caller here has a fallback, and one that thinks
    /// it set a bitrate it did not set would report a stream quality the operator is not
    /// actually getting.
    /// </summary>
    public bool TrySet(Guid property, uint value)
    {
        if (_disposed) return false;

        try
        {
            object boxed = value;
            int hr = _codec.SetValue(ref property, ref boxed);
            if (hr < 0)
            {
                _logger.LogDebug(
                    "The encoder refused codec property {Property} = {Value} (0x{Hr:X8}).",
                    property,
                    value,
                    hr);
                return false;
            }

            return true;
        }
        catch (Exception ex) when (ex is COMException or ArgumentException)
        {
            _logger.LogDebug(ex, "Setting codec property {Property} failed.", property);
            return false;
        }
    }

    public uint? TryGet(Guid property)
    {
        if (_disposed) return null;

        try
        {
            if (_codec.GetValue(ref property, out object value) < 0) return null;
            return value switch
            {
                uint unsigned => unsigned,
                int signed and >= 0 => (uint)signed,
                _ => null,
            };
        }
        catch (Exception ex) when (ex is COMException or InvalidCastException)
        {
            return null;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        if (Marshal.IsComObject(_codec))
        {
            Marshal.ReleaseComObject(_codec);
        }
    }
}
