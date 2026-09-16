using Microsoft.Extensions.Logging;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.Mathematics;
using Wolf.Agent.SessionHost.Capture;
using Wolf.Agent.SessionHost.Encoding;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// A desktop that stops changing, on the real GPU and the real encoder.
///
/// Graphics Capture delivers a frame only when something on screen changes, so a real desktop
/// cannot be made to stand still on demand — which is how this went unseen until an Android
/// emulator on a lossy link watched an idle PC and received no picture for as long as it stayed
/// idle. The capture here hands over one real picture and then nothing, which is exactly what an
/// idle desktop is.
/// </summary>
[Collection("Capture")]
public sealed class StillDesktopTests
{
    private readonly ITestOutputHelper _output;

    public StillDesktopTests(ITestOutputHelper output)
    {
        _output = output;
    }

    /// <summary>One picture, then nothing ever again.</summary>
    private sealed class StillCapture : IDisplayCapture
    {
        private readonly ID3D11Texture2D _texture;
        private int _handedOver;

        public StillCapture(ID3D11Texture2D texture, int width, int height)
        {
            _texture = texture;
            Width = width;
            Height = height;
        }

        public int Width { get; }

        public int Height { get; }

        public bool Closed => false;

        public bool BorderShown => false;

        public bool CursorCaptured => false;

        public string Api => "still-desktop-test";

        public int Acquired => Volatile.Read(ref _handedOver);

        public CaptureFrameLease? TryAcquire()
        {
            if (Interlocked.Exchange(ref _handedOver, 1) == 1) return null;
            return new CaptureFrameLease(new CapturedFrame(_texture, Width, Height, TimeSpan.Zero));
        }

        public void Dispose()
        {
        }
    }

    [Fact]
    public void A_still_desktop_delivers_its_picture_goes_quiet_and_still_answers_a_key_frame_request()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        if (device is null)
        {
            _output.WriteLine("No Direct3D device in this environment; skipping.");
            return;
        }

        const int width = 1920;
        const int height = 1080;

        using ID3D11Texture2D texture = device.Device.CreateTexture2D(new Texture2DDescription
        {
            Width = width,
            Height = height,
            MipLevels = 1,
            ArraySize = 1,
            Format = Format.B8G8R8A8_UNorm,
            SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Default,
            BindFlags = BindFlags.RenderTarget | BindFlags.ShaderResource,
            CPUAccessFlags = CpuAccessFlags.None,
            MiscFlags = ResourceOptionFlags.None,
        });

        // A picture with something in it: a converter handed an empty texture proves nothing.
        using (ID3D11RenderTargetView view = device.Device.CreateRenderTargetView(texture))
        {
            device.Context.ClearRenderTargetView(view, new Color4(0.1f, 0.4f, 0.7f, 1f));
        }

        var capture = new StillCapture(texture, width, height);
        var received = new List<EncodedVideoFrame>();

        using CapturePipeline? pipeline = CapturePipeline.TryCreate(
            device,
            capture,
            30,
            4_000_000,
            frame =>
            {
                lock (received) received.Add(frame);
            },
            loggers);
        Assert.NotNull(pipeline);
        pipeline!.Start();

        // 1. The one picture comes out, although nothing else is ever captured.
        bool delivered = WaitFor(() => Count(received) > 0, TimeSpan.FromSeconds(2));
        _output.WriteLine(
            $"{pipeline.EncoderName} (hardware={pipeline.HardwareEncoded}): captured {pipeline.Stats().FramesCaptured}, " +
            $"repeated {pipeline.FramesRepeated}, delivered {Count(received)}");
        Assert.True(delivered, "the still desktop's one picture never came out of the encoder");
        Assert.Equal(1, capture.Acquired);

        // 2. Once it is out, a desktop that stays still costs nothing more.
        Thread.Sleep(TimeSpan.FromMilliseconds(700));
        int settled = Count(received);
        long repeatsSettled = pipeline.FramesRepeated;
        Thread.Sleep(TimeSpan.FromSeconds(1));
        Assert.Equal(settled, Count(received));
        Assert.Equal(repeatsSettled, pipeline.FramesRepeated);
        _output.WriteLine($"quiet: {settled} frames and {repeatsSettled} repeats before and after a second of stillness");

        // 3. A key frame asked for on the still desktop arrives, carried by the same picture.
        if (!pipeline.SupportsForcedKeyFrames)
        {
            _output.WriteLine("This encoder does not force key frames on request; nothing more to check.");
            return;
        }

        Assert.True(pipeline.RequestKeyFrame(), "the encoder refused a key frame request");
        bool keyFrame = WaitFor(
            () =>
            {
                lock (received) return received.Skip(settled).Any(frame => frame.IsKeyFrame);
            },
            TimeSpan.FromSeconds(1));
        _output.WriteLine(
            $"after the request: {Count(received) - settled} frames, key frame {(keyFrame ? "arrived" : "missing")}, " +
            $"{pipeline.FramesRepeated - repeatsSettled} repeats; still only {capture.Acquired} capture");
        Assert.True(keyFrame, "a key frame asked for on a still desktop never came");
        Assert.Equal(1, capture.Acquired);
    }

    private static int Count(List<EncodedVideoFrame> frames)
    {
        lock (frames) return frames.Count;
    }

    private static bool WaitFor(Func<bool> condition, TimeSpan timeout)
    {
        DateTime deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return true;
            Thread.Sleep(10);
        }

        return condition();
    }
}
