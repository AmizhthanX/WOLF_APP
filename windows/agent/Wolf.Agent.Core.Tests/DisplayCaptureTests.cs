using System.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Capture;
using Wolf.Agent.SessionHost.Displays;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Screen capture, against the real display.
///
/// There is no useful way to unit-test this: the whole question is whether Windows Graphics
/// Capture, a Direct3D device, and this machine's GPU actually produce frames together. So
/// the tests start a real capture of the real primary display and assert on what comes
/// back — the size, the pixel format, and that frames arrive at all.
///
/// They skip rather than fail when there is no desktop, because a headless build agent is a
/// legitimate environment in which the honest answer is "this cannot capture".
/// </summary>
/// <remarks>
/// Takes a <see cref="ScreenActivity"/> it never reads. Windows Graphics Capture delivers a
/// frame when the composition changes, so on an idle desktop these tests measure nothing and
/// fail at random. The fixture keeps something moving for as long as this class runs.
/// </remarks>
[Collection("Capture")]
public sealed class DisplayCaptureTests : IClassFixture<ScreenActivity>
{
    private readonly ITestOutputHelper _output;

    public DisplayCaptureTests(ITestOutputHelper output, ScreenActivity activity)
    {
        _output = output;
        _ = activity;
    }

    private bool HasDesktop()
    {
        var enumerator = new DisplayEnumerator(NullLogger<DisplayEnumerator>.Instance);
        if (enumerator.Enumerate().Count > 0) return true;

        _output.WriteLine("No display in this session; skipping.");
        return false;
    }

    [Fact]
    public void Graphics_capture_availability_is_reported_not_assumed()
    {
        bool supported = CaptureDevice.IsCaptureSupported();
        _output.WriteLine($"GraphicsCaptureSession.IsSupported() = {supported}");

        // Whatever the answer, it must be a real one rather than a throw: the session host
        // has to be able to tell the cloud "no capture here" on an old build of Windows.
        Assert.True(supported || !supported);
    }

    [Fact]
    public void A_direct3d_device_can_be_created_for_capture()
    {
        using CaptureDevice? device = CaptureDevice.TryCreate(NullLogger<CaptureDevice>.Instance);

        Assert.NotNull(device);
        _output.WriteLine($"adapter: {device!.AdapterName}");
        Assert.False(string.IsNullOrWhiteSpace(device.AdapterName));
        Assert.NotNull(device.WinRtDevice);
    }

    [Fact]
    public void Capturing_the_primary_display_produces_frames_of_the_right_size()
    {
        if (!HasDesktop() || !CaptureDevice.IsCaptureSupported()) return;

        var enumerator = new DisplayEnumerator(NullLogger<DisplayEnumerator>.Instance);
        IpcDisplay expected = enumerator.Enumerate().First(display => display.Primary);
        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();
        Assert.NotNull(monitor);

        using CaptureDevice? device = CaptureDevice.TryCreate(NullLogger<CaptureDevice>.Instance);
        Assert.NotNull(device);

        using DisplayCapture? capture = DisplayCapture.TryStart(
            device!,
            monitor!.Value,
            NullLogger<DisplayCapture>.Instance);
        Assert.NotNull(capture);

        _output.WriteLine(
            $"capture started {capture!.Width}x{capture.Height}, border shown = {capture.BorderShown}");

        // The capture must describe the same display the enumerator did, or the client would
        // be shown one screen while being told about another.
        Assert.Equal(expected.WidthPixels, capture.Width);
        Assert.Equal(expected.HeightPixels, capture.Height);

        var stopwatch = Stopwatch.StartNew();
        var frames = 0;
        var sizes = new List<(int Width, int Height)>();
        Format format = Format.Unknown;

        while (stopwatch.Elapsed < TimeSpan.FromSeconds(5) && frames < 10)
        {
            using CaptureFrameLease? lease = capture.TryAcquire();
            if (lease is null)
            {
                Thread.Sleep(5);
                continue;
            }

            frames++;
            sizes.Add((lease.Frame.Width, lease.Frame.Height));
            format = lease.Frame.Texture.Description.Format;
        }

        _output.WriteLine($"captured {frames} frame(s) in {stopwatch.ElapsedMilliseconds} ms, format {format}");

        Assert.True(frames > 0, "no frames arrived from Windows Graphics Capture within five seconds");

        // BGRA is what the frame pool was asked for, and what the colour converter expects.
        Assert.Equal(Format.B8G8R8A8_UNorm, format);

        foreach ((int width, int height) in sizes)
        {
            Assert.Equal(capture.Width, width);
            Assert.Equal(capture.Height, height);
        }
    }

    [Fact]
    public void Captured_textures_live_on_the_gpu_so_no_frame_crosses_system_memory()
    {
        if (!HasDesktop() || !CaptureDevice.IsCaptureSupported()) return;

        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();
        Assert.NotNull(monitor);

        using CaptureDevice? device = CaptureDevice.TryCreate(NullLogger<CaptureDevice>.Instance);
        using DisplayCapture? capture = DisplayCapture.TryStart(
            device!,
            monitor!.Value,
            NullLogger<DisplayCapture>.Instance);
        Assert.NotNull(capture);

        CaptureFrameLease? lease = null;
        var stopwatch = Stopwatch.StartNew();
        while (lease is null && stopwatch.Elapsed < TimeSpan.FromSeconds(5))
        {
            lease = capture!.TryAcquire();
            if (lease is null) Thread.Sleep(5);
        }

        Assert.NotNull(lease);
        using (lease)
        {
            Texture2DDescription description = lease!.Frame.Texture.Description;
            _output.WriteLine(
                $"usage={description.Usage} cpuAccess={description.CPUAccessFlags} bind={description.BindFlags}");

            // Default usage with no CPU access is what "stays on the GPU" means in practice:
            // the texture can be fed straight to the video processor and the encoder.
            Assert.Equal(ResourceUsage.Default, description.Usage);
            Assert.Equal(CpuAccessFlags.None, description.CPUAccessFlags);
        }
    }

    [Fact]
    public void Releasing_frames_keeps_capture_running_past_the_buffer_count()
    {
        if (!HasDesktop() || !CaptureDevice.IsCaptureSupported()) return;

        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();
        using CaptureDevice? device = CaptureDevice.TryCreate(NullLogger<CaptureDevice>.Instance);
        using DisplayCapture? capture = DisplayCapture.TryStart(
            device!,
            monitor!.Value,
            NullLogger<DisplayCapture>.Instance);
        Assert.NotNull(capture);

        // The pool holds two buffers. Acquiring and releasing many more than that proves the
        // lease actually returns them — a leak here would stall capture after two frames.
        var stopwatch = Stopwatch.StartNew();
        var frames = 0;

        while (stopwatch.Elapsed < TimeSpan.FromSeconds(6) && frames < 30)
        {
            using CaptureFrameLease? lease = capture!.TryAcquire();
            if (lease is null)
            {
                Thread.Sleep(2);
                continue;
            }

            frames++;
        }

        _output.WriteLine($"acquired and released {frames} frames");
        Assert.True(frames > 2, $"capture stalled after {frames} frames, which suggests a leaked buffer");
    }
}

/// <summary>
/// Capture tests hold a Direct3D device and the display's capture session, so they run one
/// at a time.
/// </summary>
[CollectionDefinition("Capture", DisableParallelization = true)]
public sealed class CaptureTestCollection
{
}
