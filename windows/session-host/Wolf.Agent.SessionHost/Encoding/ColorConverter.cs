using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Vortice;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Wolf.Agent.SessionHost.Capture;

namespace Wolf.Agent.SessionHost.Encoding;

/// <summary>
/// Converts captured BGRA frames into the NV12 the H.264 encoder wants.
///
/// This step exists because the two ends of the pipeline disagree: Windows Graphics Capture
/// produces BGRA, and every hardware H.264 encoder consumes NV12. Something has to convert,
/// and doing it on the GPU through the video processor keeps the frame where it already is.
/// The alternative — reading the frame back to system memory, converting on the CPU, and
/// uploading it again — costs roughly 11 MB of round trip per 1440p frame, which at 60 fps
/// is most of a core and a lot of memory bandwidth spent achieving nothing.
///
/// The output texture is reused. At 60 fps, allocating a fresh one each frame would hand the
/// garbage collector megabytes a second of work for no benefit; the encoder consumes each
/// frame before the next conversion overwrites it.
///
/// It also scales. The video processor is already reading every pixel to convert it, so
/// producing a smaller output costs essentially nothing extra — and it is a far better
/// scaler than anything that could be written here, because it is the fixed-function block
/// the display pipeline uses. That makes resolution the third lever adaptation can pull,
/// after bitrate and frame rate.
/// </summary>
[SupportedOSPlatform("windows10.0.19041.0")]
public sealed class ColorConverter : IDisposable
{
    private readonly CaptureDevice _device;
    private readonly ILogger<ColorConverter> _logger;
    private readonly ID3D11VideoDevice _videoDevice;
    private readonly ID3D11VideoContext _videoContext;
    private readonly ID3D11VideoProcessor _processor;
    private readonly ID3D11VideoProcessorEnumerator _enumerator;
    private readonly ID3D11Texture2D _output;
    private readonly ID3D11VideoProcessorOutputView _outputView;
    private readonly object _gate = new();
    private bool _disposed;

    private ColorConverter(
        CaptureDevice device,
        ID3D11VideoDevice videoDevice,
        ID3D11VideoContext videoContext,
        ID3D11VideoProcessorEnumerator enumerator,
        ID3D11VideoProcessor processor,
        ID3D11Texture2D output,
        ID3D11VideoProcessorOutputView outputView,
        int sourceWidth,
        int sourceHeight,
        int width,
        int height,
        ILogger<ColorConverter> logger)
    {
        _device = device;
        _videoDevice = videoDevice;
        _videoContext = videoContext;
        _enumerator = enumerator;
        _processor = processor;
        _output = output;
        _outputView = outputView;
        SourceWidth = sourceWidth;
        SourceHeight = sourceHeight;
        Width = width;
        Height = height;
        _logger = logger;
    }

    /// <summary>Size of the captured frames coming in.</summary>
    public int SourceWidth { get; }

    public int SourceHeight { get; }

    /// <summary>Size of the NV12 frames going out, which is what gets encoded.</summary>
    public int Width { get; }

    public int Height { get; }

    /// <summary>True when frames are being scaled rather than passed through at size.</summary>
    public bool IsScaling => Width != SourceWidth || Height != SourceHeight;

    /// <summary>The NV12 texture the encoder reads. Overwritten by each conversion.</summary>
    public ID3D11Texture2D Output => _output;

    /// <summary>
    /// Build a converter that reads frames of one size and writes NV12 of another.
    ///
    /// Pass the same size twice for no scaling. Returns null when the GPU has no video
    /// processor able to produce NV12 at this size, which the caller reports as an encoder
    /// problem rather than crashing: a machine without it simply cannot stream, and should
    /// say so.
    /// </summary>
    public static ColorConverter? TryCreate(
        CaptureDevice device,
        int sourceWidth,
        int sourceHeight,
        int width,
        int height,
        int frameRate,
        ILogger<ColorConverter> logger)
    {
        ID3D11VideoDevice? videoDevice = null;
        ID3D11VideoContext? videoContext = null;
        ID3D11VideoProcessorEnumerator? enumerator = null;
        ID3D11VideoProcessor? processor = null;
        ID3D11Texture2D? output = null;
        ID3D11VideoProcessorOutputView? outputView = null;

        try
        {
            videoDevice = device.Device.QueryInterface<ID3D11VideoDevice>();
            videoContext = device.Context.QueryInterface<ID3D11VideoContext>();

            var description = new VideoProcessorContentDescription
            {
                InputFrameFormat = VideoFrameFormat.Progressive,
                InputWidth = (uint)sourceWidth,
                InputHeight = (uint)sourceHeight,
                OutputWidth = (uint)width,
                OutputHeight = (uint)height,
                InputFrameRate = new Rational((uint)frameRate, 1u),
                OutputFrameRate = new Rational((uint)frameRate, 1u),
                // Real-time streaming, not offline transcoding: prefer speed over quality
                // when the driver has to choose.
                Usage = VideoUsage.PlaybackNormal,
            };

            enumerator = videoDevice.CreateVideoProcessorEnumerator(description);
            processor = videoDevice.CreateVideoProcessor(enumerator, 0);

            output = device.Device.CreateTexture2D(new Texture2DDescription
            {
                Width = (uint)width,
                Height = (uint)height,
                MipLevels = 1,
                ArraySize = 1,
                Format = Format.NV12,
                SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Default,
                // The encoder reads this texture directly, so it must be bindable as a
                // video encoder resource; without the flag the MFT refuses the sample.
                BindFlags = BindFlags.RenderTarget,
                CPUAccessFlags = CpuAccessFlags.None,
                MiscFlags = ResourceOptionFlags.None,
            });

            outputView = videoDevice.CreateVideoProcessorOutputView(
                output,
                enumerator,
                new VideoProcessorOutputViewDescription { ViewDimension = VideoProcessorOutputViewDimension.Texture2D });

            // Full-range RGB in, studio-range YUV out is what H.264 expects by default;
            // getting this wrong produces a washed-out or crushed picture rather than an
            // error, which is exactly the kind of bug nobody notices until a screenshot.
            videoContext.VideoProcessorSetStreamColorSpace(
                processor,
                0,
                new VideoProcessorColorSpace { Usage = 0, RGB_Range = 0, YCbCr_Matrix = 1, Nominal_Range = 2 });
            videoContext.VideoProcessorSetOutputColorSpace(
                processor,
                new VideoProcessorColorSpace { Usage = 0, RGB_Range = 0, YCbCr_Matrix = 1, Nominal_Range = 1 });

            // Let the driver skip deinterlacing and film-cadence work that progressive
            // desktop content never needs.
            videoContext.VideoProcessorSetStreamAutoProcessingMode(processor, 0, false);

            // Stated rather than left to the driver's default. Some drivers letterbox an
            // output that does not match the input aspect ratio, and a black border baked
            // into the encoded frame is not something the far end can undo.
            videoContext.VideoProcessorSetStreamSourceRect(
                processor, 0, true, new RawRect(0, 0, sourceWidth, sourceHeight));
            videoContext.VideoProcessorSetStreamDestRect(
                processor, 0, true, new RawRect(0, 0, width, height));

            if (sourceWidth != width || sourceHeight != height)
            {
                logger.LogInformation(
                    "Colour conversion ready: BGRA {SourceWidth}x{SourceHeight} scaled to NV12 {Width}x{Height}.",
                    sourceWidth,
                    sourceHeight,
                    width,
                    height);
            }
            else
            {
                logger.LogInformation("Colour conversion ready: BGRA to NV12 at {Width}x{Height}.", width, height);
            }

            return new ColorConverter(
                device,
                videoDevice,
                videoContext,
                enumerator,
                processor,
                output,
                outputView,
                sourceWidth,
                sourceHeight,
                width,
                height,
                logger);
        }
        catch (Exception ex) when (ex is SharpGen.Runtime.SharpGenException or InvalidOperationException)
        {
            logger.LogError(ex, "This GPU cannot convert captured frames to NV12 for encoding.");

            outputView?.Dispose();
            output?.Dispose();
            processor?.Dispose();
            enumerator?.Dispose();
            videoContext?.Dispose();
            videoDevice?.Dispose();
            return null;
        }
    }

    /// <summary>
    /// Convert one captured frame. The result is <see cref="Output"/>, valid until the next
    /// call.
    /// </summary>
    public bool Convert(ID3D11Texture2D source)
    {
        lock (_gate)
        {
            if (_disposed) return false;

            ID3D11VideoProcessorInputView? inputView = null;
            try
            {
                // The input view is per-texture, and capture hands back a different texture
                // each frame, so this one cannot be cached the way the output view can.
                inputView = _videoDevice.CreateVideoProcessorInputView(
                    source,
                    _enumerator,
                    new VideoProcessorInputViewDescription
                    {
                        FourCC = 0,
                        ViewDimension = VideoProcessorInputViewDimension.Texture2D,
                    });

                var stream = new VideoProcessorStream
                {
                    Enable = true,
                    OutputIndex = 0,
                    InputFrameOrField = 0,
                    PastFrames = 0,
                    FutureFrames = 0,
                    InputSurface = inputView,
                };

                _videoContext.VideoProcessorBlt(_processor, _outputView, 0, new[] { stream }).CheckError();
                return true;
            }
            catch (SharpGen.Runtime.SharpGenException ex)
            {
                _logger.LogError(ex, "Colour conversion failed for a captured frame.");
                return false;
            }
            finally
            {
                inputView?.Dispose();
            }
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
        }

        _outputView.Dispose();
        _output.Dispose();
        _processor.Dispose();
        _enumerator.Dispose();
        _videoContext.Dispose();
        _videoDevice.Dispose();
        _ = _device;
    }
}
