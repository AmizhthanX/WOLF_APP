using Microsoft.Extensions.Logging;
using SharpGen.Runtime;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.MediaFoundation;
using Wolf.Agent.SessionHost.Capture;
using Wolf.Agent.SessionHost.Encoding;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Which Direct3D surfaces this machine's H.264 encoder will actually accept.
///
/// Encoder drivers are particular about how the texture they are handed was created, and
/// they express displeasure as `MF_E_UNSUPPORTED_D3D_TYPE` at the first frame — an error
/// that says nothing about which attribute was wrong. Rather than guessing, this measures:
/// it feeds the encoder one frame per candidate configuration and reports what each one
/// returned.
///
/// It stays in the suite because the answer is hardware-specific. A machine where the
/// pipeline mysteriously produces no frames is diagnosed by running this and reading the
/// table.
/// </summary>
[Collection("Capture")]
public sealed class EncoderSurfaceCompatibilityTests
{
    private readonly ITestOutputHelper _output;

    public EncoderSurfaceCompatibilityTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private sealed record Candidate(string Name, BindFlags Bind, ResourceOptionFlags Misc);

    private static readonly Candidate[] Candidates =
    {
        new("render-target", BindFlags.RenderTarget, ResourceOptionFlags.None),
        new("video-encoder", BindFlags.VideoEncoder, ResourceOptionFlags.None),
        new("render-target + video-encoder", BindFlags.RenderTarget | BindFlags.VideoEncoder, ResourceOptionFlags.None),
        new("render-target + shared", BindFlags.RenderTarget, ResourceOptionFlags.Shared),
        new("none", BindFlags.None, ResourceOptionFlags.None),
    };

    [Fact]
    public void The_encoder_accepts_at_least_one_surface_configuration()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        if (device is null)
        {
            _output.WriteLine("No Direct3D device in this environment; skipping.");
            return;
        }

        const int width = 1280;
        const int height = 720;

        var accepted = new List<string>();

        foreach (Candidate candidate in Candidates)
        {
            string outcome = Probe(device, candidate, width, height, loggers);
            _output.WriteLine($"{candidate.Name,-32} {outcome}");
            if (outcome == "accepted") accepted.Add(candidate.Name);
        }

        Assert.NotEmpty(accepted);
        _output.WriteLine("accepted: " + string.Join(", ", accepted));
    }

    private static string Probe(
        CaptureDevice device,
        Candidate candidate,
        int width,
        int height,
        XunitLoggerFactory loggers)
    {
        ID3D11Texture2D? texture = null;
        H264Encoder? encoder = null;

        try
        {
            texture = device.Device.CreateTexture2D(new Texture2DDescription
            {
                Width = (uint)width,
                Height = (uint)height,
                MipLevels = 1,
                ArraySize = 1,
                Format = Format.NV12,
                SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Default,
                BindFlags = candidate.Bind,
                CPUAccessFlags = CpuAccessFlags.None,
                MiscFlags = candidate.Misc,
            });
        }
        catch (SharpGenException ex)
        {
            return $"texture rejected: {ex.ResultCode}";
        }

        try
        {
            encoder = H264Encoder.TryCreate(
                device,
                new EncoderSettings(width, height, 30, 4_000_000),
                loggers.CreateLogger<H264Encoder>());

            if (encoder is null) return "no encoder";

            var frames = new List<EncodedVideoFrame>();
            bool accepted = encoder.Encode(texture, TimeSpan.Zero, frames);
            return accepted ? "accepted" : "rejected";
        }
        finally
        {
            encoder?.Dispose();
            texture?.Dispose();
        }
    }
}
