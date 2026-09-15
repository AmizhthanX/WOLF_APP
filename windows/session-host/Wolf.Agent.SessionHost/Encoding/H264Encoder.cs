using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using SharpGen.Runtime;
using Vortice.Direct3D11;
using Vortice.MediaFoundation;
using Wolf.Agent.SessionHost.Capture;

namespace Wolf.Agent.SessionHost.Encoding;

/// <summary>One encoded picture, ready to be packetised for RTP.</summary>
public sealed record EncodedVideoFrame(
    byte[] Data,
    TimeSpan Timestamp,
    TimeSpan Duration,
    bool IsKeyFrame);

/// <summary>What the stream asked for. The encoder clamps to what the hardware allows.</summary>
public sealed record EncoderSettings(
    int Width,
    int Height,
    int FrameRate,
    int BitrateBitsPerSecond,
    /// <summary>Seconds between forced key frames. Shorter costs bitrate; longer costs recovery time.</summary>
    int KeyFrameIntervalSeconds = 2,
    /// <summary>
    /// The H.264 profile to produce, as an MF_MT_MPEG2_PROFILE value. High unless the client said it cannot
    /// decode High — see <see cref="H264ProfileChoice"/>.
    /// </summary>
    uint Profile = MfGuids.H264ProfileHigh);

/// <summary>
/// The H.264 encoder.
///
/// Hardware encoders on Windows are almost always *asynchronous* Media Foundation
/// transforms, which do not simply take a frame and hand one back. They raise an event when
/// they want input and another when output is ready, and they buffer several frames in
/// between. This class hides that: callers push a texture and collect whatever came out,
/// and the event bookkeeping stays here.
///
/// Events are polled rather than waited on. A blocking wait would be simpler, but an
/// encoder that stops raising events — a driver reset, a GPU hang — would take the whole
/// capture thread with it. Polling with a bounded deadline means a stalled encoder drops
/// frames and says so, which is recoverable.
/// </summary>
[SupportedOSPlatform("windows10.0.19041.0")]
public sealed class H264Encoder : IDisposable
{
    /// <summary>How long to wait for the encoder to ask for input before dropping a frame.</summary>
    private static readonly TimeSpan InputDeadline = TimeSpan.FromMilliseconds(100);

    private readonly MediaFoundationPlatform _platform;
    private readonly IMFTransform _transform;
    private readonly IMFMediaEventGenerator? _events;
    private readonly IMFDXGIDeviceManager? _deviceManager;
    private readonly CodecApi? _codec;
    private readonly ILogger<H264Encoder> _logger;
    private readonly EncoderSettings _settings;
    private readonly bool _providesSamples;
    private readonly int _outputBufferSize;
    private readonly object _gate = new();

    private int _needInputCredits;
    private long _framesIn;
    private long _framesOut;
    private long _framesDropped;
    private bool _disposed;

    private H264Encoder(
        MediaFoundationPlatform platform,
        IMFTransform transform,
        IMFMediaEventGenerator? events,
        IMFDXGIDeviceManager? deviceManager,
        CodecApi? codec,
        EncoderSettings settings,
        bool isHardware,
        string encoderName,
        bool providesSamples,
        int outputBufferSize,
        byte[] parameterSets,
        ILogger<H264Encoder> logger)
    {
        _platform = platform;
        _transform = transform;
        _events = events;
        _deviceManager = deviceManager;
        _codec = codec;
        _settings = settings;
        _providesSamples = providesSamples;
        _outputBufferSize = outputBufferSize;
        _logger = logger;

        IsHardware = isHardware;
        EncoderName = encoderName;
        ParameterSets = parameterSets;
    }

    public bool IsHardware { get; }

    public string EncoderName { get; }

    /// <summary>True when this encoder runs on the asynchronous transform model.</summary>
    public bool IsAsync => _events is not null;

    /// <summary>
    /// Whether this encoder will produce a key frame on request.
    ///
    /// Surfaced rather than assumed because it changes what a client can be promised. Where
    /// it is false, a viewer joining an established stream waits for the next scheduled key
    /// frame instead of getting an immediate one, and the UI should say so rather than
    /// appearing to hang.
    /// </summary>
    public bool SupportsForcedKeyFrames { get; private init; }

    /// <summary>Whether the bitrate can be changed on a running encoder.</summary>
    public bool SupportsBitrateChange { get; private init; }

    /// <summary>
    /// SPS and PPS for the stream, when the encoder published them up front.
    ///
    /// A decoder cannot start without these. Most encoders also repeat them before each key
    /// frame, but having them separately means a client joining mid-stream can be given
    /// them immediately rather than waiting for the next key frame.
    /// </summary>
    public byte[] ParameterSets { get; }

    public long FramesEncoded => Interlocked.Read(ref _framesOut);

    public long FramesDropped => Interlocked.Read(ref _framesDropped);

    /// <summary>
    /// Create an encoder, preferring hardware.
    ///
    /// Falls back to the software encoder when there is no hardware one, and says which it
    /// got — the difference is several percent of a CPU, and an operator wondering why a
    /// machine is warm deserves to be able to find out.
    /// </summary>
    public static H264Encoder? TryCreate(
        CaptureDevice device,
        EncoderSettings settings,
        ILogger<H264Encoder> logger)
    {
        foreach (bool hardware in new[] { true, false })
        {
            H264Encoder? encoder = TryCreateWith(device, settings, hardware, logger);
            if (encoder is not null) return encoder;
        }

        logger.LogError("No usable H.264 encoder could be created on this PC.");
        return null;
    }

    private static H264Encoder? TryCreateWith(
        CaptureDevice device,
        EncoderSettings settings,
        bool hardware,
        ILogger<H264Encoder> logger)
    {
        IMFActivate? activate = null;
        IMFTransform? transform = null;
        IMFDXGIDeviceManager? deviceManager = null;
        CodecApi? codec = null;

        // Held for the life of the encoder. Every Media Foundation object below depends on
        // the platform being running, and an encoder that outlived it would fail in ways
        // that look like driver faults.
        MediaFoundationPlatform platform = MediaFoundationPlatform.Acquire();

        try
        {
            int flags = MfGuids.EnumFlagSortAndFilter |
                        (hardware
                            ? MfGuids.EnumFlagHardware | MfGuids.EnumFlagAsyncMft
                            : MfGuids.EnumFlagSyncMft | MfGuids.EnumFlagAsyncMft);

            using IMFActivateCollection candidates = MediaFactory.MFTEnumEx(
                MfGuids.VideoEncoderCategory,
                (uint)flags,
                null,
                new RegisterTypeInfo { GuidMajorType = MfGuids.MajorTypeVideo, GuidSubtype = MfGuids.VideoFormatH264 });

            activate = candidates.FirstOrDefault();
            if (activate is null)
            {
                logger.LogDebug("No {Kind} H.264 encoder is registered.", hardware ? "hardware" : "software");
                return null;
            }
            string name = ReadFriendlyName(activate) ?? (hardware ? "hardware H.264 encoder" : "software H.264 encoder");
            transform = activate.ActivateObject<IMFTransform>();

            IMFAttributes attributes = transform.Attributes;
            bool isAsync = ReadFlag(attributes, MfGuids.TransformAsync);
            bool d3dAware = ReadFlag(attributes, MfGuids.SaD3D11Aware);

            if (isAsync)
            {
                // An async MFT arrives locked. Unlocking is what makes it legal to drive it
                // through the event model rather than the synchronous one.
                attributes.Set(MfGuids.TransformAsyncUnlock, 1u);
            }

            // Real-time streaming: tell the encoder to favour latency over compression
            // efficiency, which mostly means not holding frames back to look ahead.
            TrySet(() => attributes.Set(MfGuids.LowLatency, 1u));

            if (d3dAware)
            {
                deviceManager = MediaFactory.MFCreateDXGIDeviceManager();
                deviceManager.ResetDevice(device.Device).CheckError();
                transform.ProcessMessage(
                    TMessageType.MessageSetD3DManager,
                    unchecked((UIntPtr)(nuint)(nint)deviceManager.NativePointer));
            }
            else if (hardware)
            {
                // A "hardware" encoder that cannot take D3D surfaces would force a readback
                // per frame, which is the cost this whole pipeline exists to avoid.
                logger.LogDebug("The hardware encoder is not D3D11-aware; looking for another.");
                transform.Dispose();
                return null;
            }

            ConfigureTypes(transform, settings);

            // Rate control and GOP length are codec properties, not media type attributes,
            // and have to be set after the output type (which is what tells the encoder
            // which properties apply) and before streaming begins.
            codec = CodecApi.TryCreate(transform, logger);
            bool forcedKeyFrames = false;
            if (codec is not null)
            {
                codec.TrySet(MfGuids.AvEncCommonRateControlMode, MfGuids.RateControlModeCbr);
                codec.TrySet(MfGuids.AvEncCommonMeanBitRate, (uint)settings.BitrateBitsPerSecond);

                // Without this the GOP length is whatever the driver defaults to, which on
                // some drivers is one key frame every few seconds and on others one at the
                // start and never again.
                uint gop = (uint)Math.Max(1, settings.FrameRate * settings.KeyFrameIntervalSeconds);
                if (!codec.TrySet(MfGuids.AvEncMpvGopSize, gop))
                {
                    logger.LogDebug(
                        "The encoder kept its own key frame interval; {Seconds}s was not accepted.",
                        settings.KeyFrameIntervalSeconds);
                }

                forcedKeyFrames = codec.IsSupported(MfGuids.AvEncVideoForceKeyFrame);
            }

            byte[] parameterSets = ReadParameterSets(transform);
            OutputStreamInfo outputInfo = transform.GetOutputStreamInfo(0);
            bool providesSamples =
                (outputInfo.Flags & (MfGuids.OutputStreamProvidesSamples | MfGuids.OutputStreamCanProvideSamples)) != 0;

            transform.ProcessMessage(TMessageType.MessageNotifyBeginStreaming, UIntPtr.Zero);
            transform.ProcessMessage(TMessageType.MessageNotifyStartOfStream, UIntPtr.Zero);

            // Probed after streaming has begun, because that is the state the answer is
            // about: adaptive streaming changes the bitrate on an encoder that is already
            // running.
            bool bitrateChange = codec is not null &&
                CanChangeBitrateLive(codec, settings.BitrateBitsPerSecond);

            IMFMediaEventGenerator? events = isAsync
                ? transform.QueryInterface<IMFMediaEventGenerator>()
                : null;

            logger.LogInformation(
                "H.264 encoder ready: {Name} ({Kind}, {Model}) at {Width}x{Height}@{Fps} and {Bitrate} kbps; " +
                "forced key frames {KeyFrames}, live bitrate {Bitrate2}.",
                name,
                hardware ? "hardware" : "software",
                isAsync ? "async" : "sync",
                settings.Width,
                settings.Height,
                settings.FrameRate,
                settings.BitrateBitsPerSecond / 1000,
                forcedKeyFrames ? "supported" : "unsupported",
                bitrateChange ? "supported" : "unsupported");

            return new H264Encoder(
                platform,
                transform,
                events,
                deviceManager,
                codec,
                settings,
                hardware,
                name,
                providesSamples,
                Math.Max(outputInfo.Size, settings.Width * settings.Height),
                parameterSets,
                logger)
            {
                SupportsForcedKeyFrames = forcedKeyFrames,
                SupportsBitrateChange = bitrateChange,
            };
        }
        catch (Exception ex) when (ex is SharpGenException or InvalidOperationException or COMException)
        {
            logger.LogWarning(
                "Could not set up a {Kind} H.264 encoder: {Message}",
                hardware ? "hardware" : "software",
                ex.Message);

            codec?.Dispose();
            transform?.Dispose();
            deviceManager?.Dispose();
            platform.Dispose();
            return null;
        }
        finally
        {
            activate?.Dispose();
        }
    }

    /// <summary>
    /// Configure the encoder.
    ///
    /// Output type first, then input: an encoder cannot decide which input formats it
    /// accepts until it knows what it is being asked to produce, and setting them the other
    /// way round fails on most drivers.
    /// </summary>
    private static void ConfigureTypes(IMFTransform transform, EncoderSettings settings)
    {
        using IMFMediaType outputType = MediaFactory.MFCreateMediaType();
        outputType.Set(MfGuids.MtMajorType, MfGuids.MajorTypeVideo);
        outputType.Set(MfGuids.MtSubtype, MfGuids.VideoFormatH264);
        outputType.Set(MfGuids.MtAvgBitrate, (uint)settings.BitrateBitsPerSecond);
        outputType.Set(MfGuids.MtFrameSize, MfGuids.PackSize(settings.Width, settings.Height));
        outputType.Set(MfGuids.MtFrameRate, MfGuids.PackRatio(settings.FrameRate, 1));
        outputType.Set(MfGuids.MtPixelAspectRatio, MfGuids.PackRatio(1, 1));
        outputType.Set(MfGuids.MtInterlaceMode, 2u); // Progressive.
        outputType.Set(MfGuids.MtMpeg2Profile, settings.Profile);
        transform.SetOutputType(0, outputType, 0);

        using IMFMediaType inputType = MediaFactory.MFCreateMediaType();
        inputType.Set(MfGuids.MtMajorType, MfGuids.MajorTypeVideo);
        inputType.Set(MfGuids.MtSubtype, MfGuids.VideoFormatNv12);
        inputType.Set(MfGuids.MtFrameSize, MfGuids.PackSize(settings.Width, settings.Height));
        inputType.Set(MfGuids.MtFrameRate, MfGuids.PackRatio(settings.FrameRate, 1));
        inputType.Set(MfGuids.MtPixelAspectRatio, MfGuids.PackRatio(1, 1));
        inputType.Set(MfGuids.MtInterlaceMode, 2u);
        transform.SetInputType(0, inputType, 0);
    }

    private static byte[] ReadParameterSets(IMFTransform transform)
    {
        try
        {
            using IMFMediaType current = transform.GetOutputCurrentType(0);
            return current.GetBlob(MfGuids.MtMpegSequenceHeader);
        }
        catch (Exception ex) when (ex is SharpGenException or COMException)
        {
            // Not every encoder publishes them before the first frame; they still arrive
            // in-band ahead of the first key frame.
            return Array.Empty<byte>();
        }
    }

    private static string? ReadFriendlyName(IMFActivate activate)
    {
        try
        {
            return activate.GetString(MfGuids.FriendlyName);
        }
        catch (Exception ex) when (ex is SharpGenException or COMException)
        {
            return null;
        }
    }

    private static bool ReadFlag(IMFAttributes attributes, Guid key)
    {
        try
        {
            return attributes.GetUInt32(key) != 0;
        }
        catch (Exception ex) when (ex is SharpGenException or COMException)
        {
            return false;
        }
    }

    /// <summary>
    /// Whether the bitrate can be changed on this encoder while it runs.
    ///
    /// Determined by doing it — setting the bitrate to the value it already has and reading
    /// it back — rather than by asking. NVIDIA's H.264 MFT reports the property as not
    /// modifiable and then accepts the change and honours it, so believing the report would
    /// switch adaptive bitrate off on hardware where it works. Writing the current value is
    /// a no-op to the stream, which is what makes it safe to use as a probe.
    /// </summary>
    private static bool CanChangeBitrateLive(CodecApi codec, int bitsPerSecond)
    {
        if (!codec.TrySet(MfGuids.AvEncCommonMeanBitRate, (uint)bitsPerSecond)) return false;

        uint? readback = codec.TryGet(MfGuids.AvEncCommonMeanBitRate);

        // An encoder that reports nothing back has still accepted the value; only a wrong
        // value proves it was discarded.
        return readback is null ||
               Math.Abs((long)readback.Value - bitsPerSecond) <= bitsPerSecond / 10;
    }

    private static void TrySet(Action action)
    {
        try
        {
            action();
        }
        catch (Exception ex) when (ex is SharpGenException or COMException)
        {
            // Optional settings; an encoder that refuses one still works.
        }
    }

    // -------------------------------------------------------------------------
    // Encoding
    // -------------------------------------------------------------------------

    /// <summary>
    /// Encode one NV12 texture, appending whatever the encoder produced.
    ///
    /// Output lags input on a hardware encoder — the first few calls typically return
    /// nothing while it fills its pipeline — so callers must not treat an empty result as a
    /// failure.
    /// </summary>
    public bool Encode(ID3D11Texture2D nv12, TimeSpan timestamp, List<EncodedVideoFrame> output)
    {
        lock (_gate)
        {
            if (_disposed) return false;

            try
            {
                if (IsAsync && !WaitForInputCredit(output))
                {
                    Interlocked.Increment(ref _framesDropped);
                    return false;
                }

                using IMFSample sample = CreateSample(nv12, timestamp);
                _transform.ProcessInput(0, sample, 0);
                Interlocked.Increment(ref _framesIn);

                if (IsAsync)
                {
                    PumpEvents(output, wait: false);
                }
                else
                {
                    DrainSynchronously(output);
                }

                return true;
            }
            catch (Exception ex) when (ex is SharpGenException or COMException)
            {
                _logger.LogError(ex, "The H.264 encoder failed on a frame.");
                return false;
            }
        }
    }

    /// <summary>Wait, briefly, until the encoder says it wants a frame.</summary>
    private bool WaitForInputCredit(List<EncodedVideoFrame> output)
    {
        if (_needInputCredits > 0)
        {
            _needInputCredits--;
            return true;
        }

        DateTime deadline = DateTime.UtcNow + InputDeadline;
        while (DateTime.UtcNow < deadline)
        {
            PumpEvents(output, wait: false);
            if (_needInputCredits > 0)
            {
                _needInputCredits--;
                return true;
            }

            Thread.Sleep(1);
        }

        _logger.LogDebug("The encoder did not ask for input within the deadline; dropping a frame.");
        return false;
    }

    /// <summary>Drain queued transform events, collecting any encoded frames.</summary>
    private void PumpEvents(List<EncodedVideoFrame> output, bool wait)
    {
        if (_events is null) return;

        while (true)
        {
            IMFMediaEvent? mediaEvent;
            try
            {
                mediaEvent = _events.GetEvent(wait ? 0 : MfGuids.EventFlagNoWait);
            }
            catch (SharpGenException ex) when (ex.ResultCode.Code == MfGuids.NoEvents)
            {
                return;
            }

            if (mediaEvent is null) return;

            using (mediaEvent)
            {
                switch ((int)mediaEvent.EventType)
                {
                    case MfGuids.TransformNeedInput:
                        _needInputCredits++;
                        break;

                    case MfGuids.TransformHaveOutput:
                        CollectOutput(output);
                        break;

                    case MfGuids.TransformDrainComplete:
                        return;

                    default:
                        break;
                }
            }

            wait = false;
        }
    }

    /// <summary>Pull outputs until a synchronous transform says it needs more input.</summary>
    private void DrainSynchronously(List<EncodedVideoFrame> output)
    {
        while (true)
        {
            if (!CollectOutput(output)) return;
        }
    }

    /// <summary>Take one encoded frame from the transform, if there is one.</summary>
    private bool CollectOutput(List<EncodedVideoFrame> output)
    {
        IMFSample? allocated = null;
        var buffers = new OutputDataBuffer[1];

        try
        {
            if (!_providesSamples)
            {
                // The encoder expects the caller to supply storage. Hardware encoders
                // normally allocate their own, so this is the software path.
                allocated = MediaFactory.MFCreateSample();
                using IMFMediaBuffer buffer = MediaFactory.MFCreateMemoryBuffer(_outputBufferSize);
                allocated.AddBuffer(buffer);
                buffers[0].Sample = allocated;
            }

            buffers[0].StreamID = 0;
            Result result = _transform.ProcessOutput(ProcessOutputFlags.None, 1, ref buffers[0], out _);

            if (result.Code == MfGuids.TransformNeedMoreInput)
            {
                return false;
            }

            if (result.Code == MfGuids.TransformStreamChange)
            {
                // The encoder wants to renegotiate. Left unhandled it would emit frames a
                // decoder cannot read, so it is reported rather than ignored.
                _logger.LogWarning("The encoder requested an output format change mid-stream.");
                return false;
            }

            result.CheckError();

            IMFSample? sample = buffers[0].Sample;
            if (sample is null) return false;

            try
            {
                output.Add(ReadSample(sample));
                Interlocked.Increment(ref _framesOut);
                return true;
            }
            finally
            {
                if (!ReferenceEquals(sample, allocated))
                {
                    sample.Dispose();
                }

                buffers[0].Events?.Dispose();
            }
        }
        catch (SharpGenException ex) when (ex.ResultCode.Code == MfGuids.TransformNeedMoreInput)
        {
            return false;
        }
        finally
        {
            allocated?.Dispose();
        }
    }

    private static EncodedVideoFrame ReadSample(IMFSample sample)
    {
        using IMFMediaBuffer buffer = sample.ConvertToContiguousBuffer();

        buffer.Lock(out IntPtr pointer, out _, out int currentLength);
        try
        {
            var data = new byte[currentLength];
            Marshal.Copy(pointer, data, 0, currentLength);

            bool keyFrame;
            try
            {
                keyFrame = sample.GetUInt32(MfGuids.SampleCleanPoint) != 0;
            }
            catch (Exception ex) when (ex is SharpGenException or COMException)
            {
                keyFrame = false;
            }

            return new EncodedVideoFrame(
                data,
                TimeSpan.FromTicks(sample.SampleTime),
                TimeSpan.FromTicks(sample.SampleDuration),
                keyFrame);
        }
        finally
        {
            buffer.Unlock();
        }
    }

    private IMFSample CreateSample(ID3D11Texture2D texture, TimeSpan timestamp)
    {
        IMFSample sample = MediaFactory.MFCreateSample();
        IMFMediaBuffer buffer = MediaFactory.MFCreateDXGISurfaceBuffer(
            new Guid("6F15AAF2-D208-4E89-9AB4-489535D34F9C"),
            texture,
            0,
            false);

        try
        {
            // A DXGI buffer starts with a zero length; the encoder skips a sample whose
            // length is zero, so this has to be set from the surface itself.
            using IMF2DBuffer buffer2D = buffer.QueryInterface<IMF2DBuffer>();
            buffer.CurrentLength = buffer2D.ContiguousLength;
        }
        catch (Exception ex) when (ex is SharpGenException or COMException)
        {
            buffer.CurrentLength = _settings.Width * _settings.Height * 3 / 2;
        }

        sample.AddBuffer(buffer);
        buffer.Dispose();

        sample.SampleTime = timestamp.Ticks;
        sample.SampleDuration = TimeSpan.FromSeconds(1.0 / _settings.FrameRate).Ticks;
        return sample;
    }

    /// <summary>
    /// Ask for a key frame on the next encoded picture.
    ///
    /// Used when a client joins or reports loss it cannot conceal. Key frames are large, so
    /// this is a request rather than something the pipeline does on a timer.
    ///
    /// Returns whether the encoder accepted the request. A caller that assumed success
    /// would leave a joining client staring at an undecodable stream while believing it had
    /// already fixed the problem.
    /// </summary>
    public bool RequestKeyFrame()
    {
        lock (_gate)
        {
            if (_disposed || _codec is null) return false;
            return _codec.TrySet(MfGuids.AvEncVideoForceKeyFrame, 1u);
        }
    }

    /// <summary>Change the target bitrate on a running encoder, if the driver allows it.</summary>
    public bool TrySetBitrate(int bitsPerSecond)
    {
        lock (_gate)
        {
            if (_disposed) return false;

            // Some encoders only accept a bitrate at configuration time. The caller falls
            // back to changing resolution or frame rate instead, so a refusal has to be
            // reported rather than swallowed.
            return _codec is not null && _codec.TrySet(MfGuids.AvEncCommonMeanBitRate, (uint)bitsPerSecond);
        }
    }

    /// <summary>
    /// The bitrate the encoder says it is configured for, or null when it will not say.
    ///
    /// Read back from the encoder rather than remembered from the last call, because the
    /// question worth answering is whether the setting arrived — a value stored in a
    /// property nothing reads looks identical to one that took effect.
    /// </summary>
    public int? ConfiguredBitrate()
    {
        lock (_gate)
        {
            if (_disposed || _codec is null) return null;
            uint? value = _codec.TryGet(MfGuids.AvEncCommonMeanBitRate);
            return value is null ? null : (int)Math.Min(value.Value, int.MaxValue);
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
        }

        try
        {
            _transform.ProcessMessage(TMessageType.MessageNotifyEndOfStream, UIntPtr.Zero);
            _transform.ProcessMessage(TMessageType.MessageNotifyEndStreaming, UIntPtr.Zero);
        }
        catch (Exception ex) when (ex is SharpGenException or COMException)
        {
            // Already torn down.
        }

        _codec?.Dispose();
        _events?.Dispose();
        _transform.Dispose();
        _deviceManager?.Dispose();
        _platform.Dispose();

        _logger.LogDebug(
            "Encoder released after {In} frames in, {Out} out, {Dropped} dropped.",
            Interlocked.Read(ref _framesIn),
            Interlocked.Read(ref _framesOut),
            Interlocked.Read(ref _framesDropped));
    }
}
